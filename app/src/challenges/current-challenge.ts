/**
 * What the account is running right now.
 *
 * Every screen behind sign-in is a view of one answer: the account holds a
 * challenge, or it does not. Asking for it lives here rather than in the screen
 * so the four states a read can be in - asking, holding one, holding none, and
 * unable to say - are named once, and so a failed read is a sentence the user
 * can act on rather than a rejected promise.
 *
 * "Holding none" is a real answer and not an error: it is the state of a new
 * account and of every account whose last challenge reached a terminal status.
 */

import type { ChallengeView, EndedChallengeSummary } from "@betterwakeup/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../api/client.ts";
import { ApiError } from "../api/errors.ts";

export type CurrentChallengeState =
  /** The read is in flight, and nothing about the account is known yet. */
  | { readonly status: "loading" }
  /**
   * The server answered. `challenge` is null when the account holds none, and
   * `lastEnded` is how the account learns what happened to the one before: a
   * failure or an expiry is decided by a server sweep the app never hears.
   */
  | {
      readonly status: "loaded";
      readonly challenge: ChallengeView | null;
      readonly lastEnded: EndedChallengeSummary | null;
    }
  | { readonly status: "failed"; readonly message: string };

const NETWORK_MESSAGE = "No connection to BetterWakeUp. Check your network and try again.";
const GENERIC_MESSAGE = "Your challenge could not be loaded. Try again in a moment.";

/**
 * The read, as an outcome. An account with no challenge and an account the app
 * could not ask about are different answers, and a caller that cannot tell them
 * apart would offer to start a second challenge over the top of a live one.
 */
export async function loadCurrentChallenge(
  api: ApiClient,
  options: { signal?: AbortSignal } = {},
): Promise<Exclude<CurrentChallengeState, { status: "loading" }>> {
  try {
    const response = await api.request("getCurrentChallenge", {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    // Both fields are the contract's, and the client parses the body against
    // it, so an answer that reached here has an outcome or an explicit null.
    return { status: "loaded", challenge: response.challenge, lastEnded: response.lastEnded };
  } catch (cause) {
    return { status: "failed", message: messageFor(cause) };
  }
}

export interface CurrentChallenge {
  readonly state: CurrentChallengeState;
  /** Asks again. Used by the retry action and after anything that changes it. */
  reload(): void;
}

/**
 * The read, held for a screen. It runs once per client and again whenever
 * `reload` is called; an answer that arrives after the screen has moved on is
 * dropped rather than written, so a slow first read cannot overwrite a fresh
 * one.
 */
export function useCurrentChallenge(api: ApiClient): CurrentChallenge {
  const [state, setState] = useState<CurrentChallengeState>({ status: "loading" });
  // Only the newest read may write. Held in a ref because the guard has to
  // survive the render that a resolved read triggers.
  const latest = useRef(0);

  const reload = useCallback(() => {
    const mine = latest.current + 1;
    latest.current = mine;
    setState({ status: "loading" });
    void loadCurrentChallenge(api).then((outcome) => {
      if (latest.current === mine) {
        setState(outcome);
      }
    });
  }, [api]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { state, reload };
}

function messageFor(cause: unknown): string {
  if (!(cause instanceof ApiError)) {
    return GENERIC_MESSAGE;
  }
  if (cause.status === null) {
    return NETWORK_MESSAGE;
  }
  return cause.code === "rate_limited"
    ? "Too many attempts. Wait a moment and try again."
    : GENERIC_MESSAGE;
}
