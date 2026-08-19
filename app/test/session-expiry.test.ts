/**
 * The sign-in that is about to run out.
 *
 * A session lasts thirty days and nothing renews one, so the expiry the app has
 * held since sign-in decides the morning a user is thrown out of a running
 * challenge. It was read once, at launch, to discard a session that had already
 * died. These pin the notice that arrives before that: when it runs out, how
 * long that is, and the two cases where the app says nothing at all.
 */

import type { SessionView } from "@betterwakeup/contract";
import {
  SESSION_RENEW_CONSEQUENCE,
  SESSION_WARNING_DAYS,
  sessionExpiry,
  sessionExpiryText,
  sessionRenewalConsequence,
} from "../src/session/session-expiry.ts";

const LOS_ANGELES = "America/Los_Angeles";

function session(expiresAt: string): SessionView {
  return {
    accountId: "11111111-1111-4111-8111-111111111111",
    token: "session-token",
    expiresAt,
  };
}

/** Minutes before an instant, as an instant. */
function minutesBefore(instant: string, minutes: number): Date {
  return new Date(Date.parse(instant) - minutes * 60_000);
}

const EXPIRES_AT = "2026-09-04T22:00:00.000Z";

/** The reading, for the cases that are about its wording rather than its absence. */
function readingAt(now: Date, timeZone = LOS_ANGELES) {
  const expiry = sessionExpiry(session(EXPIRES_AT), now, timeZone);
  if (expiry === null) {
    throw new Error("expected the sign-in to be worth mentioning at this moment");
  }
  return expiry;
}

describe("whether the sign-in is worth mentioning", () => {
  it("says nothing while it is further off than the warning window", () => {
    const expiry = sessionExpiry(
      session(EXPIRES_AT),
      minutesBefore(EXPIRES_AT, SESSION_WARNING_DAYS * 24 * 60 + 1),
      LOS_ANGELES,
    );

    expect(expiry).toBeNull();
  });

  it("speaks up on the boundary itself", () => {
    const expiry = sessionExpiry(
      session(EXPIRES_AT),
      minutesBefore(EXPIRES_AT, SESSION_WARNING_DAYS * 24 * 60),
      LOS_ANGELES,
    );

    expect(expiry?.urgency).toBe("closing");
    expect(expiry?.inText).toBe("3 days");
  });

  it("says nothing about an expiry it cannot read, rather than counting down to a guess", () => {
    expect(sessionExpiry(session("whenever"), new Date(EXPIRES_AT), LOS_ANGELES)).toBeNull();
  });
});

describe("how long is left", () => {
  it("reads the last day in hours rather than as a day it has not reached", () => {
    const expiry = sessionExpiry(
      session(EXPIRES_AT),
      minutesBefore(EXPIRES_AT, 20 * 60),
      LOS_ANGELES,
    );

    expect(expiry?.inText).toBe("20 hours");
  });

  it("says days once there are two of them, because hours stop being a length of time", () => {
    const expiry = sessionExpiry(
      session(EXPIRES_AT),
      minutesBefore(EXPIRES_AT, 50 * 60),
      LOS_ANGELES,
    );

    expect(expiry?.inText).toBe("2 days");
  });

  it("counts whole minutes and floors them, so nothing rounds up into more time than there is", () => {
    const expiry = sessionExpiry(
      session(EXPIRES_AT),
      new Date(Date.parse(EXPIRES_AT) - 90_500),
      LOS_ANGELES,
    );

    expect(expiry?.minutesLeft).toBe(1);
    expect(expiry?.inText).toBe("1 minute");
  });
});

describe("when it runs out", () => {
  it("names the moment in the zone the device is standing in", () => {
    const expiry = readingAt(minutesBefore(EXPIRES_AT, 60));

    expect(sessionExpiryText(expiry)).toBe(
      "This phone's sign-in runs out in 1 hour, on Fri, Sep 4, 3:00 PM, and you will be signed out then.",
    );
  });

  it("reads the same instant on the clock of wherever the phone actually is", () => {
    const expiry = sessionExpiry(session(EXPIRES_AT), minutesBefore(EXPIRES_AT, 60), "Asia/Tokyo");

    expect(expiry?.whenText).toBe("Sat, Sep 5, 7:00 AM");
  });
});

describe("an expiry that has already passed under an open app", () => {
  it("reports it as gone rather than as a countdown to a moment behind it", () => {
    const expiry = readingAt(new Date(Date.parse(EXPIRES_AT) + 60_000));

    expect(expiry.urgency).toBe("gone");
    expect(expiry.minutesLeft).toBe(0);
    expect(sessionExpiryText(expiry)).toBe(
      "This phone's sign-in has run out, so BetterWakeUp can no longer reach your account from here.",
    );
  });
});

describe("what the press to sign in again admits it will do", () => {
  it("leads with the sign-out, because the label says the opposite", () => {
    expect(sessionRenewalConsequence(null)).toBe(SESSION_RENEW_CONSEQUENCE);
  });

  it("carries what a sign-out costs, rather than wording it a second time", () => {
    expect(sessionRenewalConsequence("Your challenge keeps running without you.")).toBe(
      `${SESSION_RENEW_CONSEQUENCE} Your challenge keeps running without you.`,
    );
  });
});
