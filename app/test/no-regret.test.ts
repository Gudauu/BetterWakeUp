/**
 * The No Regret Time, as the two sentences the app says about it.
 *
 * The setting is the minimum notice required to skip a morning, and the form
 * had described it as how long the user has to stay up - a different promise
 * about a different thing. These tests pin what the number turns into: the
 * clock time a morning stops being skippable while it is being configured, and
 * how long is left on that notice once a challenge is running.
 */

import {
  noRegretReading,
  SKIP_CLOSING_MINUTES,
  skipCutoffFor,
  skipWindowFor,
  skipWindowSentence,
} from "../src/challenges/no-regret.ts";

describe("skipCutoffFor", () => {
  it("puts eight hours of notice on a 7:00 AM morning at 11:00 PM the day before", () => {
    expect(skipCutoffFor("07:00", 480)).toEqual({ wallClock: "23:00", daysBefore: 1 });
  });

  it("keeps a cutoff that lands on the same morning on that morning", () => {
    expect(skipCutoffFor("07:00", 240)).toEqual({ wallClock: "03:00", daysBefore: 0 });
  });

  it("reads no notice at all as the deadline itself", () => {
    expect(skipCutoffFor("07:00", 0)).toEqual({ wallClock: "07:00", daysBefore: 0 });
  });

  it("counts back more than one day when the notice is longer than one", () => {
    expect(skipCutoffFor("07:00", 32 * 60)).toEqual({ wallClock: "23:00", daysBefore: 2 });
  });

  it("answers nothing for text that is not a wall clock", () => {
    expect(skipCutoffFor("seven", 480)).toBeNull();
  });
});

describe("noRegretReading", () => {
  it("names the clock time the earliest morning stops being skippable", () => {
    expect(noRegretReading(480, [{ deadline: "07:00" }])).toBe(
      "That is 8 hours: a 7:00 AM morning stops being skippable at 11:00 PM the day before.",
    );
  });

  it("reads the tightest morning, since every other one gets more notice", () => {
    expect(noRegretReading(60, [{ deadline: "09:00" }, { deadline: "06:30" }])).toContain(
      "a 6:30 AM morning stops being skippable at 5:30 AM the same morning",
    );
  });

  it("says what the number means before any morning has been picked", () => {
    expect(noRegretReading(480, [])).toBe(
      "That is 8 hours of notice before a morning stops being skippable.",
    );
  });

  it("states zero as the real answer it is rather than as a duration", () => {
    expect(noRegretReading(0, [{ deadline: "07:00" }])).toBe(
      "No notice needed: a morning can be skipped right up to its deadline.",
    );
  });
});

describe("skipWindowFor", () => {
  const now = new Date("2026-09-01T13:00:00.000Z");

  it("counts the whole minutes left on an open notice", () => {
    expect(skipWindowFor("2026-09-01T18:00:00.000Z", now)).toEqual({
      minutesLeft: 300,
      closed: false,
      closing: false,
    });
  });

  it("calls the last hour closing", () => {
    const at = new Date(now.getTime() + SKIP_CLOSING_MINUTES * 60_000).toISOString();
    expect(skipWindowFor(at, now).closing).toBe(true);
  });

  it("is closed the moment the cutoff arrives", () => {
    expect(skipWindowFor("2026-09-01T13:00:00.000Z", now)).toEqual({
      minutesLeft: 0,
      closed: true,
      closing: false,
    });
  });

  it("treats a cutoff it cannot read as closed rather than as open", () => {
    expect(skipWindowFor("not an instant", now).closed).toBe(true);
  });
});

describe("skipWindowSentence", () => {
  const now = new Date("2026-09-01T13:00:00.000Z");

  it("names the cutoff in the challenge's own zone and how long is left", () => {
    const cutoff = "2026-09-01T18:00:00.000Z";
    const sentence = skipWindowSentence(skipWindowFor(cutoff, now), cutoff, "America/Los_Angeles");

    expect(sentence).toContain("11:00 AM");
    expect(sentence).toContain("5 hours left");
  });

  it("says nothing once the notice has run out, because the screen already does", () => {
    const cutoff = "2026-09-01T06:00:00.000Z";
    expect(
      skipWindowSentence(skipWindowFor(cutoff, now), cutoff, "America/Los_Angeles"),
    ).toBeNull();
  });
});
