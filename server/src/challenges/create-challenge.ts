/**
 * Creating a zero deposit challenge.
 *
 * This is the seam the phased plan calls out. A zero deposit challenge never
 * reaches the payment provider, so it is created and materialized in one
 * transaction and is active the moment the command returns. Everything the
 * completion path, the pause path, and the sweep act on exists from here, and
 * none of it has to wait for money.
 *
 * The command refuses any non-zero deposit with `zero_deposit_required`, which
 * is not a stopgap: `POST /challenges` is the unfunded door for good. A funded
 * configuration has to go through `POST /challenges/funding-intents`, because
 * the challenge must not exist until the provider says the authorization
 * succeeded, and a path that could create a funded challenge without that
 * confirmation is a path that lets a user start a challenge nobody can be
 * charged for.
 *
 * The transaction opens by locking the account row, which is the same lock
 * account deletion takes. That is what makes the one-challenge check and the
 * insert atomic against a concurrent deletion or a concurrent funding, rather
 * than a read whose answer another command can invalidate before the insert.
 * The partial unique index is still the authority: the check produces the
 * useful message, the index is what makes a second open challenge impossible.
 */

import type { ChallengeConfiguration, CreateChallengeResponse } from "@betterwakeup/contract";
import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { challengeScheduleDays, challenges, scheduledTasks } from "../db/schema/challenges.ts";
import { accounts } from "../db/schema/identity.ts";
import { AppError } from "../errors/app-error.ts";
import { runIdempotent, type Transaction } from "../idempotency/service.ts";
import { loadChallengeView } from "./challenge-view.ts";
import { assertDepositAmount, planChallenge } from "./plan.ts";

/** The challenge statuses that hold an account's one challenge slot. */
const OPEN_CHALLENGE_STATUSES = ["active", "recovery_pending"] as const;

/** PostgreSQL's unique violation, which the partial index raises. */
const UNIQUE_VIOLATION = "23505";

export interface CreateChallengeDependencies {
  readonly db: Database;
  /** The clock the schedule is placed from. A test states the moment. */
  readonly now?: (() => Date) | undefined;
}

export interface CreateChallengeCommand {
  readonly accountId: string;
  readonly idempotencyKey: string;
  readonly configuration: ChallengeConfiguration;
  readonly policyVersion: string;
}

export async function createChallenge(
  deps: CreateChallengeDependencies,
  command: CreateChallengeCommand,
): Promise<{ response: CreateChallengeResponse; replayed: boolean }> {
  // Both refusals are decided before a key is spent. A doomed request should
  // not consume the caller's idempotency key, because the caller's fix is to
  // send a different request under a new one anyway.
  assertDepositAmount(command.configuration);
  if (command.configuration.deposit.amount !== 0) {
    throw new AppError(
      "zero_deposit_required",
      "This endpoint creates zero deposit challenges only. Fund a challenge through a funding intent.",
    );
  }

  const startingAt = (deps.now ?? (() => new Date()))();
  const plan = planChallenge(command.configuration, startingAt);

  const outcome = await runIdempotent(
    deps.db,
    {
      accountId: command.accountId,
      key: command.idempotencyKey,
      commandType: "createChallenge",
      request: { configuration: command.configuration, policyVersion: command.policyVersion },
    },
    async (tx) => await insertChallenge(tx, command, plan, startingAt),
  );

  return { response: outcome.result, replayed: outcome.replayed };
}

async function insertChallenge(
  tx: Transaction,
  command: CreateChallengeCommand,
  plan: ReturnType<typeof planChallenge>,
  startingAt: Date,
): Promise<CreateChallengeResponse> {
  const locked = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.id, command.accountId))
    .for("update")
    .limit(1);
  if (locked.length === 0) {
    throw new AppError("not_found", "No account with this identifier.");
  }

  const open = await tx
    .select({ id: challenges.id })
    .from(challenges)
    .where(
      and(
        eq(challenges.accountId, command.accountId),
        inArray(challenges.status, [...OPEN_CHALLENGE_STATUSES]),
      ),
    )
    .limit(1);
  if (open.length > 0) {
    throw new AppError(
      "active_challenge_exists",
      "This account already has a challenge running. It has to succeed, fail, or expire before another one starts.",
    );
  }

  const projection = plan.projection;
  const [inserted] = await tx
    .insert(challenges)
    .values({
      accountId: command.accountId,
      status: "active",
      requiredTaskCount: command.configuration.requiredTaskCount,
      stepTarget: command.configuration.stepTarget,
      noRegretMinutes: command.configuration.noRegretMinutes,
      timeZone: command.configuration.timeZone,
      depositMinorUnits: command.configuration.deposit.amount,
      depositCurrency: command.configuration.deposit.currency,
      policyVersion: command.policyVersion,
      projectedEndDate: projection.projectedEndDate,
      // A zero deposit challenge is active on creation: there is no
      // authorization to wait for, so the creating instant is the activating
      // instant.
      activatedAt: startingAt,
    })
    .returning({ id: challenges.id })
    .catch(rethrowDuplicate);
  if (inserted === undefined) {
    throw new AppError("internal_error", "the challenge insert returned no row");
  }

  await tx.insert(challengeScheduleDays).values(
    command.configuration.schedule.map((day) => ({
      challengeId: inserted.id,
      weekday: day.weekday,
      deadlineLocal: `${day.deadline}:00`,
    })),
  );

  await tx.insert(scheduledTasks).values(
    plan.tasks.map((task) => ({
      challengeId: inserted.id,
      sequence: task.sequence,
      taskDate: task.date,
      deadline: task.deadline,
      pauseCutoff: task.pauseCutoff,
      status: "scheduled" as const,
    })),
  );

  return { challenge: await loadChallengeView(tx, inserted.id) };
}

/**
 * The partial unique index, translated.
 *
 * The check above answers the ordinary case. This answers the case where two
 * creations for one account interleaved past it, which the account lock makes
 * unreachable today and which would otherwise surface as a 500 if that lock
 * were ever relaxed.
 */
function rethrowDuplicate(error: unknown): never {
  for (let cause: unknown = error; cause != null; cause = (cause as { cause?: unknown }).cause) {
    if ((cause as { code?: unknown }).code === UNIQUE_VIOLATION) {
      throw new AppError(
        "active_challenge_exists",
        "This account already has a challenge running. It has to succeed, fail, or expire before another one starts.",
        { cause: error },
      );
    }
  }
  throw error;
}
