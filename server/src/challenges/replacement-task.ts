/**
 * Appending the replacement task a consumed task owes the challenge.
 *
 * Two paths consume a task without ending the challenge: a pause skip, which
 * spends a task the user gave notice about, and Emergency Recovery, which
 * forgives a task the user missed. Both leave an `active` challenge one task
 * short of its required count, and the count is a deferred constraint trigger,
 * so both have to append a replacement in the same transaction. That makes the
 * append one operation with one implementation rather than a detail each caller
 * gets right separately.
 *
 * The replacement lands on the next scheduled date after the last date the
 * challenge holds a task on, which is what pushes the projected end date later
 * and what keeps the one-task-per-date index satisfiable. The challenge's
 * stored projection moves with it: a reader would otherwise be told the
 * challenge ends on a date it now has a task past.
 */

import { desc, eq } from "drizzle-orm";

import { challenges, scheduledTasks } from "../db/schema/challenges.ts";
import { AppError } from "../errors/app-error.ts";
import type { Transaction } from "../idempotency/service.ts";
import { appendTask, type ScheduleConfiguration } from "../schedule/engine.ts";

type TaskRow = typeof scheduledTasks.$inferSelect;

/**
 * Appends one `scheduled` task past the challenge's last date and moves the
 * challenge's projected end date onto it. Runs in the caller's transaction.
 */
export async function appendReplacementTask(
  tx: Transaction,
  challengeId: string,
  configuration: ScheduleConfiguration,
  now: Date,
): Promise<TaskRow> {
  const last = await lastTask(tx, challengeId);
  const replacement = appendTask(configuration, last.taskDate, last.sequence + 1);

  const [appended] = await tx
    .insert(scheduledTasks)
    .values({
      challengeId,
      sequence: replacement.sequence,
      taskDate: replacement.date,
      deadline: replacement.deadline,
      pauseCutoff: replacement.pauseCutoff,
      status: "scheduled",
    })
    .returning();
  if (appended === undefined) {
    throw new AppError("internal_error", "the replacement task insert returned no row");
  }

  await tx
    .update(challenges)
    .set({ projectedEndDate: replacement.date, updatedAt: now })
    .where(eq(challenges.id, challengeId));

  return appended;
}

/** The last task the challenge holds, by sequence, which is also by date. */
async function lastTask(
  tx: Transaction,
  challengeId: string,
): Promise<Pick<TaskRow, "sequence" | "taskDate">> {
  const [last] = await tx
    .select({ sequence: scheduledTasks.sequence, taskDate: scheduledTasks.taskDate })
    .from(scheduledTasks)
    .where(eq(scheduledTasks.challengeId, challengeId))
    .orderBy(desc(scheduledTasks.sequence))
    .limit(1);
  if (last === undefined) {
    throw new AppError("internal_error", `challenge ${challengeId} holds no task to append past`);
  }
  return last;
}
