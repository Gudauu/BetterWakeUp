/**
 * Steps 1 to 5 of the sweep: the tasks whose deadline and receipt grace have
 * both passed with nothing acknowledged.
 *
 * One task is resolved per transaction, and resolving it moves its challenge
 * out of `active` in the same transaction. That pairing is not a style choice:
 * while a challenge is `active` the number of `scheduled` or `completed` tasks
 * must equal its required count, and a miss drops it below. The deferred
 * trigger would reject a commit that marked a task missed and left the
 * challenge running.
 *
 * It also explains why the pass is one task per challenge rather than all of
 * them. After the first miss the challenge is `recovery_pending` or `failed`,
 * so its remaining tasks are no longer evaluated at all: the challenge already
 * has an outcome, and the user either recovers the one task that ended it or
 * does not.
 *
 * Three rules decide which task is taken, and each one is a separate refusal to
 * act rather than a variation on the same one:
 *
 * - **The receipt grace has to have passed.** The completion command accepts a
 *   request up to the deadline plus sixty seconds, so a task is overdue only
 *   past that instant. Anything earlier would race a completion that is still
 *   allowed to arrive.
 * - **No completion may be in flight.** An attempt that crashed between
 *   claiming its idempotency key and committing leaves the key `in_progress`
 *   with a live lease. If it was claimed inside the receipt window, the command
 *   arrived in time and its retry is still entitled to succeed, so the task is
 *   left alone until the attempt resolves or the lease runs out.
 * - **Nobody else may hold the row.** Both the challenge and the task are taken
 *   with `for update skip locked`, so two invocations take disjoint work and
 *   neither ever waits. Waiting is what would let this deadlock against the
 *   completion command, which locks a task and then updates its challenge while
 *   this locks a challenge and then its task.
 *
 * Step 5 creates a settlement command and never executes one. Its
 * `execute_after` is what the recovery window is made of: immediate for a
 * failed challenge, the end of the window for one that can still be recovered.
 */

