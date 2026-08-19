/**
 * Waiting for the bank.
 *
 * A funded challenge is not created by the request the app makes. The app
 * authorizes a hold, the provider confirms it out of band, and the challenge
 * appears when the server's webhook lands - which is why the contract's own
 * funding response carries `pollAfterAuthorization`. Somebody has to do that
 * polling, and until now nobody did: the app authorized the hold and then sat
 * on a screen that never changed, so a user who had just staked money was left
 * to guess whether anything had happened.
 *
 * The loop is here rather than in the screen so the thing that decides how long
 * to wait, and what "still nothing" means, can be tested without rendering
 * anything and without waiting in real time.
 */

import type { ChallengeView } from "@betterwakeup/contract";
import type { ApiClient } from "../api/client.ts";
import { loadCurrentChallenge } from "./current-challenge.ts";

export type FundedChallengeOutcome =
  /** The webhook landed: this is the challenge the hold paid for. */
  | { readonly status: "created"; readonly challenge: ChallengeView }
  /**
   * Every attempt was spent and the account still holds no challenge. Not a
   * failure: a hold can take longer than any wait worth making a user sit
   * through, so this is the state the screen offers to check again from.
   */
  | { readonly status: "pending" }
  /** The last read did not come back. The user is told, and can try again. */
  | { readonly status: "failed"; readonly message: string };

export interface AwaitFundedChallengeOptions {
  /** Reads, including the immediate first one. */
  readonly attempts?: number;
  readonly intervalMs?: number;
  /** Replaced in tests so a wait of half a minute takes no time at all. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Aborted when the screen goes away, so a wait cannot outlive it. */
  readonly signal?: AbortSignal;
}

const DEFAULT_ATTEMPTS = 10;
const DEFAULT_INTERVAL_MS = 1500;

export async function awaitFundedChallenge(
  api: ApiClient,
  options: AwaitFundedChallengeOptions = {},
): Promise<FundedChallengeOutcome> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const sleep = options.sleep ?? ((ms: number) => defaultSleep(ms, options.signal));

  let last: FundedChallengeOutcome = { status: "pending" };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await sleep(intervalMs);
    }
    if (options.signal?.aborted === true) {
      return { status: "pending" };
    }
    const state = await loadCurrentChallenge(
      api,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    if (state.status === "loaded" && state.challenge !== null) {
      return { status: "created", challenge: state.challenge };
    }
    // A read that did not come back is worth retrying - the hold is placed
    // either way - but if it is the last word the user hears it rather than
    // being told to keep waiting for something the app cannot see.
    last = state.status === "failed" ? { status: "failed", message: state.message } : last;
    last = state.status === "loaded" ? { status: "pending" } : last;
  }
  return last;
}

/**
 * A wait that ends when the screen does. Without the abort the app would hold a
 * timer for a screen that is no longer there, which a test runner reports as a
 * process that would not settle.
 */
function defaultSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
