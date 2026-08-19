/**
 * How much of the morning is left.
 *
 * The case that matters is the last describe: a deadline that has gone by is
 * the one state the task screen used to render as a fresh invitation, and the
 * server cannot accept a walk saved after it, so "expired" has to be a state of
 * its own rather than a countdown that reached zero.
 */

import {
  CLOSING_MINUTES,
  deadlineMissedText,
  finishByText,
  type TimeLeft,
  timeLeft,
} from "../src/completions/time-left.ts";

/** The reading for a given number of minutes, or a failure if there is none. */
function at(minutes: number | null): TimeLeft {
  const left = timeLeft(minutes);
  if (left === null) {
    throw new Error("expected a countdown");
  }
  return left;
}

describe("a morning with time in it", () => {
  it("reads the remaining minutes as a duration a person would say", () => {
    expect(at(127).sentence).toBe("2 hours 7 minutes left to walk.");
    expect(at(120).sentence).toBe("2 hours left to walk.");
    expect(at(61).sentence).toBe("1 hour 1 minute left to walk.");
    expect(at(12).sentence).toBe("12 minutes left to walk.");
    expect(at(1).sentence).toBe("1 minute left to walk.");
  });

  it("names the last minute rather than counting it as none", () => {
    expect(at(0).sentence).toBe("Less than a minute left to walk.");
    expect(at(0).urgency).toBe("closing");
  });

  it("stays quiet while the deadline is further off than the alarm's own lead", () => {
    expect(at(CLOSING_MINUTES + 1).urgency).toBe("ample");
    expect(at(CLOSING_MINUTES).urgency).toBe("closing");
  });

  it("counts to nothing when there is no deadline to count to", () => {
    expect(timeLeft(null)).toBeNull();
  });
});

describe("a morning that has run out", () => {
  it("is its own state rather than a countdown that reached zero", () => {
    const left = at(-1);
    expect(left.urgency).toBe("expired");
    expect(left.minutes).toBe(0);
    expect(left.sentence).toBe("The deadline has passed.");
  });

  it("says a walk taken now cannot count, and where the day can still be saved", () => {
    const text = deadlineMissedText("7:00 AM");
    expect(text).toContain("7:00 AM");
    expect(text).toContain("cannot count");
    expect(text).toContain("Emergency Recovery");
  });
});

describe("a walk against the clock", () => {
  it("is told the finish is what is judged, not the start", () => {
    expect(finishByText("7:00 AM")).toBe(
      "Save it before 7:00 AM - a walk finished after the deadline does not count.",
    );
  });
});
