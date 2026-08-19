/**
 * What spending the Emergency Recovery trades away, and what came back.
 *
 * The rule under test is that recovery is a trade rather than a pardon: the
 * missed morning is forgiven and one more morning is appended at the end. These
 * pin the wording of both halves, and that the day named is read from the
 * challenge rather than from the offer, which carries only a task ID.
 */

import {
  missedDay,
  RECOVERY_REPLACEMENT,
  recoveryResult,
  recoveryTrade,
} from "../src/challenges/recovery-outcome.ts";
import { challengeDays, challengeView, taskView } from "./support/fake-api.ts";

const OFFER = {
  taskId: "66666666-6666-4666-8666-666666666666",
  offeredAt: "2026-09-01T00:00:00.000Z",
  expiresAt: "2026-09-02T00:00:00.000Z",
};

/** A challenge in recovery whose row of days marks `index` as the missed one. */
function offered(missedIndices: readonly number[]) {
  const days = challengeDays(30, "completed").map((day, index) =>
    missedIndices.includes(index) ? { ...day, status: "missed" as const } : day,
  );
  return challengeView({ status: "recovery_pending", recoveryOffer: OFFER, days });
}

describe("missedDay", () => {
  it("reads the morning the offer is about off the row of days", () => {
    // The offer carries a task ID and no date, so this is the only place the
    // app can learn which morning it is being asked about.
    expect(missedDay(offered([2]))).toBe("2026-09-03");
  });

  it("answers nothing when no offer stands, so no screen names a day for free", () => {
    expect(missedDay(challengeView({ days: challengeDays(3, "missed") }))).toBeNull();
  });

  it("answers nothing when the row holds no missed day", () => {
    expect(
      missedDay(challengeView({ status: "recovery_pending", recoveryOffer: OFFER })),
    ).toBeNull();
  });

  it("names the last missed day, since an earlier one that was forgiven is not this offer", () => {
    expect(missedDay(offered([1, 7]))).toBe("2026-09-08");
  });
});

describe("recoveryTrade", () => {
  it("names the morning being bought back, the way a person says the date", () => {
    const sentence = recoveryTrade(offered([0]));

    expect(sentence).toMatch(/Tuesday, September 1/);
    expect(sentence).not.toMatch(/2026-09-01/);
    expect(sentence).toMatch(/continues from your next task/);
  });

  it("falls back to the unnamed morning rather than inventing a date", () => {
    expect(
      recoveryTrade(challengeView({ status: "recovery_pending", recoveryOffer: OFFER })),
    ).toMatch(/The missed morning is forgiven/);
  });
});

describe("RECOVERY_REPLACEMENT", () => {
  it("says the challenge gets longer rather than shorter", () => {
    // The half the screen used to leave out: the user is agreeing to walk an
    // extra morning, not to skip one.
    expect(RECOVERY_REPLACEMENT).toMatch(/replacement morning is added/);
    expect(RECOVERY_REPLACEMENT).toMatch(/end date moves later/);
  });

  it("names no date, because the schedule that decides it belongs to the server", () => {
    expect(RECOVERY_REPLACEMENT).not.toMatch(/\d/);
  });
});

describe("recoveryResult", () => {
  const result = () =>
    recoveryResult({
      challenge: challengeView({ projectedEndDate: "2026-10-13" }),
      forgivenTask: taskView({ date: "2026-09-03", status: "forgiven" }),
      appendedTask: taskView({
        date: "2026-10-13",
        deadline: "2026-10-13T14:00:00.000Z",
      }),
    });

  it("names the morning that no longer counts", () => {
    expect(result().forgiven).toMatch(/Thursday, September 3 is forgiven/);
  });

  it("names the morning added and the time it is due, read in the challenge's zone", () => {
    // 14:00Z is 7:00 AM in the fixture's Los Angeles, and naming the morning
    // without its deadline would leave the user to guess when to be up.
    expect(result().appended).toMatch(/added on Tuesday, October 13/);
    expect(result().appended).toMatch(/7:00 AM/);
  });

  it("states where the challenge now ends", () => {
    expect(result().ends).toMatch(/now ends on Tuesday, October 13/);
  });

  it("says the allowance is gone and what the next miss costs", () => {
    expect(result().spent).toMatch(/no second one/);
    expect(result().spent).toMatch(/charges the deposit/);
  });
});
