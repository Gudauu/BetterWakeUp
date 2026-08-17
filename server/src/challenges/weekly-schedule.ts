/**
 * Reading a challenge's stored weekly schedule back as the engine's shape.
 *
 * Two commands derive task instants from a stored challenge: a pause skip,
 * which appends a replacement task, and a time zone change, which moves the
 * instants of tasks already placed. Both need the same thing, and both would
 * otherwise repeat the one detail that is easy to get wrong: the deadline
 * column is a `time`, so it reads back with the seconds the contract's local
 * time format does not carry.
 */

import type { WeeklySchedule } from "@betterwakeup/contract";
import { eq } from "drizzle-orm";

import { challengeScheduleDays } from "../db/schema/challenges.ts";
import { AppError } from "../errors/app-error.ts";
import type { Transaction } from "../idempotency/service.ts";

/**
 * The challenge's active weekdays and their local deadlines.
 *
 * A challenge with no schedule day is not a state any path produces, so it is
 * our bug rather than the caller's and is reported as one.
 */
export async function loadWeeklySchedule(
  tx: Transaction,
  challengeId: string,
): Promise<WeeklySchedule> {
  const days = await tx
    .select({
      weekday: challengeScheduleDays.weekday,
      deadlineLocal: challengeScheduleDays.deadlineLocal,
    })
    .from(challengeScheduleDays)
    .where(eq(challengeScheduleDays.challengeId, challengeId));

  if (days.length === 0) {
    throw new AppError("internal_error", `challenge ${challengeId} has no weekly schedule`);
  }
  return days.map((day) => ({ weekday: day.weekday, deadline: day.deadlineLocal.slice(0, 5) }));
}
