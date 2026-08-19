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
import { waitMessageFor } from "../api/wait-again.ts";

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
  /** A quiet re-read is in flight, with the previous answer still on screen. */
  readonly refreshing: boolean;
  /**
   * The last quiet re-read did not come back. The answer on screen is the one
   * from before it, which is worth saying: the user is looking at a deadline
   * and a day count that may have moved on without them.
   */
  readonly refreshFailed: boolean;
  /** Asks again from scratch. Used by the retry action and after anything that changes it. */
  reload(): void;
  /**
   * Asks again without taking the answer off the screen.
   *
   * Every number home shows is time-sensitive - today's task, its deadline, the
   * day count, whether a recovery offer is still open - so an app that has been
   * sitting in the background has to ask again. Doing that through `reload`
   * would blank a screen the user is already reading, which is why this keeps
   * the last answer up and replaces it only when a better one arrives.
   */
  refresh(): void;
}

/**
 * The read, held for a screen. It runs once per client and again whenever
 * `reload` or `refresh` is called; an answer that arrives after the screen has
 * moved on is dropped rather than written, so a slow first read cannot
 * overwrite a fresh one.
 */
export function useCurrentChallenge(api: ApiClient): CurrentChallenge {
  const [state, setState] = useState<CurrentChallengeState>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  // Only the newest read may write. Held in a ref because the guard has to
  // survive the render that a resolved read triggers.
  const latest = useRef(0);
  // What is on screen, for the quiet path to decide whether there is anything
  // to keep there. Read from a ref so `refresh` does not change identity with
  // every answer, which would resubscribe whatever is driving it.
  const shown = useRef<CurrentChallengeState>(state);
  shown.current = state;

  const reload = useCallback(() => {
    const mine = latest.current + 1;
    latest.current = mine;
    setState({ status: "loading" });
    setRefreshing(false);
    setRefreshFailed(false);
    void loadCurrentChallenge(api).then((outcome) => {
      if (latest.current === mine) {
        setState(outcome);
      }
    });
  }, [api]);

  const refresh = useCallback(() => {
    // Nothing to keep on screen: a first read in flight or a read that failed
    // outright is better served by the loud path, which says what it is doing.
    if (shown.current.status !== "loaded") {
      reload();
      return;
    }
    const mine = latest.current + 1;
    latest.current = mine;
    setRefreshing(true);
    void loadCurrentChallenge(api).then((outcome) => {
      if (latest.current !== mine) {
        return;
      }
      setRefreshing(false);
      // A failed re-read is not an error screen: the user is holding a phone
      // showing a challenge, and taking that away because one request did not
      // land would be a worse answer than the slightly old one.
      if (outcome.status === "failed") {
        setRefreshFailed(true);
        return;
      }
      setRefreshFailed(false);
      setState(outcome);
    });
  }, [api, reload]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { state, refreshing, refreshFailed, reload, refresh };
}

function messageFor(cause: unknown): string {
  if (!(cause instanceof ApiError)) {
    return GENERIC_MESSAGE;
  }
  if (cause.status === null) {
    return NETWORK_MESSAGE;
  }
  return waitMessageFor(cause) ?? GENERIC_MESSAGE;
}
