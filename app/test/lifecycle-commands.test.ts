/**
 * The pause, resume, recovery, and deletion commands.
 *
 * The other half of issue 33's acceptance boundary: every irreversible action
 * requires explicit confirmation. Each of those tests asserts on requests that
 * were never made, which is the only assertion that establishes the gate lives
 * in the command rather than in a button's visibility.
 */

import type { ChallengeView } from "@betterwakeup/contract";
import { ApiError } from "../src/api/errors.ts";
import {
  acceptRecovery,
  DELETION_CONFIRMATION_REQUIRED,
  deleteAccount,
  deletionBlocker,
  FUNDED_CHALLENGE_HOLDS_DELETION,
  PAUSE_CONFIRMATION_REQUIRED,
  pauseChallenge,
  RECOVERY_CONFIRMATION_REQUIRED,
  RECOVERY_EXPIRED,
  resumeChallenge,
} from "../src/challenges/lifecycle-commands.ts";
import { challengeView, fakeApi } from "./support/fake-api.ts";

const NOW = new Date("2026-09-01T13:00:00.000Z");
const OFFER_TASK_ID = "66666666-6666-4666-8666-666666666666";

function funded(overrides: Partial<ChallengeView> = {}): ChallengeView {
  return challengeView({
    configuration: { ...challengeView().configuration, deposit: { amount: 5000, currency: "USD" } },
    ...overrides,
  });
}

function withOffer(expiresAt: string): ChallengeView {
  return challengeView({
    status: "recovery_pending",
    recoveryOffer: { taskId: OFFER_TASK_ID, offeredAt: "2026-09-01T00:00:00.000Z", expiresAt },
  });
}

describe("pauseChallenge", () => {
  it("makes no request at all without an explicit confirmation", async () => {
    const api = fakeApi();

    const outcome = await pauseChallenge({ api, challenge: challengeView(), confirmed: false });

    expect(outcome).toEqual({ status: "blocked", reasons: [PAUSE_CONFIRMATION_REQUIRED] });
    expect(api.names()).toEqual([]);
  });

  it("pauses once confirmed and returns the task the pause consumed", async () => {
    const api = fakeApi();

    const outcome = await pauseChallenge({ api, challenge: challengeView(), confirmed: true });

    expect(outcome.status).toBe("done");
    expect(api.names()).toEqual(["pauseChallenge"]);
    expect(api.calls[0]?.input).toMatchObject({
      params: { challengeId: challengeView().id },
      body: {},
    });
  });

  it("reports a cutoff that passed in the user's own terms", async () => {
    const api = fakeApi({
      pauseChallenge: new ApiError("pause_cutoff_passed", "too late", { status: 409 }),
    });

    const outcome = await pauseChallenge({ api, challenge: challengeView(), confirmed: true });

    expect(outcome).toEqual({
      status: "failed",
      message: "It is too late to pause out of the next task. It stays live.",
    });
  });

  it("tells an unreachable server apart from a refusal", async () => {
    const api = fakeApi({
      pauseChallenge: new ApiError("internal_error", "offline", { status: null }),
    });

    const outcome = await pauseChallenge({ api, challenge: challengeView(), confirmed: true });

    expect(outcome).toEqual({
      status: "failed",
      message: "No connection to BetterWakeUp. Check your network and try again.",
    });
  });
});

describe("resumeChallenge", () => {
  it("needs no confirmation, because nothing is given up by resuming", async () => {
    const api = fakeApi();

    const outcome = await resumeChallenge({ api, challenge: challengeView() });

    expect(outcome.status).toBe("done");
    expect(api.names()).toEqual(["resumeChallenge"]);
  });
});

describe("acceptRecovery", () => {
  it("spends nothing without an explicit confirmation", async () => {
    const api = fakeApi();

    const outcome = await acceptRecovery({
      api,
      challenge: withOffer("2026-09-02T00:00:00.000Z"),
      confirmed: false,
      now: NOW,
    });

    expect(outcome).toEqual({ status: "blocked", reasons: [RECOVERY_CONFIRMATION_REQUIRED] });
    expect(api.names()).toEqual([]);
  });

  it("sends the offer's own task, so a stale offer cannot be accepted", async () => {
    const api = fakeApi();

    await acceptRecovery({
      api,
      challenge: withOffer("2026-09-02T00:00:00.000Z"),
      confirmed: true,
      now: NOW,
    });

    expect(api.calls[0]?.input).toMatchObject({ body: { taskId: OFFER_TASK_ID } });
  });

  it("refuses an expired offer before it can spend the allowance", async () => {
    const api = fakeApi();

    const outcome = await acceptRecovery({
      api,
      challenge: withOffer("2026-09-01T12:00:00.000Z"),
      confirmed: true,
      now: NOW,
    });

    expect(outcome).toEqual({ status: "blocked", reasons: [RECOVERY_EXPIRED] });
    expect(api.names()).toEqual([]);
  });

  it("refuses when no offer is open", async () => {
    const api = fakeApi();

    const outcome = await acceptRecovery({
      api,
      challenge: challengeView(),
      confirmed: true,
      now: NOW,
    });

    expect(outcome.status).toBe("blocked");
    expect(api.names()).toEqual([]);
  });

  it("says the allowance is gone when the server says so", async () => {
    const api = fakeApi({
      acceptRecovery: new ApiError("recovery_already_consumed", "spent", { status: 409 }),
    });

    const outcome = await acceptRecovery({
      api,
      challenge: withOffer("2026-09-02T00:00:00.000Z"),
      confirmed: true,
      now: NOW,
    });

    expect(outcome).toEqual({
      status: "failed",
      message: "Your one Emergency Recovery has already been used.",
    });
  });
});

describe("deleteAccount", () => {
  it("deletes nothing without an explicit confirmation", async () => {
    const api = fakeApi();

    const outcome = await deleteAccount({ api, challenge: null, confirmed: false });

    expect(outcome).toEqual({ status: "blocked", reasons: [DELETION_CONFIRMATION_REQUIRED] });
    expect(api.names()).toEqual([]);
  });

  it("deletes an account that holds no challenge", async () => {
    const api = fakeApi();

    const outcome = await deleteAccount({ api, challenge: null, confirmed: true });

    expect(outcome).toEqual({ status: "done", value: null });
    expect(api.names()).toEqual(["deleteAccount"]);
  });

  it("says why an unsettled funded challenge holds deletion, before confirming anything", async () => {
    const api = fakeApi();

    const outcome = await deleteAccount({ api, challenge: funded(), confirmed: true });

    expect(outcome).toEqual({ status: "blocked", reasons: [FUNDED_CHALLENGE_HOLDS_DELETION] });
    expect(api.names()).toEqual([]);
  });

  it("lets a zero deposit challenge be deleted, because nothing has to settle", async () => {
    const api = fakeApi();

    const outcome = await deleteAccount({ api, challenge: challengeView(), confirmed: true });

    expect(outcome.status).toBe("done");
    expect(api.names()).toEqual(["deleteAccount"]);
  });

  it("lets a settled funded challenge be deleted", () => {
    expect(deletionBlocker(funded({ status: "failed" }))).toBeNull();
    expect(deletionBlocker(funded({ status: "succeeded" }))).toBeNull();
    expect(deletionBlocker(funded({ status: "expired" }))).toBeNull();
    expect(deletionBlocker(funded({ status: "recovery_pending" }))).toBe(
      FUNDED_CHALLENGE_HOLDS_DELETION,
    );
  });
});
