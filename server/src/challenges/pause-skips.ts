/**
 * Consuming tasks while the pause mode is set.
 *
 * Pause is a mode on the challenge, not an action on a task, so nothing is
 * skipped when the user pauses. Each task is consumed as its own pause cutoff
 * passes, and each consumption is one transaction that moves the task to
 * `skipped` and appends one replacement `scheduled` task. Splitting those two
 * statements across transactions is not an option: the active challenge's task
 * count is a deferred constraint trigger, so a skip with no replacement fails
 * at commit. The invariant is what forces the shape.
 *
 * Two callers share this. The sweep drives it in the ordinary case, one task at
 * a time as cutoffs pass. Resume drives it for the tasks whose cutoffs passed
 * while the mode was set and the sweep had not yet reached them, because the
 * user's pause was in force at each of those instants and a resume must not
 * hand back a task the pause had already spent. That is the whole of "leaving
 * pause binds at the cutoff boundary".
 *
 * The window a pause consumes is `(pausedAt, now]`:
 *
 * - Strictly after `pausedAt`, because a pause set at or after a task's cutoff
 *   leaves that task live. The user did not get their No Regret notice, so they
 *   keep the task.
 * - At or before `now`, because a cutoff still ahead has not passed yet and the
 *   user may still resume before it does.
 */

import { and, asc, eq, gt, isNotNull, lte } from "drizzle-orm";

import { challenges, scheduledTasks } from "../db/schema/challenges.ts";
import { AppError } from "../errors/app-error.ts";
import type { Transaction } from "../idempotency/service.ts";
import type { ScheduleConfiguration } from "../schedule/engine.ts";
import { appendReplacementTask } from "./replacement-task.ts";
import { loadWeeklySchedule } from "./weekly-schedule.ts";

type TaskRow = typeof scheduledTasks.$inferSelect;

/**
 * A ceiling on how many tasks one call will consume.
 *
 * Each skip appends a replacement on a later date, so a replacement can itself
 * have a cutoff in the past when a pause outlasted many task windows, and the
 * loop has to run until the challenge's next task is genuinely ahead of `now`.
 * A challenge is expired after a year of pause and the densest schedule is
 * daily, so a legitimate catch-up is bounded by roughly a year's worth of
 * tasks. Anything past that is a bug, and this is here so that one does not
 * present as a hung Lambda.
 */
const MAXIMUM_SKIPS_PER_CALL = 400;

/** What one pause skip did: the task it consumed and the task it appended. */
export interface PauseSkip {
  readonly skipped: TaskRow;
  readonly appended: TaskRow;
}

/**
 * The challenge fields the skip needs, read under a row lock.
 *
 * A challenge that is not `active`, or not paused, has nothing to consume:
 * both answers are "no", not an error, because the sweep reaches challenges it
 * does not own and a challenge can change underneath a pass.
 */
interface PausedChallenge {
  readonly id: string;
  readonly pausedAt: Date;
  readonly configuration: ScheduleConfiguration;
}

/**
 * Consumes every task whose cutoff has passed while the pause was in force.
 *
 * Runs inside the caller's transaction, which is what makes each skip and its
 * replacement atomic. Returns the skips in the order they were applied, which
 * is task order.
 */
export async function skipTasksConsumedByPause(
  tx: Transaction,
  challengeId: string,
  now: Date,
): Promise<PauseSkip[]> {
  const challenge = await lockPausedChallenge(tx, challengeId);
  if (challenge === null) return [];

  const skips: PauseSkip[] = [];
  for (let pass = 0; pass < MAXIMUM_SKIPS_PER_CALL; pass += 1) {
    const due = await nextDueTask(tx, challenge, now);
    if (due === undefined) return skips;
    skips.push(await consume(tx, challenge, due, now));
  }
  throw new AppError(
    "internal_error",
    `challenge ${challengeId} still owes pause skips after ${MAXIMUM_SKIPS_PER_CALL} of them`,
  );
}

/**
 * The challenge, locked, or null when it has no pause to act on.
 *
 * The lock is the same one the completion path takes on a task: it makes this
 * and a second writer over the same challenge mutually exclusive rather than
 * each correct alone. The sweep and a resume arriving at the same instant are
 * exactly that pair.
 */
async function lockPausedChallenge(
  tx: Transaction,
  challengeId: string,
): Promise<PausedChallenge | null> {
  const [row] = await tx
    .select({
      id: challenges.id,
      status: challenges.status,
      pausedAt: challenges.pausedAt,
      requiredTaskCount: challenges.requiredTaskCount,
      noRegretMinutes: challenges.noRegretMinutes,
      timeZone: challenges.timeZone,
    })
    .from(challenges)
    .where(and(eq(challenges.id, challengeId), isNotNull(challenges.pausedAt)))
    .for("update")
    .limit(1);

  if (row?.pausedAt == null || row.status !== "active") return null;

  return {
    id: row.id,
    pausedAt: row.pausedAt,
    configuration: {
      requiredTaskCount: row.requiredTaskCount,
      noRegretMinutes: row.noRegretMinutes,
      timeZone: row.timeZone,
      schedule: await loadWeeklySchedule(tx, challengeId),
    },
  };
}

/** The earliest open task the pause has already consumed, locked. */
async function nextDueTask(
  tx: Transaction,
  challenge: PausedChallenge,
  now: Date,
): Promise<TaskRow | undefined> {
  const [due] = await tx
    .select()
    .from(scheduledTasks)
    .where(
      and(
        eq(scheduledTasks.challengeId, challenge.id),
        eq(scheduledTasks.status, "scheduled"),
        gt(scheduledTasks.pauseCutoff, challenge.pausedAt),
        lte(scheduledTasks.pauseCutoff, now),
      ),
    )
    .orderBy(asc(scheduledTasks.sequence))
    .for("update")
    .limit(1);
  return due;
}

/**
 * One task consumed and its replacement appended, in the caller's transaction.
 *
 * The append is `replacement-task.ts`, shared with Emergency Recovery: both
 * consume a task without ending the challenge, so both owe it the same
 * replacement and the same moved projection.
 */
async function consume(
  tx: Transaction,
  challenge: PausedChallenge,
  task: TaskRow,
  now: Date,
): Promise<PauseSkip> {
  const [skipped] = await tx
    .update(scheduledTasks)
    .set({ status: "skipped", skippedAt: now, updatedAt: now })
    // The status is in the predicate as well as in the read above, so this
    // cannot resolve a task another writer resolved first even if the row lock
    // were ever relaxed.
    .where(and(eq(scheduledTasks.id, task.id), eq(scheduledTasks.status, "scheduled")))
    .returning();
  if (skipped === undefined) {
    throw new AppError("internal_error", "the pause skip matched no open task");
  }

  const appended = await appendReplacementTask(tx, challenge.id, challenge.configuration, now);
  return { skipped, appended };
}
