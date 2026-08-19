/**
 * The weekly schedule, read back to the person who set it.
 *
 * A challenge's schedule is decided once and can never be edited, so the only
 * thing the app can do about it afterwards is state it. Until now it did not:
 * the configuration carried one deadline per active weekday and no screen past
 * the setup form ever showed either the days or the times, so a user three
 * weeks in had no way to answer "which mornings am I on the hook for?" except
 * by waiting for a task to appear.
 *
 * Everything here is pure text about a configuration. The days are grouped by
 * the deadline they share, because "Mon-Fri at 7:00 AM" is the schedule as its
 * owner thinks of it and seven separate rows is a table to be decoded.
 */

import type { ScheduledWeekday, Weekday } from "@betterwakeup/contract";
import { formatWallClock } from "../ui/format.ts";
import { WEEKDAY_ORDER } from "./draft.ts";
import { localDate } from "./walk-window.ts";

/** Short enough for a row label, unambiguous on its own. */
const SHORT_LABEL: Readonly<Record<Weekday, string>> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

/** How a day is named in a sentence, where an abbreviation would read clipped. */
const FULL_LABEL: Readonly<Record<Weekday, string>> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

export interface ScheduleGroup {
  /** The days, as "Mon-Fri", "Sat, Sun" or "Every day". */
  readonly days: string;
  /** The deadline they share, as "7:00 AM". */
  readonly time: string;
}

/**
 * The schedule as the fewest lines that still say all of it: one group per
 * deadline, with days that run consecutively collapsed into a range.
 *
 * Grouping is by deadline rather than by position, so a challenge whose weekend
 * starts an hour later reads as two lines rather than as a run broken in the
 * middle. An empty schedule produces no groups: a challenge cannot be created
 * with one, and inventing a line for it would be stating something false.
 */
export function scheduleGroups(schedule: readonly ScheduledWeekday[]): readonly ScheduleGroup[] {
  const ordered = [...schedule].sort(
    (a, b) => WEEKDAY_ORDER.indexOf(a.weekday) - WEEKDAY_ORDER.indexOf(b.weekday),
  );
  const byDeadline = new Map<string, Weekday[]>();
  for (const day of ordered) {
    const days = byDeadline.get(day.deadline);
    if (days === undefined) {
      byDeadline.set(day.deadline, [day.weekday]);
    } else {
      days.push(day.weekday);
    }
  }

  const groups: ScheduleGroup[] = [];
  for (const [deadline, days] of byDeadline) {
    groups.push({ days: daysLabel(days), time: formatWallClock(deadline) });
  }
  return groups;
}

/**
 * The whole schedule on one line, for a summary that has no room for rows.
 * Groups are separated by a comma and the word "and" is deliberately absent -
 * "Mon-Fri at 7:00 AM, Sat at 9:00 AM" is a list of arrangements rather than a
 * sentence about days.
 */
export function scheduleSentence(schedule: readonly ScheduledWeekday[]): string {
  const groups = scheduleGroups(schedule);
  if (groups.length === 0) {
    return "No mornings set.";
  }
  return groups.map((group) => `${group.days} at ${group.time}`).join(", ");
}

/**
 * The next morning the challenge asks for, named as a weekday, or null when the
 * runtime cannot say what day it is where the challenge reads its deadlines.
 *
 * Strictly after today, because this is only ever asked when today holds no
 * open task: either today is not an active day, or its own task is already
 * behind the user. Naming today in either case would read as an invitation to
 * walk for a day that is closed.
 */
export function nextActiveMorning(
  schedule: readonly ScheduledWeekday[],
  now: Date,
  timeZone: string,
): string | null {
  const today = localDate(now, timeZone);
  if (today === null || schedule.length === 0) {
    return null;
  }
  const active = new Set(schedule.map((day) => day.weekday));
  // `localDate` answers a plain calendar date, so reading it back at midnight
  // UTC names the same day everywhere rather than shifting by the zone.
  const todayIndex = new Date(`${today}T00:00:00.000Z`).getUTCDay();
  for (let ahead = 1; ahead <= 7; ahead += 1) {
    const weekday = weekdayOfIndex((todayIndex + ahead) % 7);
    if (active.has(weekday)) {
      return FULL_LABEL[weekday];
    }
  }
  return null;
}

/**
 * What home says under a challenge with no task open. The weekday is named when
 * it can be worked out, and the sentence falls back to what it always said on a
 * runtime that cannot read the zone.
 */
export function nextMorningText(nextMorning: string | null): string {
  if (nextMorning === null) {
    return "Nothing is due right now. The next task appears on your next active day.";
  }
  return `Nothing is due right now. Your next morning is ${nextMorning}.`;
}

/** `getUTCDay` counts from Sunday; the product counts from Monday. */
function weekdayOfIndex(index: number): Weekday {
  const fromSunday: readonly Weekday[] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  // The index is a remainder of 7, so the lookup always lands.
  return fromSunday[index] ?? "sunday";
}

/**
 * A run of days as the shortest true reading of it: every day, a range when
 * three or more sit next to each other, and a plain list otherwise. Two
 * consecutive days stay a list because "Sat-Sun" saves no characters and reads
 * as a span rather than as two mornings.
 */
function daysLabel(days: readonly Weekday[]): string {
  if (days.length === 7) {
    return "Every day";
  }
  const runs: Weekday[][] = [];
  for (const day of days) {
    const current = runs.at(-1);
    const previous = current?.at(-1);
    if (
      current !== undefined &&
      previous !== undefined &&
      WEEKDAY_ORDER.indexOf(day) === WEEKDAY_ORDER.indexOf(previous) + 1
    ) {
      current.push(day);
    } else {
      runs.push([day]);
    }
  }
  return runs
    .map((run) =>
      run.length >= 3
        ? `${SHORT_LABEL[run[0] as Weekday]}-${SHORT_LABEL[run.at(-1) as Weekday]}`
        : run.map((day) => SHORT_LABEL[day]).join(", "),
    )
    .join(", ");
}
