/**
 * Emergency Recovery: the one commit that undoes a miss.
 *
 * A funded challenge whose task was missed does not fail immediately. The sweep
 * moves it to `recovery_pending` and creates a capture command that will not
 * execute until the recovery window closes, which is what makes the window a
 * real offer rather than a message about a decision already taken. This command
 * is the user accepting it, and everything it does happens in one transaction:
 *
 * - the account's lifetime allowance is consumed,
 * - the missed task becomes `forgiven`,
 * - a replacement `scheduled` task is appended so the challenge can still reach
 *   its required count,
 * - the pending capture is cancelled,
 * - and the challenge returns to `active`.
 *
 * Splitting any of those out is not available. The task count is a deferred
 * constraint trigger, so an `active` challenge missing its replacement fails at
 * commit; and a challenge returned to `active` with its capture still pending
 * would be captured by the settlement pass for a miss that no longer exists.
 *
 * The refusals are checked in a fixed order, from what is true about the caller
 * to what is true about this moment:
 *
 * 1. The challenge must exist and be the caller's, or it is `not_found`, the
 *    same answer an identifier naming nothing gets.
 * 2. The account must still hold its lifetime allowance. This is checked before
 *    the challenge's status so a user who spent their recovery on an earlier
 *    challenge is told that, rather than being told this challenge has no offer
 *    when the reason is the allowance and not the challenge.
 * 3. The challenge must be in `recovery_pending`. Nothing else stands an offer,
 *    which is also why a zero deposit challenge can never be recovered: the
 *    database refuses `recovery_pending` without a deposit, so a failed zero
 *    deposit challenge is `failed` and answered here as offering nothing.
 * 4. The body's task must be the task the offer was opened for, so a stale
 *    offer the app is still showing cannot be accepted against a later miss.
 * 5. The window must still be open, and the settlement must still be pending.
 *    Those are two readings of the same instant and both are enforced: the
 *    clock says whether the user is in time, and the capture command's status
 *    says whether the money has already moved.
 *
 * The account row is locked before the challenge row. That is the order
 * challenge creation and the funding intent already take, and taking it here
 * too is what keeps two commands over one account from deadlocking. The
 * account lock is also what makes the lifetime allowance a real one under
 * concurrency: two recoveries on two challenges are ordered by it rather than
 * both reading an unspent flag.
 */

import { type AcceptRecoveryResponse, RECOVERY_WINDOW_HOURS } from "@betterwakeup/contract";
import { and, desc, eq } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { challenges, scheduledTasks } from "../db/schema/challenges.ts";
import { accounts } from "../db/schema/identity.ts";
import { paymentCommands } from "../db/schema/payments.ts";
import { AppError } from "../errors/app-error.ts";
import { runIdempotent, type Transaction } from "../idempotency/service.ts";
import type { ScheduleConfiguration } from "../schedule/engine.ts";
import { loadChallengeView, taskViewOf } from "./challenge-view.ts";
import { appendReplacementTask } from "./replacement-task.ts";
import { loadWeeklySchedule } from "./weekly-schedule.ts";

const HOUR_MS = 60 * 60 * 1000;

export interface AcceptRecoveryDependencies {
  readonly db: Database;
  /** The clock the recovery window is judged against. A test states the moment. */
  readonly now?: (() => Date) | undefined;
}

export interface AcceptRecoveryCommand {
  readonly accountId: string;
  readonly challengeId: string;
  readonly idempotencyKey: string;
  /** The missed task the app is showing the offer for. */
  readonly taskId: string;
}

export async function acceptRecovery(
  deps: AcceptRecoveryDependencies,
  command: AcceptRecoveryCommand,
): Promise<{ response: AcceptRecoveryResponse; replayed: boolean }> {
  const at = (deps.now ?? (() => new Date()))();

  const outcome = await runIdempotent(
    deps.db,
    {
      accountId: command.accountId,
      key: command.idempotencyKey,
      commandType: "acceptRecovery",
      // The task is part of the request's identity: the same key replayed
      // against a different task is a different command, not a retry.
      request: { challengeId: command.challengeId, taskId: command.taskId },
    },
    async (tx) => await consumeRecovery(tx, command, at),
  );
  return { response: outcome.result, replayed: outcome.replayed };
}

async function consumeRecovery(
  tx: Transaction,
  command: AcceptRecoveryCommand,
  at: Date,
): Promise<AcceptRecoveryResponse> {
  await lockUnspentAllowance(tx, command.accountId);
  const challenge = await lockOfferingChallenge(tx, command);
  const missed = await assertOfferedTask(tx, challenge.id, command.taskId, at);
  await cancelPendingCapture(tx, challenge.id, at);

  await tx
    .update(accounts)
    .set({ emergencyRecoveryConsumedAt: at, updatedAt: at })
    .where(eq(accounts.id, command.accountId));

  const forgiven = await forgive(tx, missed.id, at);
  const appended = await appendReplacementTask(tx, challenge.id, challenge.configuration, at);

  await tx
    .update(challenges)
    .set({ status: "active", updatedAt: at })
    .where(eq(challenges.id, challenge.id));

  return {
    challenge: await loadChallengeView(tx, challenge.id),
    forgivenTask: taskViewOf(forgiven),
    appendedTask: taskViewOf(appended),
  };
}

