/**
 * The sign-in that is about to run out.
 *
 * A session lasts thirty days and there is no endpoint that renews one, so
 * every signed-in phone is on a clock that ends in a forced sign-out. The app
 * held that instant from the moment it signed in and read it exactly once, at
 * launch, to decide whether the stored session was already dead - which means
 * the user's only notice that it had run out was arriving at the signed-out
 * screen, on whatever morning the thirtieth day happened to be.
 *
 * That is the worst possible moment for it: the challenge is the server's and
 * keeps counting deadlines, only a walk taken in this app can meet one, and the
 * wake-up alarms come off the device with the session. So the app says it is
 * coming while there is still time to do something about it, and what it costs
 * is not restated here - `signOutConsequence` already words exactly this, since
 * an expiry is a sign-out nobody pressed.
 *
 * Nothing here asks the server anything: the expiry is a fact the session
 * carries, and the only clock it is read against is the device's own.
 */

import type { SessionView } from "@betterwakeup/contract";
import { formatDeadline, formatDuration } from "../ui/format.ts";

/**
 * How far ahead the warning starts. Long enough to be acted on at a convenient
 * moment, short enough that it is not standing on home for a quarter of the
 * session's life: a banner a user has learned to look past is not a warning.
 */
export const SESSION_WARNING_DAYS = 3;

const MINUTES_PER_DAY = 24 * 60;

export type SessionExpiryUrgency =
  /** Still signed in, and inside the window where it is worth saying so. */
  | "closing"
  /** The instant has passed. The next request is the one that will be refused. */
  | "gone";

export interface SessionExpiry {
  /** Whole minutes to the expiry, floored, and zero once it has passed. */
  readonly minutesLeft: number;
  /** When it runs out, read in the zone the device is standing in. */
  readonly whenText: string;
  /** How long that is, as a person would say it. */
  readonly inText: string;
  readonly urgency: SessionExpiryUrgency;
}

/**
 * How this phone's sign-in stands against the clock, or null while there is
 * nothing worth saying: more than `SESSION_WARNING_DAYS` off, or an expiry the
 * runtime cannot read at all - in which case the app says nothing rather than
 * counting down to a date it had to guess.
 */
export function sessionExpiry(
  session: SessionView,
  now: Date,
  timeZone: string,
): SessionExpiry | null {
  const at = Date.parse(session.expiresAt);
  if (Number.isNaN(at)) {
    return null;
  }
  const minutesLeft = Math.max(0, Math.floor((at - now.getTime()) / 60_000));
  if (minutesLeft > SESSION_WARNING_DAYS * MINUTES_PER_DAY) {
    return null;
  }
  return {
    minutesLeft,
    whenText: formatDeadline(session.expiresAt, timeZone),
    inText: remainingText(minutesLeft),
    urgency: at <= now.getTime() ? "gone" : "closing",
  };
}

/**
 * A length of time that may run to days.
 *
 * `formatDuration` stops at hours, which is right for a morning and wrong here:
 * "70 hours" is a number to be converted rather than a length of time, so
 * anything past two days is said in days and everything under it keeps the
 * shared wording the countdowns already use.
 */
function remainingText(minutes: number): string {
  if (minutes < 2 * MINUTES_PER_DAY) {
    return formatDuration(minutes);
  }
  return `${Math.floor(minutes / MINUTES_PER_DAY)} days`;
}

/** What is happening, said before the sign-out rather than after it. */
export function sessionExpiryText(expiry: SessionExpiry): string {
  if (expiry.urgency === "gone") {
    return "This phone's sign-in has run out, so BetterWakeUp can no longer reach your account from here.";
  }
  return `This phone's sign-in runs out in ${expiry.inText}, on ${expiry.whenText}, and you will be signed out then.`;
}

/**
 * What signing in again does, which is the part a user cannot be expected to
 * assume: the account is keyed on the identity provider, so the same Apple or
 * Google account finds the same challenge rather than starting a new one.
 */
export const SESSION_RENEWAL_TEXT =
  "Signing in again with the same Apple or Google account picks everything back up: the same challenge, the days you have already kept, and the same deposit.";

/**
 * The press. There is no renew endpoint, so signing in again means signing out
 * first - which is worth doing deliberately now rather than having it happen on
 * a morning with a deadline on it.
 */
export const SESSION_RENEW_LABEL = "Sign in again now";
export const SESSION_RENEW_CONFIRM_LABEL = "Sign out and sign back in";
export const SESSION_RENEW_CANCEL_LABEL = "Not yet";

/**
 * The head of the confirmation. It says why a press about staying signed in
 * signs the user out, because a confirmation that appeared to do the opposite
 * of its label would be dismissed rather than read.
 */
export const SESSION_RENEW_CONSEQUENCE =
  "Signing back in starts here: this signs you out now, and the sign-in screen is the next thing you will see.";

/** The confirmation's whole text: why it signs out, then what that costs. */
export function sessionRenewalConsequence(signOutCost: string | null): string {
  return signOutCost === null
    ? SESSION_RENEW_CONSEQUENCE
    : `${SESSION_RENEW_CONSEQUENCE} ${signOutCost}`;
}
