/**
 * How the app reads dates out loud.
 *
 * The point of these is that no screen ever prints an ISO string at a person,
 * and that a deadline is printed in the challenge's zone rather than the
 * device's - the two differ by most of a day for a user who travels, and the
 * wrong one would have them walking after the deadline.
 */

import { formatDay, formatDeadline, formatTimeOfDay, formatWallClock } from "../src/ui/format.ts";

describe("a deadline", () => {
  it("is read in the challenge's own time zone, not the device's", () => {
    const instant = "2026-09-01T14:00:00.000Z";

    expect(formatDeadline(instant, "America/Los_Angeles")).toBe("Tue, Sep 1, 7:00 AM");
    expect(formatDeadline(instant, "Asia/Tokyo")).toBe("Tue, Sep 1, 11:00 PM");
  });

  it("can be read as a clock time alone, for a screen already showing the day", () => {
    expect(formatTimeOfDay("2026-09-01T14:00:00.000Z", "America/Los_Angeles")).toBe("7:00 AM");
  });

  it("falls back to the raw instant rather than a time in the wrong zone", () => {
    // A runtime with no zone data for this name: showing 7:00 AM local would be
    // a lie, so the unformatted instant is what is left.
    expect(formatDeadline("2026-09-01T14:00:00.000Z", "Mars/Olympus_Mons")).toBe(
      "2026-09-01T14:00:00.000Z",
    );
  });
});

describe("a task's calendar date", () => {
  it("names the day the task is for, whatever zone the reader is in", () => {
    // Midnight UTC shifted into a western zone would name August 31, which is
    // the one date a user would spot as wrong.
    expect(formatDay("2026-09-01")).toBe("Tuesday, September 1");
  });
});

describe("a wall-clock time being configured", () => {
  it("reads a 24-hour schedule entry the way its owner says it", () => {
    expect(formatWallClock("07:00")).toBe("7:00 AM");
    expect(formatWallClock("00:00")).toBe("12:00 AM");
    expect(formatWallClock("12:00")).toBe("12:00 PM");
    expect(formatWallClock("19:30")).toBe("7:30 PM");
  });

  it("reads the same as the running challenge's own deadline does", () => {
    // The setup screen and the task screen must not word one time two ways.
    expect(formatWallClock("07:00")).toBe(
      formatTimeOfDay("2026-09-01T14:00:00.000Z", "America/Los_Angeles"),
    );
  });

  it("hands back anything that is not a time rather than inventing one", () => {
    expect(formatWallClock("7am")).toBe("7am");
  });
});
