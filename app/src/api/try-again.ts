/**
 * Whether trying again is worth anything, said to the user.
 *
 * Every command module in the app ends its error wording the same way: a code
 * it recognises gets a sentence of its own, and everything else gets a generic
 * line ending "Try again in a moment." That advice is right for exactly one
 * kind of failure. The contract sorts every error code into `retry` and
 * `reject`, and `reject` means the server will answer the same way forever, so
 * a user told to try again in a moment is being sent back to press a button
 * that cannot work.
 *
 * The disposition is already on `ApiError`, put there for the pending
 * completion store. This module is where it decides what a person is told,
 * along with a sentence for the handful of codes any command can meet and no
 * command wants to word twice.
 *
 * A caller's own table still wins: `not_found` on a card replacement is "This
 * challenge is no longer on your account", which is worth more than the general
 * form. What this module answers is the case that had no wording anywhere.
 */

import type { ErrorCode } from "@betterwakeup/contract";
import type { ApiError } from "./errors.ts";

/** Said after the lead when another attempt may genuinely answer differently. */
export const TRY_AGAIN = "Try again in a moment.";

/**
 * Said after the lead when the code's disposition is `reject`. It stops short
 * of naming a way out, because a code the app has no sentence for is one it
 * cannot give directions about; what it can honestly do is stop asking for a
 * press that is already spent.
 */
export const NO_POINT_TRYING = "Trying again will not change it.";

/** The retryable form, so a module's generic line is written once. */
export function tryAgainMessage(lead: string): string {
  return `${lead} ${TRY_AGAIN}`;
}

/**
 * The codes any command can be refused with, worded once.
 *
 * `validation_failed` is the one worth naming precisely: on a command path it
 * never means the user typed something wrong (the app assembles every request
 * body itself and the server parses it against the contract), it means this
 * build and the server disagree about the contract. That is an update, not a
 * retry, and the difference is invisible from the generic line.
 */
const ADVICE: Partial<Record<ErrorCode, string>> = {
  validation_failed:
    "This version of the app sent something BetterWakeUp would not accept, and another attempt would send the same thing. Update the app if an update is waiting, and get in touch if that does not help.",
  idempotency_key_reused:
    "That request had already been used for something else, so it was not run a second time. Go back to home and start it again.",
  forbidden: "Your account is not allowed to do that.",
  not_found: "It is no longer on your account, so there was nothing to change.",
  unauthenticated: "Sign in again and try once more.",
  session_expired: "Your sign-in ran out. Sign in again and try once more.",
};

/**
 * The message for a code the caller's own table does not list.
 *
 * `lead` is the caller's sentence for what failed - "The challenge could not be
 * created." - which is the half only the caller knows. What follows is the half
 * only the code knows.
 */
export function unlistedMessage(error: ApiError, lead: string): string {
  const advice = ADVICE[error.code] ?? (error.retryable ? TRY_AGAIN : NO_POINT_TRYING);
  return `${lead} ${advice}`;
}
