/**
 * The wait the server named, as the user is told it.
 *
 * The pause and payment allowances are counted over a whole hour, so the
 * distance between "wait a moment" and what the server actually means can be
 * three quarters of an hour. These tests pin the two codes that carry a wait
 * and, at the bottom, that a command's own error table still wins for every
 * other code.
 */

import type { ApiClient } from "../src/api/client.ts";
import { ApiError } from "../src/api/errors.ts";
import {
  TOO_MANY_ATTEMPTS,
  UNKNOWN_WAIT,
  waitMessageFor,
  waitSentence,
} from "../src/api/wait-again.ts";
import { signInWithProvider } from "../src/auth/sign-in.ts";
import { pauseChallenge } from "../src/challenges/lifecycle-commands.ts";
import { challengeView, fakeApi } from "./support/fake-api.ts";
import { appleCredential, fakeProvider } from "./support/fake-providers.ts";

function limited(seconds?: number): ApiError {
  return new ApiError("rate_limited", "Too many requests. Try again shortly.", {
    status: 429,
    ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }),
  });
}

describe("waitSentence", () => {
  it("says a sub-minute wait in seconds, where formatDuration would say less than a minute", () => {
    expect(waitSentence(8)).toBe("Try again in 8 seconds.");
    expect(waitSentence(59)).toBe("Try again in 59 seconds.");
  });

  it("words a single second singly", () => {
    expect(waitSentence(1)).toBe("Try again in 1 second.");
  });

  it("rounds a longer wait up to whole minutes, so no press is invited early", () => {
    expect(waitSentence(60)).toBe("Try again in 1 minute.");
    expect(waitSentence(61)).toBe("Try again in 2 minutes.");
    expect(waitSentence(2820)).toBe("Try again in 47 minutes.");
    expect(waitSentence(3600)).toBe("Try again in 1 hour.");
  });

  it("shrugs when the server named no wait at all", () => {
    expect(waitSentence(undefined)).toBe(UNKNOWN_WAIT);
    expect(waitSentence(0)).toBe(UNKNOWN_WAIT);
  });
});

describe("waitMessageFor", () => {
  it("puts the caller's lead in front of the wait", () => {
    expect(waitMessageFor(limited(45))).toBe(`${TOO_MANY_ATTEMPTS} Try again in 45 seconds.`);
    expect(waitMessageFor(limited(45), "Too many sign-in attempts.")).toBe(
      "Too many sign-in attempts. Try again in 45 seconds.",
    );
  });

  it("falls back to the shrug when a rate limit carries no number", () => {
    expect(waitMessageFor(limited())).toBe(`${TOO_MANY_ATTEMPTS} ${UNKNOWN_WAIT}`);
  });

  it("says a command already running is running, not failed", () => {
    const inProgress = new ApiError("idempotency_in_progress", "lease held", {
      status: 409,
      retryAfterSeconds: 5,
    });

    expect(waitMessageFor(inProgress)).toBe(
      "That is still going through. Try again in 5 seconds. It cannot happen twice.",
    );
  });

  it("answers nothing for a code that carries no wait", () => {
    expect(
      waitMessageFor(new ApiError("challenge_not_active", "gone", { status: 409 })),
    ).toBeNull();
  });
});

describe("the commands that report a wait", () => {
  it("tells a rate-limited pause how long the hour's allowance has left", async () => {
    const api = fakeApi({ pauseChallenge: limited(2820) });

    const outcome = await pauseChallenge({ api, challenge: challengeView(), confirmed: true });

    expect(outcome).toEqual({
      status: "failed",
      message: "Too many attempts. Try again in 47 minutes.",
    });
  });

  it("keeps sign-in's own wording for the attempts it counts", async () => {
    const api: ApiClient = {
      request: async () => {
        throw limited(90);
      },
    };

    const outcome = await signInWithProvider({
      api,
      provider: fakeProvider({ result: appleCredential() }),
    });

    expect(outcome).toEqual({
      status: "failed",
      message: "Too many sign-in attempts. Try again in 2 minutes.",
    });
  });
});
