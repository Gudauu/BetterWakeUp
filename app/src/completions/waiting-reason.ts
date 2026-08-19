/**
 * Why a saved walk has not reached the server yet.
 *
 * The store writes down what went wrong on every failed attempt -
 * `lastErrorCode`, `lastErrorMessage` and the running `attempts` count - and
 * until now nothing read any of it on a record that was still pending. Both
 * surfaces that mention a waiting walk said the same fixed sentence: keep the
 * app open where there is signal. That is good advice for exactly one of the
 * ways an attempt fails. A walk the server itself deferred - a rate limit, or
 * a command it is still working on - reaches the server perfectly well, so
 * telling its owner to go and find signal sends them to fix something that is
 * not broken, on the morning their money is on the line.
 *
 * This module turns a pending record into the two sentences the screens need:
 * why it has not landed, and what (if anything) the person holding the phone
 * can do about it.
 *
 * One ambiguity is deliberately not papered over. The API client raises a
 * request that never left the phone and a server that answered 500 with the
 * same contract code, `internal_error`, because the contract has no code for
 * "no network" - so that reading has to be worded to be true either way rather
 * than guessing which of the two happened.
 */

import type { PendingCompletionRecord } from "./store.ts";
import { RETRY_ATTEMPT_LIMIT } from "./sync.ts";

/** What is holding the walk up, as the app can honestly tell it apart. */
export type WaitingCause =
  /** No attempt has failed yet: the first send is still in the air. */
  | "sending"
  /** The attempt did not get through - no signal here, or none at the server. */
  | "unreached"
  /** The server is limiting how often this phone may send. */
  | "throttled"
  /** The server has this exact command already and is still working on it. */
  | "in-progress";

export interface WaitingReading {
  readonly cause: WaitingCause;
  /**
   * Why it has not landed, or null while the first attempt is still in the
   * air - there is nothing to report until something has failed.
   */
  readonly reason: string | null;
  /** What to do, which is sometimes nothing, and is never a second walk. */
  readonly advice: string;
  /**
   * Whether sync is still counting down to a pass of its own. Past
   * `RETRY_ATTEMPT_LIMIT` it stops holding a timer open and waits for a
   * trigger, so "keep the app open" stops being the thing that sends the walk.
   */
  readonly retryingItself: boolean;
}

const UNREACHED_REASON =
  "The last attempt did not get through - either this phone could not reach " +
  "BetterWakeUp or the server could not take it just then.";

const THROTTLED_REASON =
  "BetterWakeUp is limiting how often this phone can send right now, so the " +
  "walk is queued rather than stuck. Nothing here is wrong.";

const IN_PROGRESS_REASON =
  "The server already has this walk and is still working on it. The app is " +
  "waiting for its answer rather than sending it a second time.";

const SIGNAL_ADVICE =
  "Keep the app open where there is signal - it keeps trying to send it by itself.";

const WAIT_ADVICE =
  "Keep the app open - it sends the walk again by itself, and there is nothing to fix on this phone.";

const TRIGGER_ADVICE =
  "It is no longer retrying on its own clock, so open the app again, or get back " +
  "on a connection, and it goes out straight away.";

function causeOf(code: string | null): WaitingCause {
  switch (code) {
    case null:
      return "sending";
    case "rate_limited":
      return "throttled";
    case "idempotency_in_progress":
      return "in-progress";
    default:
      // Every other code that leaves a record pending is `internal_error`,
      // which the client raises both for a request that never left the phone
      // and for a server that could not answer it.
      return "unreached";
  }
}

/**
 * How the walk this device is holding is getting on, or null when the record
 * is not one that is still trying: a refused record is a different screen's
 * problem and has a reason of its own.
 */
export function waitingReading(record: PendingCompletionRecord): WaitingReading | null {
  if (record.status !== "pending") {
    return null;
  }
  const cause = causeOf(record.lastErrorCode);
  // The record's own count is the number of attempts already made, which is
  // the same number the retry clock reads when it decides to give up.
  const retryingItself = cause === "sending" || record.attempts < RETRY_ATTEMPT_LIMIT;

  if (cause === "sending") {
    return { cause, reason: null, advice: SIGNAL_ADVICE, retryingItself };
  }

  const reason =
    cause === "throttled"
      ? THROTTLED_REASON
      : cause === "in-progress"
        ? IN_PROGRESS_REASON
        : UNREACHED_REASON;
  const advice = !retryingItself
    ? TRIGGER_ADVICE
    : cause === "unreached"
      ? SIGNAL_ADVICE
      : WAIT_ADVICE;
  return { cause, reason, advice, retryingItself };
}

/**
 * How many times it has been tried, said as a sentence, or null below two.
 *
 * One failed attempt is ordinary and saying so is noise. A count only starts
 * meaning something once it is a pattern, and it is what makes the difference
 * between "this is taking a moment" and "this has been going on all morning"
 * visible without the user having to sit and watch the screen.
 */
export function attemptsText(record: PendingCompletionRecord): string | null {
  if (record.status !== "pending" || record.attempts < 2) {
    return null;
  }
  return `Tried ${record.attempts} times so far.`;
}
