/**
 * How long is left to decide on the Emergency Recovery.
 *
 * This is the most expensive clock in the app. A missed day puts the challenge
 * into `recovery_pending` and the server holds the settlement open until the
 * offer's `expiresAt`; letting that instant pass is what charges the deposit.
 * Yet both screens that mention the offer named an absolute time and nothing
 * else - "closes at Tue, Sep 1, 5:00 PM" - which is a fact about the future,
 * not an answer to the question a user actually has, which is whether they have
 * to decide now.
 *
 * Worse, neither screen read the clock at all: once the window had closed, home
 * still offered "Decide on your recovery" and the recovery screen still drew the
 * spend-or-keep choice with a live button under it. The command refuses an
 * expired offer before it sends anything, so the user's reward for two presses
 * was a refusal explaining that the decision had already been made for them.
 *
 * This module turns the offer and the clock into the reading those screens need:
 * how long is left, whether that is close enough to raise the user's pulse, and
 * whether there is still a decision to offer at all.
 */

import type { ChallengeView } from "@betterwakeup/contract";
import { RECOVERY_LEAD_MINUTES } from "../reminders/reminders.ts";
import { formatDeadline, formatDuration } from "../ui/format.ts";

/**
 * How urgently the window reads.
 *
 * The boundary between the first two is the recovery reminder's own lead time:
 * the app has already decided that `RECOVERY_LEAD_MINUTES` before the offer
 * lapses is the moment worth waking someone for, so it is the same moment the
 * countdown stops being background information.
 */
export type RecoveryUrgency = "open" | "closing" | "closed";

export const RECOVERY_CLOSING_MINUTES = RECOVERY_LEAD_MINUTES;

export interface RecoveryWindow {
  readonly urgency: RecoveryUrgency;
  /** Whole minutes still to run, never below zero. */
  readonly minutes: number;
  /** True while the offer can still be spent, which is what gates the action. */
  readonly decidable: boolean;
  /** The countdown, as a person would say it. */
  readonly sentence: string;
}

/**
 * The window on a challenge's recovery offer, or null when no offer is open -
 * so a screen with nothing waiting on a decision draws nothing rather than
 * counting down to an instant that does not exist.
 */
export function recoveryWindow(challenge: ChallengeView, now: Date): RecoveryWindow | null {
  const offer = challenge.recoveryOffer;
  if (offer === null) {
    return null;
  }
  // Whole minutes, floored: 59 seconds left is not "1 minute left", and the
  // wording for zero says "less than a minute" rather than a bare number.
  const minutes = Math.floor((Date.parse(offer.expiresAt) - now.getTime()) / 60_000);
  if (minutes < 0) {
    return {
      urgency: "closed",
      minutes: 0,
      decidable: false,
      sentence: RECOVERY_WINDOW_CLOSED,
    };
  }
  return {
    urgency: minutes <= RECOVERY_CLOSING_MINUTES ? "closing" : "open",
    minutes,
    decidable: true,
    sentence: `${formatDuration(minutes)} left to decide.`,
  };
}

/** When the window opened, and how much of it the user has already spent. */
export interface RecoveryOpening {
  /** The instant the miss was recorded, read in the challenge's own zone. */
  readonly openedAt: string;
  /** How long ago that was, as a person would say it. */
  readonly ago: string;
  /** The whole window from opening to expiry, measured rather than restated. */
  readonly total: string;
  /** The two facts as one sentence, in the tense the clock puts them in. */
  readonly sentence: string;
}

/**
 * When the offer opened.
 *
 * `recoveryOffer.offeredAt` is the instant the sweep recorded the miss, which is
 * both the start of the window and the app's only word for when the challenge
 * stopped running. The screens named neither: "A task was missed" with a
 * closing time beside it leaves a user who has just opened the app unable to
 * tell whether this happened an hour ago or most of a day ago, and the time left
 * alone does not say it - a countdown reads the same on a short window barely
 * begun as on a long one nearly gone.
 *
 * The window's length is measured from the offer's own two instants rather than
 * restated from the server's `RECOVERY_WINDOW_HOURS`, so a server that changes
 * it does not make this sentence a lie.
 *
 * Null when no offer is open, and when either instant cannot be read as a time -
 * an unreadable pair can still be shown as a closing time by the caller, but it
 * cannot be counted from.
 */
export function recoveryOpening(challenge: ChallengeView, now: Date): RecoveryOpening | null {
  const offer = challenge.recoveryOffer;
  if (offer === null) {
    return null;
  }
  const opened = Date.parse(offer.offeredAt);
  const expires = Date.parse(offer.expiresAt);
  if (Number.isNaN(opened) || Number.isNaN(expires)) {
    return null;
  }
  const openedAt = formatDeadline(offer.offeredAt, challenge.configuration.timeZone);
  // Floored at zero: a device clock standing behind the server's would
  // otherwise report the miss as something still to come.
  const ago = `${formatDuration(Math.max(0, Math.floor((now.getTime() - opened) / 60_000)))} ago`;
  const total = formatDuration(Math.max(0, Math.floor((expires - opened) / 60_000)));
  const closed = now.getTime() >= expires;
  return {
    openedAt,
    ago,
    total,
    sentence: closed
      ? `This came up ${ago}, when your missed morning was recorded at ${openedAt}. There were ${total} to decide.`
      : `This came up ${ago}, when your missed morning was recorded at ${openedAt}. The window runs ${total} from then.`,
  };
}

/**
 * What is said once the window has gone by. By the time this is on screen there
 * is nothing left to press, so the only job is to explain what happened while
 * the user was not looking. It stops short of naming what became of the money:
 * a zero-deposit challenge settles nothing, and home reports the outcome the
 * server states once the sweep has run.
 */
export const RECOVERY_WINDOW_CLOSED =
  "This offer has closed, so the missed day stands and the challenge ended with it.";

/**
 * The offer as home states it, which is one sentence with the clock in it.
 *
 * Home has to say the same thing in a banner that competes with everything else
 * on the screen, so the time left leads and the closing time follows it: "2
 * hours left" is what decides whether the user opens it now, and "by 5:00 PM"
 * is what they plan around.
 */
export function recoveryOfferSummary(window: RecoveryWindow, closingTime: string): string {
  if (!window.decidable) {
    return `You missed a day and the window to forgive it closed at ${closingTime}. ${RECOVERY_WINDOW_CLOSED}`;
  }
  return `You missed a day. Your one Emergency Recovery can forgive it - ${lowerFirst(window.sentence)} It closes at ${closingTime}.`;
}

function lowerFirst(sentence: string): string {
  return sentence.charAt(0).toLowerCase() + sentence.slice(1);
}
