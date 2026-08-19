/**
 * The No Regret Time, said as what it actually does.
 *
 * `docs/product.md` defines it as the minimum advance notice required to skip a
 * task: the pause cutoff is the deadline less this duration, and pausing at or
 * after that cutoff leaves the morning live. The setup form asked for it as
 * "how long you have to stay up once you are awake", which is a different
 * promise about a different thing - a user reading that sentence set eight
 * hours believing they were agreeing to stay out of bed until three in the
 * afternoon, and then found they could no longer skip tomorrow at midnight.
 *
 * So this module owns two sentences about the one setting:
 *
 * - Being configured: what the number will mean, read back against the
 *   mornings already picked, because "8 hours" only becomes concrete as the
 *   clock time a 7:00 AM morning stops being skippable.
 * - Once it is running: how long is left on the open task's notice, which is
 *   the only form of the setting the user ever has to act on.
 *
 * The running half compares the server's own `pauseCutoff` against the clock.
 * The configuring half is the only place the app does the subtraction itself,
 * and it does it in wall-clock minutes against a deadline that has no date yet,
 * so it can say nothing about a particular day and does not try to.
 */

import { formatDeadline, formatDuration, formatWallClock } from "../ui/format.ts";

const MINUTES_PER_DAY = 1440;

/** The hint under the field, which is the whole of what the setting is for. */
export const NO_REGRET_HINT =
  "How much notice you have to give to skip a morning. Once a morning is inside its notice, it stays live and has to be walked.";

/** What to say when the field is empty, in the same terms as the hint. */
export const NO_REGRET_MISSING = "Type how many minutes of notice you need to skip a morning.";

/**
 * How far ahead of a deadline the chance to skip it runs out, expressed the
 * only way it can be before a challenge exists: a wall-clock time, and how many
 * days before the morning it falls on.
 */
export interface SkipCutoff {
  /** The wall clock the notice runs out at, as `HH:MM`. */
  readonly wallClock: string;
  /** Whole days before the morning it belongs to. Zero is that same morning. */
  readonly daysBefore: number;
}

/**
 * The cutoff for one deadline, or null when the deadline is not a wall clock.
 *
 * Eight hours before 07:00 is 23:00 the previous day, which is why the answer
 * carries a day count rather than a time alone: a cutoff that reads as 11:00 PM
 * with no "the day before" on it names the wrong night.
 */
export function skipCutoffFor(deadline: string, noRegretMinutes: number): SkipCutoff | null {
  const match = /^(\d{2}):(\d{2})$/.exec(deadline);
  if (match === null) {
    return null;
  }
  const total = Number(match[1]) * 60 + Number(match[2]) - noRegretMinutes;
  // Guarded rather than negated straight, because `-Math.floor(0.29)` is
  // negative zero, which reads as zero everywhere except an equality check.
  const daysBefore = total >= 0 ? 0 : -Math.floor(total / MINUTES_PER_DAY);
  const wall = ((total % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return { wallClock: pad(wall), daysBefore };
}

/**
 * The setting read back against the mornings picked so far.
 *
 * The earliest deadline is the one named, because it has the earliest cutoff
 * and is therefore the tightest thing the number is promising; every other
 * morning gets more notice than the one on screen, not less.
 */
export function noRegretReading(
  minutes: number,
  schedule: readonly { readonly deadline: string }[],
): string {
  if (minutes === 0) {
    return "No notice needed: a morning can be skipped right up to its deadline.";
  }
  const earliest = earliestDeadline(schedule);
  const cutoff = earliest === null ? null : skipCutoffFor(earliest, minutes);
  if (earliest === null || cutoff === null) {
    return `That is ${formatDuration(minutes)} of notice before a morning stops being skippable.`;
  }
  return `That is ${formatDuration(minutes)}: a ${formatWallClock(earliest)} morning stops being skippable at ${formatWallClock(cutoff.wallClock)} ${dayPhrase(cutoff.daysBefore)}.`;
}

/** How long is left on an open task's notice. */
export interface SkipWindow {
  /** Whole minutes until the cutoff. Zero once it has gone. */
  readonly minutesLeft: number;
  /** The cutoff is behind us, so this morning can no longer be skipped. */
  readonly closed: boolean;
  /** Close enough that the line is worth reading as a warning rather than a fact. */
  readonly closing: boolean;
}

/**
 * How long a decision to skip is still available for. Named for the same reason
 * the morning's own deadline is counted down: the alternative is a screen that
 * offers a pause which would skip the day, right up to the moment it silently
 * would not.
 */
export const SKIP_CLOSING_MINUTES = 60;

export function skipWindowFor(pauseCutoff: string, now: Date): SkipWindow {
  const at = Date.parse(pauseCutoff);
  if (Number.isNaN(at)) {
    // Nothing can be said about a cutoff that will not parse, and saying a
    // window is open is the answer that would cost the user a morning.
    return { minutesLeft: 0, closed: true, closing: false };
  }
  const minutesLeft = Math.floor((at - now.getTime()) / 60_000);
  if (minutesLeft <= 0) {
    return { minutesLeft: 0, closed: true, closing: false };
  }
  return { minutesLeft, closed: false, closing: minutesLeft <= SKIP_CLOSING_MINUTES };
}

/**
 * The open window as a sentence, or null once it has closed - the screens that
 * draw this already say what a passed cutoff means, and a countdown reading
 * zero beside that would be the same fact twice.
 */
export function skipWindowSentence(
  window: SkipWindow,
  pauseCutoff: string,
  timeZone: string,
): string | null {
  if (window.closed) {
    return null;
  }
  return `You have until ${formatDeadline(pauseCutoff, timeZone)} to skip it - ${formatDuration(window.minutesLeft)} left.`;
}

function earliestDeadline(schedule: readonly { readonly deadline: string }[]): string | null {
  let earliest: string | null = null;
  for (const day of schedule) {
    if (!/^\d{2}:\d{2}$/.test(day.deadline)) {
      continue;
    }
    if (earliest === null || day.deadline < earliest) {
      earliest = day.deadline;
    }
  }
  return earliest;
}

function dayPhrase(daysBefore: number): string {
  if (daysBefore <= 0) {
    return "the same morning";
  }
  return daysBefore === 1 ? "the day before" : `${daysBefore} days before`;
}

function pad(minutesOfDay: number): string {
  const hours = Math.floor(minutesOfDay / 60);
  const minutes = minutesOfDay % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
