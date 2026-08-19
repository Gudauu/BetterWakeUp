/**
 * Reading a typed wake-up time.
 *
 * The contract accepts only `HH:MM`, so what is worth pinning here is the set
 * of things a person types that the app turns into it - and, just as much, the
 * things it must refuse rather than guess at, because a deadline guessed wrong
 * costs the user a morning and possibly their deposit.
 */

import {
  readWakeTime,
  WAKE_TIME_OUT_OF_RANGE,
  WAKE_TIME_PROBLEM,
} from "../src/challenges/wake-time.ts";

describe("readWakeTime", () => {
  it.each([
    ["07:00", "07:00"],
    ["7:00", "07:00"],
    ["7", "07:00"],
    ["07", "07:00"],
    ["700", "07:00"],
    ["0700", "07:00"],
    ["6:30", "06:30"],
    ["630", "06:30"],
    ["19:30", "19:30"],
    ["1930", "19:30"],
    ["00:00", "00:00"],
    ["23:59", "23:59"],
  ])("reads %s as %s", (typed, wallClock) => {
    expect(readWakeTime(typed)).toEqual({ wallClock, problem: null });
  });

  it.each([
    ["7am", "07:00"],
    ["7 AM", "07:00"],
    ["7:00 am", "07:00"],
    ["7:30pm", "19:30"],
    ["730 pm", "19:30"],
    ["11:59 PM", "23:59"],
  ])("reads %s as %s", (typed, wallClock) => {
    expect(readWakeTime(typed)).toEqual({ wallClock, problem: null });
  });

  // The pair everybody gets wrong, so the one the app must not.
  it("reads 12 AM as midnight and 12 PM as noon", () => {
    expect(readWakeTime("12am").wallClock).toBe("00:00");
    expect(readWakeTime("12:15am").wallClock).toBe("00:15");
    expect(readWakeTime("12pm").wallClock).toBe("12:00");
  });

  it.each([
    "",
    "   ",
    "morning",
    "seven",
    "7:5",
    "12345",
    "7:",
    ":30",
    "-7",
  ])("refuses %p as not a time yet", (typed) => {
    expect(readWakeTime(typed)).toEqual({ wallClock: null, problem: WAKE_TIME_PROBLEM });
  });

  it.each([
    "25:00",
    "24:00",
    "07:75",
    "0799",
    "13pm",
    "19 pm",
    "0am",
  ])("refuses %p as no such time of day", (typed) => {
    expect(readWakeTime(typed)).toEqual({ wallClock: null, problem: WAKE_TIME_OUT_OF_RANGE });
  });

  it("never answers with both a time and a problem", () => {
    for (const typed of ["7", "7am", "nonsense", "25:00", ""]) {
      const reading = readWakeTime(typed);
      expect(reading.wallClock === null).toBe(reading.problem !== null);
    }
  });
});
