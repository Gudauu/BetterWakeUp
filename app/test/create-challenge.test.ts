/**
 * Starting a challenge: which door is taken, and what has to be true before
 * either one opens.
 *
 * The assertions that matter here are about requests that were never made. A
 * blocked start must reach no endpoint at all, and a zero deposit challenge
 * must never touch the funding intent, which is the payment boundary.
 */

import {
  DISCLOSURE_POLICY_VERSION,
  disclosuresFor,
  MAXIMUM_CHALLENGE_DURATION_DAYS,
} from "@betterwakeup/contract";
import { ApiError } from "../src/api/errors.ts";
import { projectChallenge, startChallenge } from "../src/challenges/create-challenge.ts";
import { type ChallengeDraft, createDraft } from "../src/challenges/draft.ts";
import { challengeView, FUNDING_INTENT, fakeApi, PROJECTION } from "./support/fake-api.ts";

const ZONE = "America/Los_Angeles";

function readyDraft(depositMinorUnits = 0): ChallengeDraft {
  return {
    ...createDraft(ZONE),
    timeZoneConfirmed: true,
    depositMinorUnits,
    acknowledgedDisclosures: disclosuresFor(depositMinorUnits).map((item) => item.id),
  };
}

describe("the deposit action is unreachable until disclosures are acknowledged", () => {
  it("refuses without reaching the server when a disclosure is outstanding", async () => {
    const draft = readyDraft(2000);
    const api = fakeApi();

    const outcome = await startChallenge({
      api,
      draft: { ...draft, acknowledgedDisclosures: draft.acknowledgedDisclosures.slice(1) },
      projection: PROJECTION,
    });

    expect(outcome.status).toBe("blocked");
    expect(api.calls).toHaveLength(0);
  });

  it("names the statements the user has not acknowledged", async () => {
    const outcome = await startChallenge({
      api: fakeApi(),
      draft: { ...readyDraft(2000), acknowledgedDisclosures: [] },
      projection: PROJECTION,
    });

    expect(outcome.status === "blocked" && outcome.reasons).toEqual(
      expect.arrayContaining(disclosuresFor(2000).map((item) => item.statement)),
    );
  });

  it("refuses without reaching the server while the time zone is unconfirmed", async () => {
    const api = fakeApi();

    const outcome = await startChallenge({
      api,
      draft: { ...readyDraft(2000), timeZoneConfirmed: false },
      projection: PROJECTION,
    });

    expect(outcome.status).toBe("blocked");
    expect(api.calls).toHaveLength(0);
  });
});

describe("the zero deposit path", () => {
  it("creates the challenge with no payment step at all", async () => {
    const api = fakeApi({ createChallenge: { challenge: challengeView() } });

    const outcome = await startChallenge({ api, draft: readyDraft(), projection: PROJECTION });

    expect(outcome.status).toBe("created");
    expect(api.names()).toEqual(["createChallenge"]);
    expect(api.names()).not.toContain("createFundingIntent");
  });

  it("sends the version of the disclosures the user was shown", async () => {
    const api = fakeApi();

    await startChallenge({ api, draft: readyDraft(), projection: PROJECTION });

    expect(api.calls[0]?.input).toMatchObject({
      body: { policyVersion: DISCLOSURE_POLICY_VERSION },
    });
  });

  it("does not need a projection, since the maximum duration is a funded rule", async () => {
    const api = fakeApi();

    const outcome = await startChallenge({ api, draft: readyDraft(), projection: null });

    expect(outcome.status).toBe("created");
  });
});

