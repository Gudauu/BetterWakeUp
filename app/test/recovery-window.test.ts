/**
 * The window on the Emergency Recovery offer.
 *
 * Letting it close is what charges the deposit, so these tests are about the two
 * things the screens ask of it: how long is left in words a person would say,
 * and whether there is still a decision to offer at all.
 */

import {
  RECOVERY_CLOSING_MINUTES,
  RECOVERY_WINDOW_CLOSED,
  recoveryOfferSummary,
  recoveryWindow,
} from "../src/challenges/recovery-window.ts";
import { challengeView } from "./support/fake-api.ts";

const EXPIRES_AT = "2026-09-02T00:00:00.000Z";

const offered = challengeView({
  status: "recovery_pending",
  recoveryOffer: {
    taskId: "66666666-6666-4666-8666-666666666666",
    offeredAt: "2026-09-01T00:00:00.000Z",
    expiresAt: EXPIRES_AT,
  },
});

/** The window as it reads a given number of minutes before it closes. */
function windowIn(minutes: number) {
  return recoveryWindow(offered, new Date(Date.parse(EXPIRES_AT) - minutes * 60_000));
}

/** The same, for the assertions that read a field of it rather than the whole. */
function windowRequiredIn(minutes: number) {
  const window = windowIn(minutes);
  if (window === null) {
    throw new Error("the fixture holds an offer, so there is a window");
  }
  return window;
}

describe("recoveryWindow", () => {
  it("draws nothing when no offer is open", () => {
    expect(recoveryWindow(challengeView(), new Date(EXPIRES_AT))).toBeNull();
  });

  it("reads a whole morning as hours and minutes rather than as minutes", () => {
    expect(windowIn(150)).toMatchObject({
      urgency: "open",
      minutes: 150,
      decidable: true,
      sentence: "2 hours 30 minutes left to decide.",
    });
  });

  it("turns urgent at the same moment the reminder wakes the user", () => {
    expect(windowIn(RECOVERY_CLOSING_MINUTES + 1)?.urgency).toBe("open");
    expect(windowIn(RECOVERY_CLOSING_MINUTES)?.urgency).toBe("closing");
    expect(windowIn(1)).toMatchObject({ urgency: "closing", sentence: "1 minute left to decide." });
  });

  it("names the last seconds as what they are rather than as zero minutes", () => {
    expect(windowIn(0.5)).toMatchObject({
      urgency: "closing",
      minutes: 0,
      decidable: true,
      sentence: "Less than a minute left to decide.",
    });
  });

  it("stops being decidable the moment the window closes", () => {
    const closed = windowIn(-1);

    expect(closed).toMatchObject({ urgency: "closed", minutes: 0, decidable: false });
    expect(closed?.sentence).toBe(RECOVERY_WINDOW_CLOSED);
  });
});

describe("recoveryOfferSummary", () => {
  it("leads with the time left and follows it with the closing time", () => {
    const summary = recoveryOfferSummary(windowRequiredIn(150), "Tue, Sep 1, 5:00 PM");

    expect(summary).toContain("2 hours 30 minutes left to decide");
    expect(summary).toContain("closes at Tue, Sep 1, 5:00 PM");
  });

  it("reports a closed window as what happened rather than as an invitation", () => {
    const summary = recoveryOfferSummary(windowRequiredIn(-1), "Tue, Sep 1, 5:00 PM");

    expect(summary).toContain("closed at Tue, Sep 1, 5:00 PM");
    expect(summary).toContain("the missed day stands");
    expect(summary).not.toContain("can forgive");
  });
});
