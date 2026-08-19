/**
 * How long the challenge has been going.
 *
 * Home counted kept mornings and named a projected end date, and nothing in
 * between: `activatedAt` had been answered on every read since the challenge
 * view was written and drawn nowhere, so a month of Monday/Wednesday/Friday
 * mornings read exactly like five consecutive days. These pin the day it
 * started as its own zone reads it, the day number today, and the two cases
 * where there is nothing honest to say.
 */

import { challengeAge } from "../src/challenges/challenge-age.ts";
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
    const age = challengeAge(
      activated("2026-08-31T00:00:00.000Z"),
      new Date("2026-09-01T12:00:00.000Z"),
    );

    expect(age?.startedOn).toBe("Sunday, August 30");
  });

  it("reads the same instant as the next day in a zone east of it", () => {
    const age = challengeAge(
      activated("2026-08-31T00:00:00.000Z", "Asia/Tokyo"),
      new Date("2026-09-01T12:00:00.000Z"),
    );

    expect(age?.startedOn).toBe("Monday, August 31");
  });
});

describe("which day of the challenge today is", () => {
  it("counts calendar days rather than kept mornings", () => {
    // Two whole days have turned over where the challenge reads its deadlines,
    // whatever the schedule asked for in them.
    const age = challengeAge(
      activated("2026-08-31T00:00:00.000Z"),
      new Date("2026-09-01T12:00:00.000Z"),
    );

    expect(age?.dayText).toBe("Today is day 3 of this challenge.");
  });

  it("says a challenge started today rather than calling it day 1", () => {
    const age = challengeAge(
      activated("2026-09-01T13:00:00.000Z"),
      new Date("2026-09-01T20:00:00.000Z"),
    );

    expect(age?.dayText).toBe("This challenge started today.");
  });

  it("numbers the day after the first as day 2", () => {
    const age = challengeAge(
      activated("2026-09-01T13:00:00.000Z"),
      new Date("2026-09-02T20:00:00.000Z"),
    );

    expect(age?.dayText).toBe("Today is day 2 of this challenge.");
  });

  it("does not count backwards when the clock is behind the activation", () => {
    // A device whose clock has been set back would otherwise reach day zero or
    // a negative day, which is a number no reader can do anything with.
    const age = challengeAge(
      activated("2026-09-05T13:00:00.000Z"),
      new Date("2026-09-01T20:00:00.000Z"),
    );

    expect(age?.dayText).toBe("This challenge started today.");
  });
});

describe("when there is nothing to say", () => {
  it("answers nothing for a challenge that has not been activated", () => {
    expect(challengeAge(activated(null), new Date("2026-09-01T12:00:00.000Z"))).toBeNull();
  });

  it("answers nothing rather than a start date a day out when the zone is unreadable", () => {
    expect(
      challengeAge(
        activated("2026-08-31T00:00:00.000Z", "Not/AZone"),
        new Date("2026-09-01T12:00:00.000Z"),
      ),
    ).toBeNull();
  });
});
