/**
 * How long the server said to wait, said to the user.
 *
 * Two of the contract's error codes carry their own answer to "when can I try
 * again": `rate_limited` names the seconds left in the allowance's window, and
 * `idempotency_in_progress` names the seconds left on the lease the first
 * attempt still holds. Both arrive on the response, both are parsed into
 * `ApiError.retryAfterSeconds`, and until now every screen in the app answered
 * them with the same shrug - "Wait a moment and try again."
 *
 * A moment is the wrong word for both of them. The pause and payment
 * allowances are counted over an hour, so the wait after ten presses can be
 * three quarters of an hour, and a user told to wait a moment will press again
 * immediately, be refused again, and read the app as broken. The number is
 * already on the wire; this module is the only place that words it.
 *
 * `leaseExpiresAt` is deliberately unused: it is the same instant expressed
 * absolutely, and a duration is what a sentence about waiting needs. Reading
 * the instant instead would also make the wording depend on the device's clock
 * agreeing with the server's, which for a five second lease it may not.
 */

import { formatDuration } from "../ui/format.ts";
import type { ApiError } from "./errors.ts";

/** Said when the server named no wait at all, which is its right on any code. */
export const UNKNOWN_WAIT = "Wait a moment and try again.";

/**
 * The wait as an instruction. Sub-minute waits are said in seconds, because
 * the shared `formatDuration` reads anything under a minute as "Less than a
 * minute" - true, and useless when the honest answer is eight seconds.
 * Anything longer is rounded up to whole minutes, so the app never invites a
 * press the server would still refuse.
 */
export function waitSentence(seconds: number | undefined): string {
  if (seconds === undefined || seconds <= 0) {
    return UNKNOWN_WAIT;
  }
  if (seconds < 60) {
    return `Try again in ${seconds === 1 ? "1 second" : `${seconds} seconds`}.`;
  }
  return `Try again in ${formatDuration(Math.ceil(seconds / 60))}.`;
}

/** The usual lead for a refused allowance. Sign-in has its own, being specific. */
export const TOO_MANY_ATTEMPTS = "Too many attempts.";

/**
 * The message for the two codes that carry a wait, or null for every other
 * code, so a caller keeps its own table for everything else.
 *
 * `idempotency_in_progress` is not the user's mistake and is not a failure:
 * their command is running, and the retry collects its result rather than
 * doing it a second time. Saying so is what stops a user from assuming the
 * press did nothing and building the same challenge again.
 */
export function waitMessageFor(error: ApiError, lead: string = TOO_MANY_ATTEMPTS): string | null {
  if (error.code === "rate_limited") {
    return `${lead} ${waitSentence(error.retryAfterSeconds)}`;
  }
  if (error.code === "idempotency_in_progress") {
    return `That is still going through. ${waitSentence(error.retryAfterSeconds)} It cannot happen twice.`;
  }
  return null;
}
