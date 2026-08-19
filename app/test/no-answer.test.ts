/**
 * What the app says when nothing came back.
 *
 * Six modules used to share one sentence for two different silences. These
 * cases pin that the two are now told apart, and that the wording for a command
 * says the thing a user in that position most needs to hear: pressing again is
 * safe.
 */

import { ApiError } from "../src/api/errors.ts";
import { noAnswerMessage, REQUEST_TIMEOUT_MS } from "../src/api/no-answer.ts";
import { loadCurrentChallenge } from "../src/challenges/current-challenge.ts";
import { pauseChallenge } from "../src/challenges/lifecycle-commands.ts";
import { challengeView, fakeApi } from "./support/fake-api.ts";

function timedOut(): ApiError {
  return new ApiError("internal_error", "BetterWakeUp did not answer in time.", {
    status: null,
    timedOut: true,
  });
}

function unsent(): ApiError {
  return new ApiError("internal_error", "The request did not reach the server.", { status: null });
}

describe("an error that carries no answer", () => {
  it("says nothing when the server did answer, so the caller's own table decides", () => {
    const refused = new ApiError("active_challenge_exists", "Already running.", { status: 409 });

    expect(noAnswerMessage(refused)).toBeNull();
  });

  it("sends a user whose request could not be sent to their network", () => {
    expect(noAnswerMessage(unsent())).toBe(
      "No connection to BetterWakeUp. Check your network and try again.",
    );
  });

  it("does not blame the network for a request that was sent and not answered", () => {
    const message = noAnswerMessage(timedOut());

    expect(message).toContain("did not answer in time");
    expect(message).not.toContain("Check your network");
  });

  it("tells a command's caller that it may have gone through, and that a retry is safe", () => {
    const message = noAnswerMessage(timedOut(), "command");

    expect(message).toContain("may or may not have gone through");
    expect(message).toContain("will not be done twice");
  });

  it("reads a failed send the same way whichever kind of call it was", () => {
    // Nothing was sent, so there is no half-run command to warn anyone about.
    expect(noAnswerMessage(unsent(), "command")).toBe(noAnswerMessage(unsent(), "read"));
  });

  it("waits long enough for a slow morning and short enough to be acted on", () => {
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

describe("the silence reaches the screens", () => {
  it("reports a read that was never answered without mentioning the network", async () => {
    const api = fakeApi({ getCurrentChallenge: () => Promise.reject(timedOut()) });

    const outcome = await loadCurrentChallenge(api);

    expect(outcome).toEqual({
      status: "failed",
      message: expect.stringContaining("did not answer in time"),
    });
  });

  it("tells a user whose pause went unanswered that pressing again is safe", async () => {
    const api = fakeApi({ pauseChallenge: () => Promise.reject(timedOut()) });

    const outcome = await pauseChallenge({ api, challenge: challengeView(), confirmed: true });

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" ? outcome.message : "").toContain("not be done twice");
  });
});
