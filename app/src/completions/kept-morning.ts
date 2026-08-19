/**
 * The morning that just counted.
 *
 * An acknowledged day is the one moment the product exists for, and the screen
 * said two fixed sentences about it: "Done. Both checks passed" and "This day is
 * yours. Nothing else to do until tomorrow." The second is a guess. A challenge
 * carries a weekly schedule, so a Friday morning kept on a weekday challenge is
 * followed by nothing at all until Monday, and the app was telling its owner to
 * expect a walk the next day - the same wrong-fact shape as the No Regret Time
 * hint, on the sentence a user reads after every single walk.
 *
 * The challenge's own `days` answer which morning comes next: every day is
 * materialized when a challenge activates, so the next one still `scheduled`
 * after the day just kept is the next morning, whatever the schedule looks like
 * and whatever pauses and appended mornings have moved since. The schedule then
 * says when it is due. Nothing here asks the server anything, and nothing here
 * derives a deadline the configuration does not state.
 */

import type { ChallengeView, TaskView } from "@betterwakeup/contract";
import { deadlineForDate } from "../challenges/schedule.ts";
import { dayAfter } from "../challenges/walk-window.ts";
import { formatDay, formatTimeOfDay, formatWallClock } from "../ui/format.ts";

export interface NextMorning {
  /** The plain calendar date of the next morning the challenge still holds. */
  readonly date: string;
  /** It is the day straight after the one just kept, which is worth saying as a word. */
  readonly tomorrow: boolean;
  /** Its wall-clock deadline as configured, or null when the schedule has none for it. */
  readonly deadline: string | null;
}

/**
 * The next morning after the one just kept, or null when the challenge holds
 * none - the last day of a challenge whose finish has not been reported, and a
 * challenge whose calendar has not been read yet, are both cases where naming a
 * morning would be inventing one.
 */
export function nextMorningAfter(challenge: ChallengeView, kept: TaskView): NextMorning | null {
  const next = challenge.days.find((day) => day.date > kept.date && day.status === "scheduled");
  if (next === undefined) {
    return null;
  }
  return {
    date: next.date,
    tomorrow: next.date === dayAfter(kept.date),
    deadline: deadlineForDate(challenge.configuration.schedule, next.date),
  };
}

/**
 * What the screen says once a day is in the bank: the day is theirs, and when
 * the next one is. The deadline is stated with it because that is the number the
 * user would otherwise have to open the app again to find, and it is omitted
 * rather than guessed when the schedule does not name one.
 */
export function keptMorningText(next: NextMorning | null): string {
  const kept = "This day is yours.";
  if (next === null) {
    return `${kept} No more mornings are scheduled on this challenge.`;
  }
  const day = next.tomorrow ? `tomorrow, ${formatDay(next.date)}` : formatDay(next.date);
  const when = next.deadline === null ? "" : `, by ${formatWallClock(next.deadline)}`;
  if (next.tomorrow) {
    return `${kept} The next morning is ${day}${when}.`;
  }
  return `${kept} Nothing is due until ${day}${when}.`;
}

/**
 * When the server accepted the walk, in the challenge's own time zone.
 *
 * The acknowledgment is the fact that makes a morning count and the app had
 * never shown it: the two check rows said "passed" and the instant the server
 * wrote down - the one thing that would settle an argument about whether a walk
 * landed before the deadline - reached no screen. Null when the task carries no
 * acknowledgment, which is every state but this one.
 */
export function acknowledgedAtText(task: TaskView, timeZone: string): string | null {
  if (task.acknowledgedAt === null) {
    return null;
  }
  return `The server accepted this walk at ${formatTimeOfDay(task.acknowledgedAt, timeZone)}.`;
}
