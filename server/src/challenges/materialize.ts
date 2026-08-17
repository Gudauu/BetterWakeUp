/**
 * Writing a challenge, its weekly schedule, and its full task set.
 *
 * One function, used by both doors. `POST /challenges` calls it for a zero
 * deposit challenge inside the request that created it; the payment webhook
 * calls it for a funded one once the provider confirms the authorization. There
 * is no second materializer, which is what makes the task count invariant hold
 * immediately after activation on either path rather than on whichever one was
 * written first.
 *
 * The database is what actually holds that invariant: the deferred constraint
 * trigger from issue 7 counts the tasks at commit, so a challenge and its tasks
 * have to arrive in one transaction. That is why this takes a transaction
 * rather than a database handle, and why nothing here commits.
 *
 * The transaction opens by locking the account row, which is the lock account
 * deletion takes and the lock the funding path was told to respect. It is what
 * makes the one-challenge check and the insert atomic against a concurrent
 * deletion or a concurrent creation, rather than a read whose answer another
 * command can invalidate before the insert lands.
 */

import type { ChallengeConfiguration } from "@betterwakeup/contract";
import { and, eq, inArray } from "drizzle-orm";

import { challengeScheduleDays, challenges, scheduledTasks } from "../db/schema/challenges.ts";
import { accounts } from "../db/schema/identity.ts";
import { AppError } from "../errors/app-error.ts";
import type { Transaction } from "../idempotency/service.ts";
import type { ChallengePlan } from "./plan.ts";

/** The challenge statuses that hold an account's one challenge slot. */
const OPEN_CHALLENGE_STATUSES = ["active", "recovery_pending"] as const;

/** PostgreSQL's unique violation, which the partial index raises. */
const UNIQUE_VIOLATION = "23505";

const ACTIVE_CHALLENGE_EXISTS =
  "This account already has a challenge running. It has to succeed, fail, or expire before another one starts.";

export interface MaterializeChallengeCommand {
  readonly accountId: string;
  readonly configuration: ChallengeConfiguration;
  readonly policyVersion: string;
  /** The tasks and the projection, both derived from the configuration at once. */
  readonly plan: ChallengePlan;
  /**
   * When the challenge became active. For a zero deposit challenge this is the
   * instant of the request; for a funded one it is the instant the provider's
   * confirmation was processed, because that is when the challenge starts
   * running and there is nothing before it to run.
   */
  readonly activatedAt: Date;
}

/**
 * Takes the account lock, refusing an account that does not exist.
 *
 * Every path that decides whether a challenge may start takes this same lock
 * first, which is what makes their decisions mutually exclusive rather than
 * merely each correct in isolation.
 */
export async function lockAccount(tx: Transaction, accountId: string): Promise<void> {
  const locked = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .for("update")
    .limit(1);
  if (locked.length === 0) {
    throw new AppError("not_found", "No account with this identifier.");
  }
}

/** Whether the account holds a challenge that occupies its one slot. */
export async function hasOpenChallenge(tx: Transaction, accountId: string): Promise<boolean> {
  const open = await tx
    .select({ id: challenges.id })
    .from(challenges)
    .where(
      and(
        eq(challenges.accountId, accountId),
        inArray(challenges.status, [...OPEN_CHALLENGE_STATUSES]),
      ),
    )
    .limit(1);
  return open.length > 0;
}

/**
 * Takes the account lock and refuses if the account already holds a challenge.
 *
 * The two halves are also exported separately, because the webhook has
 * something other than a refusal to do when the answer is yes: a provider that
 * confirmed a hold cannot be told to try again later.
 */
export async function lockAccountAndAssertNoOpenChallenge(
  tx: Transaction,
  accountId: string,
): Promise<void> {
  await lockAccount(tx, accountId);
  if (await hasOpenChallenge(tx, accountId)) {
    throw new AppError("active_challenge_exists", ACTIVE_CHALLENGE_EXISTS);
  }
}

/**
 * Writes the challenge and everything under it, returning its identifier.
 *
 * The caller is responsible for having taken the account lock, which both
 * callers do through `lockAccountAndAssertNoOpenChallenge`: the webhook has a
 * decision to make between the lock and the insert (whether the intent it is
 * answering was already settled) and so cannot have the two folded together.
 */
export async function materializeChallenge(
  tx: Transaction,
  command: MaterializeChallengeCommand,
): Promise<string> {
  const { configuration } = command;
  const [inserted] = await tx
    .insert(challenges)
    .values({
      accountId: command.accountId,
      status: "active",
      requiredTaskCount: configuration.requiredTaskCount,
      stepTarget: configuration.stepTarget,
      noRegretMinutes: configuration.noRegretMinutes,
      timeZone: configuration.timeZone,
      depositMinorUnits: configuration.deposit.amount,
      depositCurrency: configuration.deposit.currency,
      policyVersion: command.policyVersion,
      projectedEndDate: command.plan.projection.projectedEndDate,
      activatedAt: command.activatedAt,
    })
    .returning({ id: challenges.id })
    .catch(rethrowDuplicate);
  if (inserted === undefined) {
    throw new AppError("internal_error", "the challenge insert returned no row");
  }

  await tx.insert(challengeScheduleDays).values(
    configuration.schedule.map((day) => ({
      challengeId: inserted.id,
      weekday: day.weekday,
      deadlineLocal: `${day.deadline}:00`,
    })),
  );

  await tx.insert(scheduledTasks).values(
    command.plan.tasks.map((task) => ({
      challengeId: inserted.id,
      sequence: task.sequence,
      taskDate: task.date,
      deadline: task.deadline,
      pauseCutoff: task.pauseCutoff,
      status: "scheduled" as const,
    })),
  );

  return inserted.id;
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
      throw new AppError("active_challenge_exists", ACTIVE_CHALLENGE_EXISTS, { cause: error });
    }
  }
  throw error;
}
