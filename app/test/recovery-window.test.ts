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
  recoveryOpening,
  recoveryWindow,
} from "../src/challenges/recovery-window.ts";
import { challengeView } from "./support/fake-api.ts";

const OFFERED_AT = "2026-09-01T00:00:00.000Z";
const EXPIRES_AT = "2026-09-02T00:00:00.000Z";

const offered = challengeView({
  status: "recovery_pending",
  recoveryOffer: {
    taskId: "66666666-6666-4666-8666-666666666666",
    offeredAt: OFFERED_AT,
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

describe("recoveryOpening", () => {
  /** The opening as it reads a given number of minutes after the miss. */
  function openingAfter(minutes: number) {
    return recoveryOpening(offered, new Date(Date.parse(OFFERED_AT) + minutes * 60_000));
  }

  it("says nothing when no offer is open", () => {
    expect(recoveryOpening(challengeView(), new Date(OFFERED_AT))).toBeNull();
  });

  it("reads the miss in the challenge's own zone rather than the device's", () => {
    // Midnight UTC is the previous afternoon in the fixture's Los Angeles.
    expect(openingAfter(120)?.openedAt).toBe("Mon, Aug 31, 5:00 PM");
  });

  it("says how long ago the miss was recorded", () => {
    expect(openingAfter(150)?.ago).toBe("2 hours 30 minutes ago");
    expect(openingAfter(0)?.ago).toBe("Less than a minute ago");
  });

  it("measures the whole window from the offer rather than restating a constant", () => {
    expect(openingAfter(120)?.total).toBe("24 hours");
  });

  it("does not report a miss as something still to come on a slow device clock", () => {
    expect(openingAfter(-60)?.ago).toBe("Less than a minute ago");
  });

  it("states the window in the present while it is still running", () => {
    expect(openingAfter(120)?.sentence).toBe(
      "This came up 2 hours ago, when your missed morning was recorded at Mon, Aug 31, 5:00 PM. The window runs 24 hours from then.",
    );
  });

  it("states it in the past once it has closed", () => {
    const sentence = openingAfter(24 * 60)?.sentence;

    expect(sentence).toContain("There were 24 hours to decide.");
    expect(sentence).not.toContain("runs");
  });

  it("counts from nothing when either instant cannot be read", () => {
    const unreadable = challengeView({
      status: "recovery_pending",
      recoveryOffer: {
        taskId: "66666666-6666-4666-8666-666666666666",
        offeredAt: "not an instant",
        expiresAt: EXPIRES_AT,
      },
    });

    expect(recoveryOpening(unreadable, new Date(EXPIRES_AT))).toBeNull();
  });
});
