/**
 * Whether the walk the app is showing can be walked yet.
 *
 * The server hands out one open task at a time, and the moment a morning is
 * kept the open task becomes the *next* morning's. Home drew that task exactly
 * as it drew today's: a step target and a button reading "Open today's task".
 * Both were wrong. A completion is refused unless its observation falls inside
 * the task's own local day (`create-completion.ts` checks it against the start
 * of that day), so a walk taken tonight for tomorrow's task is work the server
 * cannot accept - the same shape as the deadline that has already passed, at
 * the other end of the window.
 *
 * The comparison is between calendar dates in the challenge's own time zone,
 * not between instants: the task's `date` is the local day it belongs to, so
 * "has that day started" is answered by asking what day it is where the
 * challenge reads its deadlines.
 *
 * Nothing here decides what a day meant - `history.ts` reads the calendar - and
 * nothing here asks the server anything.
 */

import type { ChallengeView } from "@betterwakeup/contract";

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
  /** The task belongs to a day that has not started yet where the challenge is. */
  readonly opensLater: boolean;
  /** That day is the one straight after today, which is worth saying as a word. */
  readonly opensTomorrow: boolean;
  /** Today's own day was walked. Only true once the server has recorded it. */
  readonly walkedToday: boolean;
}

/**
 * Where the open task stands against the day it is now.
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
  const today = localDate(now, challenge.configuration.timeZone);
  if (today === null) {
    return null;
  }
  return {
    opensLater: task.date > today,
    opensTomorrow: task.date === dayAfter(today),
    walkedToday: challenge.days.some((day) => day.date === today && day.status === "completed"),
  };
}

/** The date after a plain calendar date, read and rebuilt in UTC so no zone shifts it. */
function dayAfter(date: string): string {
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) {
    return date;
  }
  return new Date(parsed + DAY_MS).toISOString().slice(0, 10);
}

/**
 * The one line that tells a user why there is no button under this walk.
 *
 * It names the rule rather than the refusal: someone who has just kept a day
 * and is looking at tomorrow's would otherwise read the missing button as the
 * app having lost the walk, and someone keen enough to try it early would spend
 * a walk on a completion the server throws away.
 */
export function walkOpensText(window: WalkWindow, dayText: string, deadlineTime: string): string {
  const when = window.opensTomorrow ? "tomorrow morning" : `on ${dayText}`;
  return `This one opens ${when} and has to be walked then, by ${deadlineTime}. Steps taken before it opens cannot count for it.`;
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
