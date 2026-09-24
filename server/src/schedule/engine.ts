/**
 * The time and schedule engine.
 *
 * Given a weekly schedule, a required task count, a No Regret duration, a time
 * zone, and the instant the challenge starts, this derives every task date, the
 * absolute instants each task is judged against, and the date the challenge
 * ends if nothing is ever paused. It reads no clock and touches no database:
 * every function takes the instant it should reason from, so a test states the
 * moment rather than arranging for it.
 *
 * Three rules are decided here, because nothing upstream states them and every
 * caller would otherwise have to invent them:
 *
 * - **Where the schedule starts.** The first task is the earliest scheduled
 *   date whose pause cutoff is strictly after the starting instant. Binding on
 *   the cutoff rather than the deadline is the same boundary pause and resume
 *   bind on: a task the user could not have paused is a task they were never
 *   given a chance to plan around, so a challenge created inside that window
 *   starts on the following one.
 * - **How the cutoff is measured.** The cutoff is the deadline instant minus
 *   the No Regret duration in real time, not in wall-clock time. Eight hours of
 *   notice means eight hours of notice on the day the clocks change too.
 * - **When a walk opens.** A walk opens the walk window before its deadline,
 *   in real time like the cutoff, so it can open on the date before its own.
 *   It never opens before the previous task's deadline, though: when two
 *   deadlines are closer together than the window, the later walk opens at the
 *   earlier one's deadline, so one walk cannot count for two mornings. And it
 *   never opens after its own deadline, which only a time zone change that
 *   reordered two deadlines could otherwise produce.
 * - **What a replacement task costs.** A task appended to replace a skipped or
 *   forgiven one lands on the next scheduled date strictly after the last task
 *   the challenge holds, which is what pushes the end date later and what keeps
 *   the one-task-per-date index satisfiable.
 */

import type { Weekday, WeeklySchedule } from "@betterwakeup/contract";
import { DateTime } from "luxon";

import { AppError } from "../errors/app-error.ts";
import { localDateOf, resolveLocalTime } from "./zoned-time.ts";

/** Luxon numbers weekdays 1 (Monday) through 7 (Sunday). */
const WEEKDAY_BY_LUXON_NUMBER: Readonly<Record<number, Weekday>> = {
  1: "monday",
  2: "tuesday",
  3: "wednesday",
  4: "thursday",
  5: "friday",
  6: "saturday",
  7: "sunday",
};

/**
 * A ceiling on how far the search for a scheduled date will walk.
 *
 * With at least one active weekday a scheduled date is never more than seven
 * days out, so this only ever fires on a bug. It exists so that one does not
 * present as a hung Lambda.
 */
const MAXIMUM_DAYS_BETWEEN_TASKS = 14;

/** The part of a challenge's configuration the engine needs. */
export interface ScheduleConfiguration {
  readonly requiredTaskCount: number;
  readonly schedule: WeeklySchedule;
  /** Minutes of advance notice required to pause a task. */
  readonly noRegretMinutes: number;
  /** Minutes before each deadline the walk opens. */
  readonly walkWindowMinutes: number;
  readonly timeZone: string;
}

/** One materialized task. */
export interface MaterializedTask {
  /** Position within the challenge, starting at 1. */
  readonly sequence: number;
  /** The calendar date in the challenge's zone, as `YYYY-MM-DD`. */
  readonly date: string;
  /** When the walk opens. Movement observed before it does not count. */
  readonly opensAt: Date;
  readonly deadline: Date;
  /** The deadline less the No Regret duration. Pausing at or after it is too late. */
  readonly pauseCutoff: Date;
}

/**
 * The full schedule for a challenge starting at `startingAt`.
 *
 * Returns exactly `requiredTaskCount` tasks, which is the count the database's
 * task-count invariant will hold the challenge to the moment it is activated.
 */
export function materializeSchedule(
  configuration: ScheduleConfiguration,
  startingAt: Date,
): MaterializedTask[] {
  const deadlines = deadlinesByWeekday(configuration.schedule);
  const first = firstTaskFrom(
    configuration,
    deadlines,
    localDateOf(startingAt, configuration.timeZone),
    startingAt,
  );
  const tasks: MaterializedTask[] = [first];

  // Every later task is placed by date alone. Its cutoff is necessarily later
  // than the first task's, which the eligibility test has already cleared.
  while (tasks.length < configuration.requiredTaskCount) {
    const previous = tasks[tasks.length - 1];
    if (previous === undefined) {
      throw new AppError("internal_error", "a schedule lost the task it just placed");
    }
    tasks.push(appendTask(configuration, previous, tasks.length + 1));
  }
  return tasks;
}

/**
 * The task appended when a skipped or forgiven task consumes a row.
 *
 * It lands on the next scheduled date strictly after `last`, which is the last
 * task the challenge holds, and opens no earlier than that task's deadline. There is no eligibility test
 * against an instant here: the replacement is always in the future relative to
 * the task it replaces, and holding it to a cutoff rule as well would let a
 * pause silently shorten a challenge.
 */
export function appendTask(
  configuration: ScheduleConfiguration,
  last: PreviousTask,
  sequence: number,
): MaterializedTask {
  const deadlines = deadlinesByWeekday(configuration.schedule);
  const date = nextScheduledDate(deadlines, nextDate(last.date));
  return taskOn(configuration, deadlines, date, sequence, last.deadline);
}

/** The task before the one being placed: its date, and the deadline it closes at. */
export interface PreviousTask {
  readonly date: string;
  readonly deadline: Date;
}

/**
 * The date the challenge ends if nothing is ever paused.
 *
 * This is the last task's date, and it is what the maximum duration rule is
 * checked against and what the disclosure screen shows.
 */