describe("the funded path", () => {
  it("authorizes a hold rather than creating a challenge", async () => {
    const api = fakeApi();

    const outcome = await startChallenge({ api, draft: readyDraft(2000), projection: PROJECTION });

    expect(outcome).toEqual({ status: "fundingRequired", intent: FUNDING_INTENT });
    expect(api.names()).toEqual(["createFundingIntent"]);
  });

  it("will not deposit before the projected end date is known", async () => {
    const api = fakeApi();

    const outcome = await startChallenge({ api, draft: readyDraft(2000), projection: null });

    expect(outcome.status).toBe("blocked");
    expect(api.calls).toHaveLength(0);
  });

  it("will not deposit when the plan runs past the maximum duration", async () => {
    const api = fakeApi();

    const outcome = await startChallenge({
      api,
      draft: readyDraft(2000),
      projection: { ...PROJECTION, withinMaximumDuration: false },
    });

    expect(outcome.status === "blocked" && outcome.reasons.join(" ")).toContain(
      String(MAXIMUM_CHALLENGE_DURATION_DAYS),
    );
    expect(api.calls).toHaveLength(0);
  });

  it("lets the same schedule run with no deposit", async () => {
    // The maximum duration exists to bound renewal risk, and a challenge with
    // no hold has none.
    const api = fakeApi();

    const outcome = await startChallenge({
      api,
      draft: readyDraft(),
      projection: { ...PROJECTION, withinMaximumDuration: false },
    });

    expect(outcome.status).toBe("created");
  });
});

describe("what the user is told when the server refuses", () => {
  it("turns a known code into a sentence about their situation", async () => {
    const api = fakeApi({
      createChallenge: new ApiError("active_challenge_exists", "one at a time", { status: 409 }),
    });

    const outcome = await startChallenge({ api, draft: readyDraft(), projection: PROJECTION });

    expect(outcome.status === "failed" && outcome.message).toContain("already have a challenge");
  });

  it("tells a network failure apart from a refusal", async () => {
    const api = fakeApi({
      createChallenge: new ApiError("internal_error", "did not reach", { status: null }),
    });

    const outcome = await startChallenge({ api, draft: readyDraft(), projection: PROJECTION });

    expect(outcome.status === "failed" && outcome.message).toContain("No connection");
  });

  it("keeps an operator's message out of the user's sentence", async () => {
    const api = fakeApi({
      createChallenge: new ApiError("internal_error", "connection pool exhausted", { status: 500 }),
    });

    const outcome = await startChallenge({ api, draft: readyDraft(), projection: PROJECTION });

    expect(outcome.status === "failed" && outcome.message).not.toContain("connection pool");
  });
});

describe("the projection", () => {
  it("asks the server for the configuration on screen", async () => {
    const api = fakeApi();

    const outcome = await projectChallenge(api, readyDraft());

    expect(outcome).toEqual({ status: "projected", projection: PROJECTION });
    expect(api.names()).toEqual(["createChallengeProjection"]);
  });

  it("asks nothing while the configuration is invalid", async () => {
    const api = fakeApi();

    expect(await projectChallenge(api, { ...readyDraft(), schedule: [] })).toEqual({
      status: "unconfigured",
    });
    expect(api.calls).toHaveLength(0);
  });

  it("reports a failure rather than throwing", async () => {
    // A projection the app could not fetch has to block a deposit, not crash a
    // screen that is being typed into.
    const api = fakeApi({
      createChallengeProjection: new ApiError("internal_error", "boom", { status: 500 }),
    });

    const outcome = await projectChallenge(api, readyDraft());

    expect(outcome.status).toBe("unavailable");
    expect(outcome.status === "unavailable" && outcome.message).toMatch(
      /could not be worked out just now/,
    );
  });

  it("names a request that never reached the server as a connection problem", async () => {
    // The difference matters to the user: one is worth retrying where there is
    // signal, and the other is worth retrying in a minute.
    const api = fakeApi({
      createChallengeProjection: new ApiError("internal_error", "offline", { status: null }),
    });

    const outcome = await projectChallenge(api, readyDraft());

    expect(outcome.status === "unavailable" && outcome.message).toMatch(/No connection/);
  });

  it("separates a server that never answered from a phone with no connection", async () => {
    const api = fakeApi({
      createChallengeProjection: new ApiError("internal_error", "no answer", {
        status: null,
        timedOut: true,
      }),
    });

    const outcome = await projectChallenge(api, readyDraft());

    const message = outcome.status === "unavailable" ? outcome.message : "";
    expect(message).toMatch(/did not answer in time/);
    expect(message).not.toMatch(/No connection/);
  });

  it("does not repeat the server's own words to the user", async () => {
    const api = fakeApi({
      createChallengeProjection: new ApiError("internal_error", "connection pool exhausted", {
        status: 500,
      }),
    });

    const outcome = await projectChallenge(api, readyDraft());

    expect(outcome.status === "unavailable" && outcome.message).not.toContain("connection pool");
  });
});