import { RECEIPT_GRACE_SECONDS, RECOVERY_WINDOW_HOURS } from "@betterwakeup/contract";
import { and, asc, eq, gt, lt, lte, notExists, notInArray, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { challenges, scheduledTasks } from "../db/schema/challenges.ts";
import { accounts } from "../db/schema/identity.ts";
import { idempotencyKeys } from "../db/schema/payments.ts";
import { AppError } from "../errors/app-error.ts";
import type { Transaction } from "../idempotency/service.ts";
import { createSettlementCommand } from "./payment-commands.ts";

/** The command type whose in-flight key protects a task. Set by the completion path. */
const COMPLETION_COMMAND_TYPE = "createCompletion";

const HOUR_MS = 60 * 60 * 1000;

export interface OverduePassResult {
  readonly tasksMissed: number;
  readonly challengesFailed: number;
  readonly challengesInRecovery: number;
  readonly settlementsCreated: number;
  /** True when the pass stopped on its ceiling rather than on running out. */
  readonly moreWorkPending: boolean;
}

export interface OverduePassOptions {
  readonly db: Database;
  readonly now: Date;
  /** How many tasks one pass will resolve. */
  readonly batchSize: number;
  /**
   * Tasks whose row or whose challenge another writer held, accumulated across
   * the whole invocation.
   *
   * A candidate is chosen before either lock is attempted, so a locked row has
   * to be remembered: without this the pass would choose the same task again
   * on the next iteration and spin until it hit its ceiling.
   */
  readonly passedOver: Set<string>;
}

export async function runOverduePass(options: OverduePassOptions): Promise<OverduePassResult> {
  let missed = 0;
  let failed = 0;
  let recovery = 0;
  let settlements = 0;

  for (let taken = 0; taken < options.batchSize; taken += 1) {
    const resolved = await options.db.transaction(async (tx) => await resolveOne(tx, options));
    if (resolved === "drained") {
      return {
        tasksMissed: missed,
        challengesFailed: failed,
        challengesInRecovery: recovery,
        settlementsCreated: settlements,
        moreWorkPending: false,
      };
    }
    if (resolved === "passed_over") continue;
    missed += 1;
    if (resolved.status === "failed") failed += 1;
    else recovery += 1;
    if (resolved.settlementCreated) settlements += 1;
  }

  return {
    tasksMissed: missed,
    challengesFailed: failed,
    challengesInRecovery: recovery,
    settlementsCreated: settlements,
    moreWorkPending: true,
  };
}

interface Resolution {
  readonly challengeId: string;
  readonly status: "failed" | "recovery_pending";
  readonly settlementCreated: boolean;
}

/**
 * One overdue task, or a reason nothing was done.
 *
 * `drained` means the query found no candidate at all and the pass is over.
 * `passed_over` means a candidate existed but somebody else holds it, which is
 * a reason to look at the next one rather than to stop.
 */
async function resolveOne(
  tx: Transaction,
  options: OverduePassOptions,
): Promise<Resolution | "drained" | "passed_over"> {
  const candidate = await nextOverdueTask(tx, options);
  if (candidate === undefined) return "drained";

  // The challenge is locked first and the task second, one ordering for every
  // writer in the sweep. Neither lock waits, so a task the completion command
  // holds is passed over rather than fought for.
  const challenge = await lockChallenge(tx, candidate.challengeId);
  if (challenge === undefined) {
    options.passedOver.add(candidate.taskId);
    return "passed_over";
  }
  const task = await lockTask(tx, candidate.taskId, options.now);
  if (task === undefined) {
    options.passedOver.add(candidate.taskId);
    return "passed_over";
  }

  await markMissed(tx, task.taskId, options.now);
  return await resolveChallenge(tx, challenge, options.now);
}

interface Candidate {
  readonly taskId: string;
  readonly challengeId: string;
}

/**
 * The earliest overdue task nothing is standing in the way of.
 *
 * Ordered by deadline so a backlog is cleared oldest first, which is what makes
 * the order the sweep resolves things in independent of how the rows happen to
 * be stored.
 */
async function nextOverdueTask(
  tx: Transaction,
  options: OverduePassOptions,
): Promise<Candidate | undefined> {
  const [row] = await tx
    .select({ taskId: scheduledTasks.id, challengeId: challenges.id })
    .from(scheduledTasks)
    .innerJoin(challenges, eq(challenges.id, scheduledTasks.challengeId))
    .where(
      and(
        eq(scheduledTasks.status, "scheduled"),
        eq(challenges.status, "active"),
        lt(scheduledTasks.deadline, latestAcceptableReceipt(options.now)),
        noCompletionInFlight(options.now),
        ...(options.passedOver.size === 0
          ? []
          : [notInArray(scheduledTasks.id, [...options.passedOver])]),
      ),
    )
    .orderBy(asc(scheduledTasks.deadline))
    .limit(1);
  return row;
}

/**
 * The bound a task's deadline must be strictly below to be overdue now.
 *
 * Strictly, because the completion command accepts a request received at
 * exactly the deadline plus the grace. A task is overdue only past the last
 * instant a completion for it could still have been acknowledged, and the two
 * rules have to agree on that instant to the millisecond or one of them is
 * wrong about the same request.
 *
 * Written as a bound on the deadline rather than as `deadline + grace < now`
 * so the comparison stays on the indexed column.
 */
function latestAcceptableReceipt(now: Date): Date {
  return new Date(now.getTime() - RECEIPT_GRACE_SECONDS * 1000);
}

/**
 * An unresolved completion key claimed inside this task's receipt window.
 *
 * Both halves matter. The lease has to still be live, or a crashed attempt
 * would protect its task forever. And the key has to have been claimed no later
 * than the deadline plus the grace, because a key claimed after that stands for
 * a command the completion path would have refused anyway.
 */
function noCompletionInFlight(now: Date) {
  return notExists(
    sql`(select 1 from ${idempotencyKeys} where ${and(
      eq(idempotencyKeys.subjectId, scheduledTasks.id),
      eq(idempotencyKeys.commandType, COMPLETION_COMMAND_TYPE),
      eq(idempotencyKeys.status, "in_progress"),
      gt(idempotencyKeys.leaseExpiresAt, now),
      lte(
        idempotencyKeys.createdAt,
        sql`${scheduledTasks.deadline} + ${sql.raw(`interval '${RECEIPT_GRACE_SECONDS} seconds'`)}`,
      ),
    )} limit 1)`,
  );
}

/** The challenge fields the outcome turns on, or undefined if somebody holds it. */
interface LockedChallenge {
  readonly id: string;
  readonly depositMinorUnits: number;
  /** Null while the account still holds its lifetime Emergency Recovery. */
  readonly recoveryConsumedAt: Date | null;
}

async function lockChallenge(
  tx: Transaction,
  challengeId: string,
): Promise<LockedChallenge | undefined> {
  const [row] = await tx
    .select({
      id: challenges.id,
      depositMinorUnits: challenges.depositMinorUnits,
      recoveryConsumedAt: accounts.emergencyRecoveryConsumedAt,
    })
    .from(challenges)
    .innerJoin(accounts, eq(accounts.id, challenges.accountId))
    .where(and(eq(challenges.id, challengeId), eq(challenges.status, "active")))
    // Only the challenge is locked. The account is read for its recovery flag,
    // and locking it would put every one of an account's challenges behind one
    // lock for no rule that needs it.
    .for("update", { of: challenges, skipLocked: true })
    .limit(1);
  return row;
}

/**
 * The task, re-read under its own lock.
 *
 * The candidate query ran without a lock, so everything it established has to
 * be established again here: the task may have been completed, skipped, or
 * taken by another invocation between the two statements.
 */
async function lockTask(
  tx: Transaction,
  taskId: string,
  now: Date,
): Promise<{ taskId: string } | undefined> {
  const [row] = await tx
    .select({ taskId: scheduledTasks.id })
    .from(scheduledTasks)
    .where(
      and(
        eq(scheduledTasks.id, taskId),
        eq(scheduledTasks.status, "scheduled"),
        lt(scheduledTasks.deadline, latestAcceptableReceipt(now)),
        noCompletionInFlight(now),
      ),
    )
    .for("update", { skipLocked: true })
    .limit(1);
  return row;
}

async function markMissed(tx: Transaction, taskId: string, now: Date): Promise<void> {
  const [updated] = await tx
    .update(scheduledTasks)
    .set({ status: "missed", missedAt: now, updatedAt: now })
    .where(and(eq(scheduledTasks.id, taskId), eq(scheduledTasks.status, "scheduled")))
    .returning({ id: scheduledTasks.id });
  if (updated === undefined) {
    throw new AppError("internal_error", "the sweep's miss matched no open task");
  }
}

/**
 * Step 4 and step 5, which are one decision and its consequence.
 *
 * Recovery is offered only on a funded challenge whose account still holds its
 * lifetime allowance. A zero deposit challenge fails outright: the database
 * refuses `recovery_pending` without a deposit, because a lifetime allowance
 * must not be spendable on a challenge that costs nothing to fail.
 */
async function resolveChallenge(
  tx: Transaction,
  challenge: LockedChallenge,
  now: Date,
): Promise<Resolution> {
  const recoverable = challenge.depositMinorUnits > 0 && challenge.recoveryConsumedAt === null;
  const status = recoverable ? "recovery_pending" : "failed";

  const [updated] = await tx
    .update(challenges)
    .set({
      status,
      // `recovery_pending` is not terminal: the challenge can still come back.
      ...(status === "failed" ? { terminalAt: now } : {}),
      updatedAt: now,
    })
    .where(and(eq(challenges.id, challenge.id), eq(challenges.status, "active")))
    .returning({ id: challenges.id });
  if (updated === undefined) {
    throw new AppError("internal_error", "the sweep's challenge transition matched no active row");
  }

  // A zero deposit challenge has nothing to settle, so there is no command at
  // all rather than a command for zero.
  const settlementCreated =
    challenge.depositMinorUnits > 0 &&
    (await createSettlementCommand(tx, {
      challengeId: challenge.id,
      kind: "capture",
      executeAfter: recoverable ? new Date(now.getTime() + RECOVERY_WINDOW_HOURS * HOUR_MS) : now,
    }));

  return { challengeId: challenge.id, status, settlementCreated };
}
