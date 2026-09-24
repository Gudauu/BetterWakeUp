/**
 * The day this challenge started.
 *
 * The challenge page counts walks - "4 of 30 walks done" - and names the day it
 * is projected to end. On any schedule short of seven mornings a week a count
 * of walks is not a measure of time, so the page names the start beside the
 * end, and the two together say how long the challenge spans.
 *
 * `activatedAt` is the instant the challenge became live. It is read as a
 * calendar day in the challenge's own zone rather than as an instant, because
 * "which day did this start on" is a question about the days the deadlines are
 * read in, not about the device's.
 *
 * Nothing here asks the server anything, and nothing here decides what a day
 * meant - `history.ts` reads the calendar.
 */

import type { ChallengeView } from "@betterwakeup/contract";
import { formatDay } from "../ui/format.ts";
import { localDate } from "./walk-window.ts";

/**
 * The day the challenge went live, as a person reads it, or null when there is
 * nothing honest to say.
 *
 * Null when the challenge has not been activated - a funded one is answered
 * before its provider webhook lands - and null when the zone cannot be read at
 * all, since a start date named in the wrong zone would be off by a day exactly
 * when the challenge is young enough for the day to be the whole answer.
 */
export function challengeStartedOn(challenge: ChallengeView): string | null {
  const activatedAt = challenge.activatedAt;
  if (activatedAt === null) {
    return null;
  }
  const started = Date.parse(activatedAt);
  if (Number.isNaN(started)) {
    return null;
  }
  const startDay = localDate(new Date(started), challenge.configuration.timeZone);
  return startDay === null ? null : formatDay(startDay);
}
