/**
 * The phone holding a walk to the server's own window.
 *
 * The server refuses a walk that started before its task opened, however it
 * ended, and one that finished after the deadline. A record written for either
 * is a walk the user was told was saved and that can only come back refused.
 */

import { walkOutsideWindow, walkOutsideWindowText } from "../src/completions/walk-acceptance.ts";

/** A 7:00 AM Los Angeles deadline whose walk opens ten minutes before it. */
const TASK = { opensAt: "2026-09-01T13:50:00.000Z", deadline: "2026-09-01T14:00:00.000Z" };

function walk(startedAt: string, endedAt: string) {
  return { startedAt, endedAt };
}

describe("the opening boundary", () => {
  it("accepts a walk that started exactly as the window opened", () => {
    expect(walkOutsideWindow(TASK, walk(TASK.opensAt, "2026-09-01T13:55:00.000Z"))).toBeNull();
  });

  it("refuses a walk that started a millisecond early", () => {
    expect(
      walkOutsideWindow(TASK, walk("2026-09-01T13:49:59.999Z", "2026-09-01T13:55:00.000Z")),
    ).toBe("started-early");
  });

  it("refuses a walk started a second early even though it finished inside the window", () => {
    expect(
      walkOutsideWindow(TASK, walk("2026-09-01T13:49:59.000Z", "2026-09-01T13:59:00.000Z")),
    ).toBe("started-early");
  });
});

describe("the deadline boundary", () => {
  it("accepts a walk that finished exactly at the deadline", () => {
    expect(walkOutsideWindow(TASK, walk("2026-09-01T13:55:00.000Z", TASK.deadline))).toBeNull();
  });

  it("refuses a walk that finished a millisecond late", () => {
    expect(
      walkOutsideWindow(TASK, walk("2026-09-01T13:55:00.000Z", "2026-09-01T14:00:00.001Z")),
    ).toBe("finished-late");
  });
});

describe("a window that opens the evening before", () => {
  // A 12:30 AM deadline with an hour's window in Los Angeles opens at 11:30 PM
  // on the date before the task's own.
  const LATE = { opensAt: "2026-09-02T06:30:00.000Z", deadline: "2026-09-02T07:30:00.000Z" };

  it("accepts a walk from 11:30 PM the date before", () => {
    expect(
      walkOutsideWindow(LATE, walk("2026-09-02T06:30:00.000Z", "2026-09-02T06:40:00.000Z")),
    ).toBeNull();
    expect(
      walkOutsideWindow(LATE, walk("2026-09-02T06:29:59.000Z", "2026-09-02T06:40:00.000Z")),
    ).toBe("started-early");
  });

  it("follows the server's instant across a clock change", () => {
    // Santiago falls back at midnight on April 5, 2026: 11:30 PM on April 4
    // happens at 02:30Z and again at 03:30Z. An hour's window before a 12:30
    // AM deadline is an hour of real time, so only the second one counts.
    const santiago = {
      opensAt: "2026-04-05T03:30:00.000Z",
      deadline: "2026-04-05T04:30:00.000Z",
    };

    expect(
      walkOutsideWindow(santiago, walk("2026-04-05T02:30:00.000Z", "2026-04-05T02:40:00.000Z")),
    ).toBe("started-early");
    expect(
      walkOutsideWindow(santiago, walk("2026-04-05T03:30:00.000Z", "2026-04-05T03:40:00.000Z")),
    ).toBeNull();
  });
});

describe("what the walker is told", () => {
  it("names the opening time for a walk started too early", () => {
    expect(walkOutsideWindowText("started-early", TASK, "America/Los_Angeles")).toMatch(
      /^This walk started before your walk opened at 6:50 AM, so it cannot count and nothing was recorded\./,
    );
  });

  it("names the deadline for a walk finished too late", () => {
    expect(walkOutsideWindowText("finished-late", TASK, "America/Los_Angeles")).toBe(
      "This walk finished after the 7:00 AM deadline, so it cannot count and nothing was recorded.",
    );
  });
});
