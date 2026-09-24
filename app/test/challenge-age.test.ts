/**
 * The day a challenge started.
 *
 * `activatedAt` had been answered on every read since the challenge view was
 * written and drawn nowhere, so a month of Monday/Wednesday/Friday mornings
 * read exactly like five consecutive days. These pin the day it started as its
 * own zone reads it, and the two cases where there is nothing honest to say.
 */

import { challengeStartedOn } from "../src/challenges/challenge-age.ts";
import { challengeView } from "./support/fake-api.ts";

const LOS_ANGELES = "America/Los_Angeles";

function activated(at: string | null, timeZone = LOS_ANGELES) {
  const base = challengeView();
  return challengeView({
    activatedAt: at,
    configuration: { ...base.configuration, timeZone },
  });
}

describe("the day a challenge started", () => {
  it("names it as the challenge's own zone reads it, not as the instant's UTC day", () => {
    // 2026-08-31T00:00Z is still the afternoon of the 30th in Los Angeles, and
    // the 30th is the day the challenge's own deadlines were being read on.
    expect(challengeStartedOn(activated("2026-08-31T00:00:00.000Z"))).toBe("Sunday, August 30");
  });

  it("reads the same instant as the next day in a zone east of it", () => {
    expect(challengeStartedOn(activated("2026-08-31T00:00:00.000Z", "Asia/Tokyo"))).toBe(
      "Monday, August 31",
    );
  });
});

describe("when there is nothing to say", () => {
  it("answers nothing for a challenge that has not been activated", () => {
    expect(challengeStartedOn(activated(null))).toBeNull();
  });

  it("answers nothing rather than a start date a day out when the zone is unreadable", () => {
    expect(challengeStartedOn(activated("2026-08-31T00:00:00.000Z", "Not/AZone"))).toBeNull();
  });
});
