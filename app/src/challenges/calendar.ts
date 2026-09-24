/**
 * The challenge's days laid out as a wall calendar.
 *
 * A row of marks says how the walks went, but not when: a weekday challenge
 * reads as an unbroken run of squares, and nothing shows that the gap between
 * Friday and Monday is a weekend rather than a pause. A calendar puts every
 * date in its column, so a day with no walk is visibly a day with no walk.
 *
 * Nothing here asks the server anything and nothing here decides what a day
 * meant. `history.ts` reads each walk day from the server's calendar; this
 * only fills in the dates between them and cuts the result into weeks.
 */

import type { ChallengeHistory, DayState } from "./history.ts";

/**
 * What one square is. A walk day carries its history state. `rest` is a date
 * inside the challenge that holds no walk, such as a weekend on a weekday
 * schedule. `outside` pads a week that starts before the first walk or ends
 * after the last one, so every row is seven squares wide.
 */
export type CalendarDayState = DayState | "rest" | "outside";

export interface CalendarDay {
  /** The calendar date, as `2026-09-01`. */
  readonly date: string;
  /** The day of the month, which is what a square is labelled with. */
  readonly dayOfMonth: number;
  readonly state: CalendarDayState;
}

export interface CalendarMonth {
  /** The month's first date, as `2026-09-01`, for a caller to name it. */
  readonly month: string;
  /** Monday-first weeks of exactly seven squares each. */
  readonly weeks: readonly (readonly CalendarDay[])[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The months the challenge spans, from its first walk to its last.
 *
 * Empty before the challenge activates, when it holds no days. A week that
 * crosses into the next month is split at the month boundary, so every month
 * starts on its own row the way a printed calendar does.
 */
export function challengeCalendar(history: ChallengeHistory): readonly CalendarMonth[] {
  const first = history.days[0];
  const last = history.days[history.days.length - 1];
  if (first === undefined || last === undefined) {
    return [];
  }
  const walks = new Map(history.days.map((day) => [day.date, day.state]));
  const start = parse(first.date);
  const end = parse(last.date);

  const months: CalendarMonth[] = [];
  for (let month = monthStart(start); month <= end; month = nextMonth(month)) {
    const monthEnd = nextMonth(month) - DAY_MS;
    const weeks: CalendarDay[][] = [];
    // Back to the Monday on or before the first of the month, then forward
    // a week at a time until the week holding the month's last date is drawn.
    for (let weekStart = mondayOnOrBefore(month); weekStart <= monthEnd; weekStart += 7 * DAY_MS) {
      const week: CalendarDay[] = [];
      for (let offset = 0; offset < 7; offset += 1) {
        const at = weekStart + offset * DAY_MS;
        const date = format(at);
        const inMonth = at >= month && at <= monthEnd;
        const inChallenge = at >= start && at <= end;
        week.push({
          date,
          dayOfMonth: new Date(at).getUTCDate(),
          state: !inMonth || !inChallenge ? "outside" : (walks.get(date) ?? "rest"),
        });
      }
      weeks.push(week);
    }
    // A week before the first walk or after the last is only padding.
    const drawn = weeks.filter((week) => week.some((day) => day.state !== "outside"));
    if (drawn.length > 0) {
      months.push({ month: format(month), weeks: drawn });
    }
  }
  return months;
}

/** A calendar date read as midnight UTC, so no zone moves it across a day. */
function parse(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

function format(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function monthStart(at: number): number {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function nextMonth(at: number): number {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

/** `getUTCDay` counts from Sunday; a Monday-first week counts from Monday. */
function mondayOnOrBefore(at: number): number {
  const fromMonday = (new Date(at).getUTCDay() + 6) % 7;
  return at - fromMonday * DAY_MS;
}
