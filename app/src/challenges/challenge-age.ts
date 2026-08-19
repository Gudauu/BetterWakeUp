/**
 * How long this challenge has been going.
 *
 * Home counts mornings: "5 of 30 days done, 25 to go". That is the only number
 * on the screen about how far along a challenge is, and on any schedule short of
 * seven mornings a week it is not a measure of time at all - five kept mornings
 * on a Monday/Wednesday/Friday challenge is a fortnight, and the card said
 * nothing that would let anyone tell a fortnight from five days.
 *
 * `activatedAt` is the instant the challenge became live, which the server has
 * answered since the read was written and no screen has ever drawn. It is read
 * as a calendar day in the challenge's own zone rather than as an instant,
 * because "which day did this start on" and "which day of it is today" are both
 * questions about the days the deadlines are read in, not about the device's.
 *
 * Nothing here asks the server anything, and nothing here decides what a day
 * meant - `history.ts` reads the calendar.
 */

import type { ChallengeView } from "@betterwakeup/contract";
import { formatDay } from "../ui/format.ts";
import { localDate } from "./walk-window.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ChallengeAge {
  /** The day the challenge went live, as a person reads it. */
  readonly startedOn: string;
  /** Which day of the challenge today is, said as a sentence. */
  readonly dayText: string;
}

/**
 * The challenge's age, or null when there is nothing honest to say.
 *
 * Null when the challenge has not been activated - a funded one is answered
 * before its provider webhook lands - and null when the zone cannot be read at
 * all, since a start date named in the wrong zone would be off by a day exactly
 * when the challenge is young enough for the day to be the whole answer.
 */
export function challengeAge(challenge: ChallengeView, now: Date): ChallengeAge | null {
  const activatedAt = challenge.activatedAt;
  if (activatedAt === null) {
    return null;
  }
  const started = Date.parse(activatedAt);
  if (Number.isNaN(started)) {
    return null;
  }
  const zone = challenge.configuration.timeZone;
  const startDay = localDate(new Date(started), zone);
  const today = localDate(now, zone);
  if (startDay === null || today === null) {
    return null;
  }
  return {
    startedOn: formatDay(startDay),
    dayText: dayTextFor(elapsedDays(startDay, today)),
  };
}

/**
 * Whole calendar days between two plain dates, both read and rebuilt in UTC so
 * that no zone shifts either of them. A clock that has been set back - or a
 * challenge activated a moment into tomorrow where the user is standing - is
 * floored at zero rather than counting backwards into a day zero.
 */
function elapsedDays(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return 0;
  }
  return Math.max(0, Math.round((end - start) / DAY_MS));
}

/**
 * The day count as a sentence. The first day is named rather than numbered,
 * because "day 1" reads as a countdown someone is already behind on, and the
 * count is of days since it started rather than of mornings kept - which is
 * what the progress line beside it already says.
 */
function dayTextFor(elapsed: number): string {
  if (elapsed === 0) {
    return "This challenge started today.";
  }
  return `Today is day ${elapsed + 1} of this challenge.`;
}
