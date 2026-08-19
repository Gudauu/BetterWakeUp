/**
 * The travelling user.
 *
 * These are about the two questions the app has to answer before it offers to
 * move a challenge: whether the device and the challenge actually disagree, and
 * whether the move pulls deadlines earlier - the direction that can turn today
 * into a missed day.
 */

import { ApiError } from "../src/api/errors.ts";
import {
  changeTimeZone,
  movesDeadlinesEarlier,
  timeZoneLabel,
  timeZoneMoveFor,
} from "../src/challenges/time-zone.ts";
import { challengeView, fakeApi } from "./support/fake-api.ts";

const LOS_ANGELES = "America/Los_Angeles";
const NEW_YORK = "America/New_York";
// Summer, so both zones are on daylight time and the three hour gap is real.
const SUMMER = new Date("2026-09-01T14:00:00.000Z");

function zoned(timeZone: string, overrides: Parameters<typeof challengeView>[0] = {}) {
  const base = challengeView(overrides);
  return { ...base, configuration: { ...base.configuration, timeZone } };
}

describe("noticing the device and the challenge disagree", () => {
  it("offers the move when the device is somewhere else", () => {
    expect(timeZoneMoveFor(zoned(LOS_ANGELES), NEW_YORK)).toEqual({
      from: LOS_ANGELES,
      to: NEW_YORK,
    });
  });

  it("offers nothing when the device is where the challenge already is", () => {
    expect(timeZoneMoveFor(zoned(LOS_ANGELES), LOS_ANGELES)).toBeNull();
  });

  it("offers nothing when the device reports no zone at all", () => {
    // A runtime with no zone data answers an empty string, and asking the
    // server to move a challenge into nowhere would be a refusal the user
    // caused by opening the app.
    expect(timeZoneMoveFor(zoned(LOS_ANGELES), "")).toBeNull();
  });

  it("offers nothing while a recovery decision is open", () => {
    // The server refuses to move instants under a challenge waiting on one
    // decision measured from a missed task, so the app must not offer it.
    expect(
      timeZoneMoveFor(zoned(LOS_ANGELES, { status: "recovery_pending" }), NEW_YORK),
    ).toBeNull();
  });

  it("still offers the move to a paused challenge", () => {
    // The user who travels is the user most likely to be paused.
    const paused = zoned(LOS_ANGELES, {
      pause: { pausedAt: "2026-09-02T00:00:00.000Z", expiresAt: "2027-09-02T00:00:00.000Z" },
    });
    expect(timeZoneMoveFor(paused, NEW_YORK)).not.toBeNull();
  });

  it("reads a zone as the place the user would call it", () => {
    expect(timeZoneLabel(NEW_YORK)).toBe("New York");
    expect(timeZoneLabel("UTC")).toBe("UTC");
  });
});

describe("which way the deadlines move", () => {
  it("is earlier when the user travelled east", () => {
    expect(movesDeadlinesEarlier({ from: LOS_ANGELES, to: NEW_YORK }, SUMMER)).toBe(true);
  });

  it("is later when the user travelled west", () => {
    expect(movesDeadlinesEarlier({ from: NEW_YORK, to: LOS_ANGELES }, SUMMER)).toBe(false);
  });

  it("answers nothing rather than guessing when the zone is unknown", () => {
    expect(movesDeadlinesEarlier({ from: LOS_ANGELES, to: "Mars/Olympus" }, SUMMER)).toBeNull();
  });
});

describe("asking the server to move the challenge", () => {
  it("sends the challenge and the new zone", async () => {
    const api = fakeApi();
    const challenge = zoned(LOS_ANGELES);

    const outcome = await changeTimeZone({ api, challenge, timeZone: NEW_YORK });

    expect(outcome.status).toBe("done");
    expect(api.calls).toEqual([
      {
        name: "changeChallengeTimeZone",
        input: { params: { challengeId: challenge.id }, body: { timeZone: NEW_YORK } },
      },
    ]);
  });

  it("refuses a move to the zone the challenge is already in", async () => {
    const api = fakeApi();

    const outcome = await changeTimeZone({
      api,
      challenge: zoned(LOS_ANGELES),
      timeZone: LOS_ANGELES,
    });

    expect(outcome.status).toBe("blocked");
    // No request at all: a change that changes nothing spends an idempotency
    // key and a rate limit allowance for a screen refresh.
    expect(api.calls).toEqual([]);
  });

  it("says why a challenge that has ended cannot be moved", async () => {
    const api = fakeApi({
      changeChallengeTimeZone: new ApiError("challenge_not_active", "server wording", {
        status: 409,
      }),
    });

    const outcome = await changeTimeZone({
      api,
      challenge: zoned(LOS_ANGELES),
      timeZone: NEW_YORK,
    });

    expect(outcome).toEqual({
      status: "failed",
      message: expect.stringContaining("no longer running"),
    });
  });

  it("names the network rather than the server when there was no answer", async () => {
    const api = fakeApi({
      changeChallengeTimeZone: new ApiError("internal_error", "offline", { status: null }),
    });

    const outcome = await changeTimeZone({
      api,
      challenge: zoned(LOS_ANGELES),
      timeZone: NEW_YORK,
    });

    expect(outcome).toEqual({
      status: "failed",
      message: expect.stringContaining("No connection"),
    });
  });
});
