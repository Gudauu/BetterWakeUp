/**
 * What to say when nothing came back.
 *
 * Every module that talks to the server had the same line for this - "No
 * connection to BetterWakeUp. Check your network and try again." - reached
 * whenever the error carried no HTTP status. That was written for one silence
 * and used for two. A request that could not be sent proves there is no way
 * out of this phone, and telling the user to check their network is exactly
 * right. A request that was sent and never answered proves nothing: the
 * network may be fine and the server slow, and the command may already have
 * run. Sending that user to their Wi-Fi settings is advice about the wrong
 * thing, and telling them the request did not go through can be false.
 *
 * The client cannot tell the two apart from the failure alone, which is why it
 * carries its own clock: a timeout is the app's own decision and is recorded as
 * one on the error it raises.
 */

import type { ApiError } from "./errors.ts";

/**
 * How long the client waits before it stops waiting.
 *
 * Long enough that a slow morning on mobile data is not cut off - the server's
 * own work is milliseconds and the rest is the walk between the phone and it -
 * and short enough that a screen showing a spinner becomes a screen the user
 * can act on while they still have time to walk.
 */
export const REQUEST_TIMEOUT_MS = 20_000;

const NO_CONNECTION = "No connection to BetterWakeUp. Check your network and try again.";

const NO_ANSWER_READ =
  "BetterWakeUp did not answer in time. Your connection may be slow, or the server may be busy. Try again in a moment.";

/**
 * A command may have run before the silence, and every command the app sends
 * carries an idempotency key, so pressing again is safe and cannot do it twice.
 * Saying both is what stops a user pressing nothing for fear of double-paying.
 */
const NO_ANSWER_COMMAND =
  "BetterWakeUp did not answer in time, so this may or may not have gone through. Trying again is safe - it will not be done twice.";

/**
 * The sentence for an error that carries no answer, or null when the server did
 * answer and the caller's own wording should decide.
 */
export function noAnswerMessage(error: ApiError, of: "read" | "command" = "read"): string | null {
  if (error.status !== null) {
    return null;
  }
  if (!error.timedOut) {
    return NO_CONNECTION;
  }
  return of === "command" ? NO_ANSWER_COMMAND : NO_ANSWER_READ;
}
