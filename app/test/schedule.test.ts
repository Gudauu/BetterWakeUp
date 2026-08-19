/**
 * The schedule read back to its owner.
 *
 * A challenge's days and times are decided once and can never be edited, so
 * the app's only remaining job is to say them - and until now nothing past the
 * setup form did, which left "which mornings am I on the hook for?" with no
 * answer between tasks.
 */

import type { ScheduledWeekday } from "@betterwakeup/contract";
import {
  nextActiveMorning,
  nextMorningText,
  scheduleGroups,
  scheduleSentence,
} from "../src/challenges/schedule.ts";

function days(deadline: string, ...weekdays: string[]): ScheduledWeekday[] {
  return weekdays.map((weekday) => ({ weekday, deadline }) as ScheduledWeekday);
}

describe("the schedule as rows", () => {
  it("collapses a run of three or more days into a range", () => {
    const groups = scheduleGroups(
      days("07:00", "monday", "tuesday", "wednesday", "thursday", "friday"),
    );

    expect(groups).toEqual([{ days: "Mon-Fri", time: "7:00 AM" }]);
  });

  it("lists two days rather than spanning them", () => {
    expect(scheduleGroups(days("09:30", "saturday", "sunday"))).toEqual([
      { days: "Sat, Sun", time: "9:30 AM" },
    ]);
  });

  it("names the whole week as every day", () => {
    const groups = scheduleGroups(
      days("06:00", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"),
    );

    expect(groups).toEqual([{ days: "Every day", time: "6:00 AM" }]);
  });

  it("groups by the deadline the days share rather than by where they fall", () => {
    const groups = scheduleGroups([
      ...days("07:00", "monday", "tuesday", "wednesday", "thursday", "friday"),
      ...days("09:00", "saturday", "sunday"),
    ]);

    expect(groups).toEqual([
      { days: "Mon-Fri", time: "7:00 AM" },
      { days: "Sat, Sun", time: "9:00 AM" },
    ]);
  });

  it("breaks a run wherever a day is not scheduled", () => {
    expect(scheduleGroups(days("07:00", "monday", "wednesday", "friday"))).toEqual([
      { days: "Mon, Wed, Fri", time: "7:00 AM" },
    ]);
  });

  it("reads a schedule handed to it out of order", () => {
    expect(scheduleGroups(days("07:00", "wednesday", "monday", "tuesday"))).toEqual([
      { days: "Mon-Wed", time: "7:00 AM" },
    ]);
  });

  it("invents no line for a schedule with no days in it", () => {
    expect(scheduleGroups([])).toEqual([]);
  });
});

describe("the schedule on one line", () => {
  it("joins each arrangement with the time it runs at", () => {
    const sentence = scheduleSentence([
      ...days("06:15", "monday", "tuesday", "wednesday", "thursday", "friday"),
      ...days("09:00", "sunday"),
    ]);

    expect(sentence).toBe("Mon-Fri at 6:15 AM, Sun at 9:00 AM");
  });

  it("says so rather than nothing when no morning has been picked", () => {
    expect(scheduleSentence([])).toBe("No mornings set.");
  });
});

describe("the next morning the challenge asks for", () => {
  /** A Tuesday evening in Los Angeles, which is already Wednesday in UTC. */
  const TUESDAY_EVENING = new Date("2026-09-02T03:00:00.000Z");

  it("names the next scheduled weekday after today", () => {
    const schedule = days("07:00", "monday", "friday");

    expect(nextActiveMorning(schedule, TUESDAY_EVENING, "America/Los_Angeles")).toBe("Friday");
  });

  it("skips today even when today is scheduled, because its task is behind the user", () => {
    const schedule = days("07:00", "tuesday", "thursday");

    expect(nextActiveMorning(schedule, TUESDAY_EVENING, "America/Los_Angeles")).toBe("Thursday");
  });

  it("wraps to the same weekday next week when it is the only one", () => {
    const schedule = days("07:00", "tuesday");

    expect(nextActiveMorning(schedule, TUESDAY_EVENING, "America/Los_Angeles")).toBe("Tuesday");
  });

  it("reads the day where the challenge is rather than where UTC is", () => {
    const schedule = days("07:00", "tuesday", "wednesday");

    // The same instant is Tuesday in Los Angeles and Wednesday in UTC, and each
    // reading skips its own today, so the two answers differ.
    expect(nextActiveMorning(schedule, TUESDAY_EVENING, "America/Los_Angeles")).toBe("Wednesday");
    expect(nextActiveMorning(schedule, TUESDAY_EVENING, "UTC")).toBe("Tuesday");
  });

  it("answers nothing on a runtime that cannot read the zone", () => {
    expect(nextActiveMorning(days("07:00", "monday"), TUESDAY_EVENING, "Mars/Olympus")).toBeNull();
  });

  it("falls back to what home always said when the day cannot be worked out", () => {
    expect(nextMorningText(null)).toBe(
      "Nothing is due right now. The next task appears on your next active day.",
    );
    expect(nextMorningText("Friday")).toBe(
      "Nothing is due right now. Your next morning is Friday.",
    );
  });
});