export function projectEndDate(configuration: ScheduleConfiguration, startingAt: Date): string {
  const tasks = materializeSchedule(configuration, startingAt);
  const last = tasks[tasks.length - 1];
  if (last === undefined) {
    throw new AppError("internal_error", "a schedule with no tasks has no end date");
  }
  return last.date;
}

/**
 * The instants for a task already placed on `date`.
 *
 * The time zone change path re-materializes tasks by recomputing exactly this,
 * keeping each task's calendar date and sequence and moving only its instants.
 * `previousDeadline` is the deadline of the task before it, as that task now
 * stands, or null for a challenge's first task.
 */
export function taskInstants(
  configuration: ScheduleConfiguration,
  date: string,
  sequence: number,
  previousDeadline: Date | null,
): MaterializedTask {
  const deadlines = deadlinesByWeekday(configuration.schedule);
  return taskOn(configuration, deadlines, date, sequence, previousDeadline);
}

/** The first task on or after `fromDate` whose cutoff is still ahead of `startingAt`. */
function firstTaskFrom(
  configuration: ScheduleConfiguration,
  deadlines: Map<Weekday, string>,
  fromDate: string,
  startingAt: Date,
): MaterializedTask {
  let candidate = fromDate;
  for (let attempt = 0; attempt <= MAXIMUM_DAYS_BETWEEN_TASKS; attempt += 1) {
    const date = nextScheduledDate(deadlines, candidate);
    // The first task has no task before it, so its window is its own.
    const task = taskOn(configuration, deadlines, date, 1, null);
    if (task.pauseCutoff.getTime() > startingAt.getTime()) {
      return task;
    }
    candidate = nextDate(date);
  }
  throw new AppError("internal_error", "no schedulable task date within two weeks");
}

function taskOn(
  configuration: ScheduleConfiguration,
  deadlines: Map<Weekday, string>,
  date: string,
  sequence: number,
  previousDeadline: Date | null,
): MaterializedTask {
  const deadlineLocal = deadlines.get(weekdayOf(date));
  if (deadlineLocal === undefined) {
    throw new AppError("internal_error", `${date} is not an active weekday for this challenge`);
  }
  const deadline = resolveLocalTime(date, deadlineLocal, configuration.timeZone);
  return {
    sequence,
    date,
    opensAt: opensAtFor(deadline, configuration.walkWindowMinutes, previousDeadline),
    deadline,
    // Real time, not wall-clock time: the notice a user gets does not change
    // because the clocks did.
    pauseCutoff: new Date(deadline.getTime() - configuration.noRegretMinutes * 60_000),
  };
}

/**
 * When a walk with this deadline opens.
 *
 * The window is real time, like the cutoff: ten minutes before a deadline is
 * ten minutes on the night the clocks change too, and it can reach back across
 * midnight into the date before. The previous deadline bounds it from below,
 * and the task's own deadline from above.
 */
function opensAtFor(
  deadline: Date,
  walkWindowMinutes: number,
  previousDeadline: Date | null,
): Date {
  const windowStart = deadline.getTime() - walkWindowMinutes * 60_000;
  const floor = previousDeadline?.getTime() ?? Number.NEGATIVE_INFINITY;
  return new Date(Math.min(deadline.getTime(), Math.max(windowStart, floor)));
}

/** The first date on or after `fromDate` that the weekly schedule covers. */
function nextScheduledDate(deadlines: Map<Weekday, string>, fromDate: string): string {
  let date = fromDate;
  for (let step = 0; step <= MAXIMUM_DAYS_BETWEEN_TASKS; step += 1) {
    if (deadlines.has(weekdayOf(date))) {
      return date;
    }
    date = nextDate(date);
  }
  throw new AppError("internal_error", "no active weekday within two weeks");
}

function deadlinesByWeekday(schedule: WeeklySchedule): Map<Weekday, string> {
  const deadlines = new Map<Weekday, string>();
  for (const day of schedule) {
    deadlines.set(day.weekday, day.deadline);
  }
  if (deadlines.size === 0) {
    throw new AppError("internal_error", "a weekly schedule needs at least one active weekday");
  }
  return deadlines;
}

/**
 * Calendar arithmetic, done in UTC on purpose.
 *
 * A date has no zone, and walking one in a zone would make the answer depend on
 * whether that day had 23, 24, or 25 hours in it. The zone enters only when a
 * date and a wall-clock time become an instant.
 */
function nextDate(date: string): string {
  const parsed = DateTime.fromISO(date, { zone: "utc" });
  if (!parsed.isValid) {
    throw new AppError("internal_error", `not a calendar date: ${date}`);
  }
  return parsed.plus({ days: 1 }).toFormat("yyyy-MM-dd");
}

function weekdayOf(date: string): Weekday {
  const parsed = DateTime.fromISO(date, { zone: "utc" });
  if (!parsed.isValid) {
    throw new AppError("internal_error", `not a calendar date: ${date}`);
  }
  const weekday = WEEKDAY_BY_LUXON_NUMBER[parsed.weekday];
  if (weekday === undefined) {
    throw new AppError("internal_error", `not a weekday number: ${parsed.weekday}`);
  }
  return weekday;
}

/** Whole days between two calendar dates, `to` minus `from`. */
export function daysBetween(from: string, to: string): number {
  const start = DateTime.fromISO(from, { zone: "utc" });
  const end = DateTime.fromISO(to, { zone: "utc" });
  if (!start.isValid || !end.isValid) {
    throw new AppError("internal_error", `not a pair of calendar dates: ${from}, ${to}`);
  }
  return Math.round(end.diff(start, "days").days);
}
