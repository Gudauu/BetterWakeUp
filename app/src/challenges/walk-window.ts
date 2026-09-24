/**
 * Whether the walk the app is showing can be walked yet.
 *
 * The server hands out one open task at a time, and the moment a morning is
 * kept the open task becomes the *next* morning's. A walk opens only at its
 * `opensAt` - the deadline less the challenge's walk window, or the previous
 * task's deadline if that is later - and `create-completion.ts` refuses any
 * walk that started before it. A walk taken before then is work the server
 * cannot accept: the same shape as the deadline that has already passed, at
 * the other end of the window.
 *
 * The comparison is between instants, not calendar dates. A window is a length
 * of time rather than a time of day, so a 12:30 AM deadline with an hour's
 * window opens at 11:30 PM on the date before the task's own, and asking "has
 * the task's day started" would hide a walk that is open. The server states the
 * instant, so nothing here derives it.
 *
 * Nothing here decides what a day meant - `history.ts` reads the calendar - and
 * nothing here asks the server anything.
 */

import type { ChallengeView, TaskView } from "@betterwakeup/contract";
import { formatDeadline, formatTimeOfDay } from "../ui/format.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The calendar date it is right now where this challenge reads its deadlines,
 * as `2026-09-01`, or null on a runtime whose Intl has no zone data.
 *
 * `en-CA` is the locale that formats a date as ISO, which is the same shape the
 * server's task dates arrive in, so the two can be compared as text.
 */
export function localDate(at: Date, timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return null;
  }
}

export interface WalkWindow {
  /** The walk's window has not opened yet, so nothing walked now can count. */
  readonly opensLater: boolean;
  /** It opens on the day straight after today, which is worth saying as a word. */
  readonly opensTomorrow: boolean;
  /** Today's own day was walked. Only true once the server has recorded it. */
  readonly walkedToday: boolean;
}

/**
 * Where the open task stands against the instant it is now.
 *
 * Null when the challenge holds no open task, and null when the zone cannot be
 * read at all - in both cases home says what it always said, because a guess
 * about which day it is would be worse than the sentence it replaces.
 */
export function walkWindow(challenge: ChallengeView, now: Date): WalkWindow | null {
  const task = challenge.currentTask;
  if (task === null) {
    return null;
  }
  const { timeZone } = challenge.configuration;
  const today = localDate(now, timeZone);
  const opensOn = localDate(new Date(task.opensAt), timeZone);
  if (today === null || opensOn === null) {
    return null;
  }
  return {
    opensLater: !hasOpened(task, now),
    opensTomorrow: !hasOpened(task, now) && opensOn === dayAfter(today),
    walkedToday: challenge.days.some((day) => day.date === today && day.status === "completed"),
  };
}

/**
 * Whether the walk's window has opened: `now` is at or past the server's
 * `opensAt`. An instant that will not parse reads as open, because the answer
 * that would cost a morning is the one that hides the walk.
 */
export function hasOpened(task: Pick<TaskView, "opensAt">, now: Date): boolean {
  const opens = Date.parse(task.opensAt);
  return Number.isNaN(opens) || now.getTime() >= opens;
}

/**
 * When a walk that has not opened yet opens, said against today: "today at
 * 11:30 PM", "tomorrow at 6:50 AM", or the day in full further out.
 */
export function opensAtText(task: Pick<TaskView, "opensAt">, timeZone: string, now: Date): string {
  const today = localDate(now, timeZone);
  const opensOn = localDate(new Date(task.opensAt), timeZone);
  const time = formatTimeOfDay(task.opensAt, timeZone);
  if (today !== null && opensOn === today) {
    return `today at ${time}`;
  }
  if (today !== null && opensOn === dayAfter(today)) {
    return `tomorrow at ${time}`;
  }
  return formatDeadline(task.opensAt, timeZone);
}

/** The date after a plain calendar date, read and rebuilt in UTC so no zone shifts it. */
export function dayAfter(date: string): string {
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) {
    return date;
  }
  return new Date(parsed + DAY_MS).toISOString().slice(0, 10);
}

/**
 * What home says on a morning that has already been kept.
 *
 * The day is the unit of this product, and until now the only mark of a kept
 * one on home was a square in the row of days: the card that had asked for the
 * walk simply started asking for the next one. A run is named when there is a
 * run, because that is the thing worth coming back for, and a single kept day
 * is stated as itself rather than counted.
 */
export function walkedTodayText(streak: number): string {
  if (streak >= 2) {
    return `Today's walk is done. That is ${streak} days in a row.`;
  }
  return "Today's walk is done. Nothing else is due today.";
}
