/**
 * Whether the app asks for a press that cannot work.
 *
 * The contract sorts every error code into `retry` and `reject`, and `reject`
 * means the server answers the same way forever. Until now every command module
 * ended an unrecognised code with "Try again in a moment", so half the codes in
 * the contract were reported to the user as a hiccup. These tests pin the two
 * endings, the codes worded once for every command, and that a command's own
 * table still wins.
 */

import { disclosuresFor } from "@betterwakeup/contract";
import type { ApiClient } from "../src/api/client.ts";
import { ApiError } from "../src/api/errors.ts";
import {
  NO_POINT_TRYING,
  TRY_AGAIN,
  tryAgainMessage,
  unlistedMessage,
} from "../src/api/try-again.ts";
import { startChallenge } from "../src/challenges/create-challenge.ts";
import { loadCurrentChallenge } from "../src/challenges/current-challenge.ts";
import { type ChallengeDraft, createDraft } from "../src/challenges/draft.ts";
import { pauseChallenge } from "../src/challenges/lifecycle-commands.ts";
import { replacePaymentMethod } from "../src/payments/replace-payment-method.ts";
import { challengeView, fakeApi, fundedChallengeView } from "./support/fake-api.ts";

const LEAD = "That did not go through.";
const ZONE = "America/Los_Angeles";

function refused(code: ConstructorParameters<typeof ApiError>[0]): ApiError {
  return new ApiError(code, "operator-facing text", { status: 409 });
}

function readyDraft(): ChallengeDraft {
  return {
    ...createDraft(ZONE),
    timeZoneConfirmed: true,
    depositMinorUnits: 0,
    acknowledgedDisclosures: disclosuresFor(0).map((item) => item.id),
  };
}

describe("unlistedMessage", () => {
  it("keeps the try-again ending for a code the server may answer differently", () => {
    expect(unlistedMessage(refused("internal_error"), LEAD)).toBe(`${LEAD} ${TRY_AGAIN}`);
    expect(tryAgainMessage(LEAD)).toBe(`${LEAD} ${TRY_AGAIN}`);
  });

  it("stops asking for a press a rejected code has already spent", () => {
    // A reject with no shared wording: the app has nowhere to direct the user,
    // and can still stop inviting the press.
    expect(unlistedMessage(refused("task_already_resolved"), LEAD)).toBe(
      `${LEAD} ${NO_POINT_TRYING}`,
    );
  });

  it("reads a validation failure as this build disagreeing with the server", () => {
    const message = unlistedMessage(refused("validation_failed"), LEAD);

    expect(message).toContain("This version of the app");
    expect(message).toContain("Update the app");
    expect(message).not.toContain(TRY_AGAIN);
  });

  it("says a reused request was not run a second time", () => {
    expect(unlistedMessage(refused("idempotency_key_reused"), LEAD)).toContain(
      "was not run a second time",
    );
  });

  it("words the two account-level refusals without a retry", () => {
    expect(unlistedMessage(refused("forbidden"), LEAD)).toBe(
      `${LEAD} Your account is not allowed to do that.`,
    );
    expect(unlistedMessage(refused("not_found"), LEAD)).toContain("no longer on your account");
  });

  it("points a lapsed sign-in at signing in rather than at pressing again", () => {
    expect(unlistedMessage(refused("session_expired"), LEAD)).toContain("Sign in again");
    expect(unlistedMessage(refused("unauthenticated"), LEAD)).toContain("Sign in again");
  });

  it("never repeats the server's own operator-facing message", () => {
    expect(unlistedMessage(refused("forbidden"), LEAD)).not.toContain("operator-facing");
  });
});

describe("the commands that report a refusal", () => {
  it("tells a creation refused by the contract to update rather than to retry", async () => {
    const api = fakeApi({ createChallenge: refused("validation_failed") });

    const outcome = await startChallenge({ api, draft: readyDraft(), projection: null });

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.message).toContain("The challenge could not be created.");
      expect(outcome.message).toContain("Update the app");
      expect(outcome.message).not.toContain(TRY_AGAIN);
    }
  });

  it("keeps a command's own wording for a code it has a better sentence for", async () => {
    const api = fakeApi({ pauseChallenge: refused("challenge_not_paused") });

    const outcome = await pauseChallenge({ api, challenge: challengeView(), confirmed: true });

    expect(outcome).toEqual({
      status: "failed",
      message: "This challenge is already running.",
    });
  });

  it("stops telling a failed read to try again when the read cannot succeed", async () => {
    const api: ApiClient = {
      request: async () => {
        throw refused("forbidden");
      },
    };

    const state = await loadCurrentChallenge(api);

    expect(state).toEqual({
      status: "failed",
      message: "Your challenge could not be loaded. Your account is not allowed to do that.",
    });
  });

  it("names an unusable card rather than inviting the same one again", async () => {
    const api = fakeApi({ replacePaymentMethod: refused("payment_method_invalid") });

    const outcome = await replacePaymentMethod({
      api,
      challenge: fundedChallengeView(),
      providerPaymentMethodId: "pm_test",
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.message).toContain("cannot be used to hold a deposit");
      expect(outcome.message).not.toContain(TRY_AGAIN);
    }
  });
});
