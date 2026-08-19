/**
 * When a challenge ended, and what ended it.
 *
 * `lastEnded` is the only notice a user ever gets that a challenge is over: a
 * failure and an expiry are both decided by a server sweep the app never hears
 * about, so the card home draws in place of the empty state is the whole of the
 * report. Until now that card said how many mornings were done and what became
 * of the deposit, and nothing at all about the two questions somebody opening
 * the app to a charged deposit actually asks - when did this happen, and what
 * happened. `endedAt` was on the response and was thrown away.
 *
 * The instant is read in the device's own zone rather than the challenge's: the
 * challenge is gone and the summary carries no zone, and the phone's clock is
 * the only one the reader is holding. That is a smaller compromise than it
 * looks - the ending is a fact about a day that has passed, not a deadline
 * anybody has to act on.
 */

import { type EndedChallengeSummary, MAXIMUM_PAUSE_DAYS } from "@betterwakeup/contract";
import { formatDeadline } from "../ui/format.ts";

export interface EndedReading {
  /** When it ended, on the clock the reader is holding. */
  readonly when: string;
  /** What ended it, which the status names and nothing else on the card does. */
  readonly cause: string;
}

/**
 * When the challenge ended, named to the minute.
 *
 * The day alone would be enough for a challenge that ended last week and not
 * for one that ended overnight, which is the case a user is most likely to be
 * reading this card in - they woke up late, and the question is whether this
 * morning is the one that cost them.
 */
export function endedWhenText(ended: EndedChallengeSummary, timeZone: string): string {
  return `Ended ${formatDeadline(ended.endedAt, timeZone)}.`;
}

/**
 * What ended it.
 *
 * The status pill names the outcome and the day count names the score, and
 * between them they still never say what the app did. A failure in particular
 * reads as an accusation with no charge attached to it: one morning went by
 * without a walk the server could accept, and that is the whole rule.
 */
export function endedCauseText(ended: EndedChallengeSummary): string {
  if (ended.status === "succeeded") {
    return "Every morning it asked for was walked and saved before its deadline.";
  }
  if (ended.status === "failed") {
    return "A morning went by with no walk saved in time, and one missed morning ends a challenge.";
  }
  return `It stayed paused for ${MAXIMUM_PAUSE_DAYS} days, which is the limit, so it closed on its own. That is neither a success nor a failure.`;
}

/** Both sentences, so a caller cannot draw one and forget the other. */
export function endedReading(ended: EndedChallengeSummary, timeZone: string): EndedReading {
  return { when: endedWhenText(ended, timeZone), cause: endedCauseText(ended) };
}