/**
 * The account row, locked, refusing an allowance that is already spent.
 *
 * The lock is taken whether or not the allowance turns out to be available,
 * because it is what orders this command against another recovery on another
 * challenge: without it both would read an unspent flag and the trigger on
 * `emergency_recovery_consumed_at` would surface the loser as a 500 rather than
 * as the refusal it is.
 */
async function lockUnspentAllowance(tx: Transaction, accountId: string): Promise<void> {
  const [account] = await tx
    .select({ consumedAt: accounts.emergencyRecoveryConsumedAt })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .for("update")
    .limit(1);

  if (account === undefined) {
    throw new AppError("not_found", "No account with this identifier.");
  }
  if (account.consumedAt !== null) {
    throw new AppError(
      "recovery_already_consumed",
      "Emergency Recovery can be used once per account, and this account has used it.",
    );
  }
}

/** The challenge fields the commit needs, read under a row lock. */
interface OfferingChallenge {
  readonly id: string;
  readonly configuration: ScheduleConfiguration;
}

/**
 * The challenge, locked, refusing anything that is not standing an offer.
 *
 * The account is part of the predicate even though the session gate has already
 * proved ownership: a row that has gone since is answered the same way an
 * unknown one is.
 */
async function lockOfferingChallenge(
  tx: Transaction,
  command: AcceptRecoveryCommand,
): Promise<OfferingChallenge> {
  const [row] = await tx
    .select({
      id: challenges.id,
      status: challenges.status,
      requiredTaskCount: challenges.requiredTaskCount,
      noRegretMinutes: challenges.noRegretMinutes,
      timeZone: challenges.timeZone,
    })
    .from(challenges)
    .where(and(eq(challenges.id, command.challengeId), eq(challenges.accountId, command.accountId)))
    .for("update")
    .limit(1);

  if (row === undefined) {
    throw new AppError("not_found", "No challenge with this identifier.");
  }
  if (row.status !== "recovery_pending") {
    throw new AppError(
      "recovery_not_offered",
      `This challenge is ${row.status}, so no Emergency Recovery is offered for it.`,
    );
  }

  return {
    id: row.id,
    configuration: {
      requiredTaskCount: row.requiredTaskCount,
      noRegretMinutes: row.noRegretMinutes,
      timeZone: row.timeZone,
      schedule: await loadWeeklySchedule(tx, row.id),
    },
  };
}

type TaskRow = typeof scheduledTasks.$inferSelect;

/**
 * The missed task the offer stands for, refusing any other and refusing a
 * window that has closed.
 *
 * The offer belongs to the latest miss, which is the same rule the challenge
 * view renders the offer from, so the app cannot be shown one task and have
 * another accepted. A request naming an earlier miss is a stale screen rather
 * than a second offer.
 *
 * The window closes at the missed instant plus the recovery window, inclusive:
 * a request arriving at exactly that instant is in time, and the settlement it
 * races is not eligible for execution before it. One instant, one rule, on the
 * same side of the boundary as every other deadline in the product.
 */
async function assertOfferedTask(
  tx: Transaction,
  challengeId: string,
  taskId: string,
  at: Date,
): Promise<TaskRow> {
  const [latest] = await tx
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.challengeId, challengeId), eq(scheduledTasks.status, "missed")))
    .orderBy(desc(scheduledTasks.sequence))
    .for("update")
    .limit(1);

  if (latest?.missedAt == null) {
    throw new AppError(
      "internal_error",
      `challenge ${challengeId} awaits Emergency Recovery with no missed task to forgive`,
    );
  }
  if (latest.id !== taskId) {
    throw new AppError(
      "recovery_not_offered",
      "The Emergency Recovery offer is for a different task than this request names.",
    );
  }
  if (at.getTime() > latest.missedAt.getTime() + RECOVERY_WINDOW_HOURS * HOUR_MS) {
    throw new AppError(
      "recovery_window_closed",
      "The Emergency Recovery window for this task has closed.",
    );
  }
  return latest;
}

/**
 * The capture the miss created, cancelled.
 *
 * A funded challenge in `recovery_pending` always has one, because the sweep
 * creates it in the transaction that misses the task. So a capture that is no
 * longer pending means the settlement pass has already acted, and the money has
 * moved: that is refused as a closed window rather than reported as our bug,
 * because from the user's side it is exactly what a late request is.
 */
async function cancelPendingCapture(tx: Transaction, challengeId: string, at: Date): Promise<void> {
  const cancelled = await tx
    .update(paymentCommands)
    .set({ status: "cancelled", settledAt: at })
    .where(
      and(
        eq(paymentCommands.challengeId, challengeId),
        eq(paymentCommands.kind, "capture"),
        eq(paymentCommands.status, "pending"),
      ),
    )
    .returning({ id: paymentCommands.id });

  if (cancelled.length === 0) {
    throw new AppError(
      "recovery_window_closed",
      "This challenge's deposit has already been settled.",
    );
  }
}

async function forgive(tx: Transaction, taskId: string, at: Date): Promise<TaskRow> {
  const [forgiven] = await tx
    .update(scheduledTasks)
    // The `missed_at` the task carries is kept: a forgiven task is a miss that
    // was undone, and losing when it happened would lose the reason the
    // allowance was spent.
    .set({ status: "forgiven", forgivenAt: at, updatedAt: at })
    .where(and(eq(scheduledTasks.id, taskId), eq(scheduledTasks.status, "missed")))
    .returning();
  if (forgiven === undefined) {
    throw new AppError("internal_error", "the recovery's forgiveness matched no missed task");
  }
  return forgiven;
}
