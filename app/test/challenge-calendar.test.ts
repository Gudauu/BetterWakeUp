/**
 * The challenge as a wall calendar.
 *
 * The calendar is what tells a weekend from a pause, so the rules pinned here
 * are about the dates between walks: that each one lands in its weekday's
 * column, that a date with no walk reads as a rest day rather than a missing
 * one, and that months break where a printed calendar breaks them.
 */

import { challengeCalendar } from "../src/challenges/calendar.ts";
import type { ChallengeHistory, HistoryDay } from "../src/challenges/history.ts";

function history(days: readonly HistoryDay[]): ChallengeHistory {
  return { days, streak: 0, decided: 0 };
}

describe("the challenge calendar", () => {
  it("draws nothing for a challenge that holds no days yet", () => {
    expect(challengeCalendar(history([]))).toEqual([]);
  });

  it("puts each date under its weekday, Monday first, and marks a weekend as rest", () => {
    // 2026-09-04 is a Friday and 2026-09-07 the Monday after it.
    const [month] = challengeCalendar(
      history([
        { date: "2026-09-04", state: "kept" },
        { date: "2026-09-07", state: "due" },
      ]),
    );

    expect(month?.month).toBe("2026-09-01");
    expect(month?.weeks).toHaveLength(2);
    const [first, second] = month?.weeks ?? [];
    expect(first?.map((day) => day.state)).toEqual([
      "outside",
      "outside",
      "outside",
      "outside",
      "kept",
      "rest",
      "rest",
    ]);
    expect(first?.[0]?.date).toBe("2026-08-31");
    expect(second?.[0]).toEqual({ date: "2026-09-07", dayOfMonth: 7, state: "due" });
    expect(second?.slice(1).every((day) => day.state === "outside")).toBe(true);
  });

  it("keeps every walk day's own state, including a paused one", () => {
    const [month] = challengeCalendar(
      history([
        { date: "2026-09-14", state: "kept" },
        { date: "2026-09-15", state: "skipped" },
        { date: "2026-09-16", state: "missed" },
        { date: "2026-09-17", state: "forgiven" },
        { date: "2026-09-18", state: "due" },
        { date: "2026-09-21", state: "ahead" },
      ]),
    );

    const states = month?.weeks.flat().filter((day) => day.state !== "outside");
    expect(states?.map((day) => [day.dayOfMonth, day.state])).toEqual([
      [14, "kept"],
      [15, "skipped"],
      [16, "missed"],
      [17, "forgiven"],
      [18, "due"],
      [19, "rest"],
      [20, "rest"],
      [21, "ahead"],
    ]);
  });

  it("starts a new month on its own row, splitting the week that crosses into it", () => {
    // 2026-09-30 is a Wednesday, so the week of the 28th crosses into October.
    const months = challengeCalendar(
      history([
        { date: "2026-09-30", state: "kept" },
        { date: "2026-10-01", state: "due" },
      ]),
    );

    expect(months.map((month) => month.month)).toEqual(["2026-09-01", "2026-10-01"]);
    const september = months[0]?.weeks.flat() ?? [];
    const october = months[1]?.weeks.flat() ?? [];
    expect(september.find((day) => day.date === "2026-10-01")?.state).toBe("outside");
    expect(october.find((day) => day.date === "2026-09-30")?.state).toBe("outside");
    expect(october.find((day) => day.date === "2026-10-01")?.state).toBe("due");
  });

  it("leaves off weeks of a month that hold no day of the challenge", () => {
    const [month] = challengeCalendar(history([{ date: "2026-09-16", state: "due" }]));

    expect(month?.weeks).toHaveLength(1);
    expect(month?.weeks[0]?.[0]?.date).toBe("2026-09-14");
  });
});
