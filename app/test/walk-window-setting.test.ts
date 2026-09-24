/**
 * Choosing the walk window: a stepper that cannot leave the contract's bounds,
 * the presets beside it, and the sentence that turns a length into a clock time.
 */

import { MAXIMUM_WALK_WINDOW_MINUTES, MINIMUM_WALK_WINDOW_MINUTES } from "@betterwakeup/contract";
import {
  canStepWalkWindow,
  clampWalkWindow,
  DEFAULT_WALK_WINDOW_MINUTES,
  stepWalkWindow,
  WALK_WINDOW_PRESETS,
  walkWindowReading,
  walkWindowSummary,
} from "../src/challenges/walk-window-setting.ts";

describe("the stepper", () => {
  it("moves one minute at a time", () => {
    expect(stepWalkWindow(10, 1)).toBe(11);
    expect(stepWalkWindow(10, -1)).toBe(9);
  });

  it("stops at both bounds rather than stepping past them", () => {
    expect(stepWalkWindow(MINIMUM_WALK_WINDOW_MINUTES, -1)).toBe(MINIMUM_WALK_WINDOW_MINUTES);
    expect(stepWalkWindow(MAXIMUM_WALK_WINDOW_MINUTES, 1)).toBe(MAXIMUM_WALK_WINDOW_MINUTES);
    expect(canStepWalkWindow(MINIMUM_WALK_WINDOW_MINUTES, -1)).toBe(false);
    expect(canStepWalkWindow(MINIMUM_WALK_WINDOW_MINUTES, 1)).toBe(true);
    expect(canStepWalkWindow(MAXIMUM_WALK_WINDOW_MINUTES, 1)).toBe(false);
    expect(canStepWalkWindow(MAXIMUM_WALK_WINDOW_MINUTES, -1)).toBe(true);
  });

  it("lands anything outside the bounds on the nearest whole minute inside them", () => {
    expect(clampWalkWindow(2)).toBe(3);
    expect(clampWalkWindow(120)).toBe(119);
    expect(clampWalkWindow(10.4)).toBe(10);
    expect(clampWalkWindow(Number.NaN)).toBe(DEFAULT_WALK_WINDOW_MINUTES);
  });
});

describe("the presets", () => {
  it("are the product's lengths, all inside the bounds, and include the default", () => {
    expect(WALK_WINDOW_PRESETS).toEqual([5, 10, 15, 30, 60]);
    expect(WALK_WINDOW_PRESETS).toContain(DEFAULT_WALK_WINDOW_MINUTES);
    for (const preset of WALK_WINDOW_PRESETS) {
      expect(clampWalkWindow(preset)).toBe(preset);
    }
  });
});

describe("the reading", () => {
  it("names the clock time the earliest morning opens at", () => {
    expect(walkWindowReading(10, [{ deadline: "08:00" }, { deadline: "07:00" }])).toBe(
      "A 7:00 AM morning opens at 6:50 AM. Steps before then do not count.",
    );
  });

  it("says the night before when the window crosses midnight", () => {
    expect(walkWindowReading(60, [{ deadline: "00:30" }])).toBe(
      "A 12:30 AM morning opens at 11:30 PM the night before. Steps before then do not count.",
    );
  });

  it("falls back to the length when no morning is picked", () => {
    expect(walkWindowReading(15, [])).toBe("Your walk opens 15 minutes before each deadline.");
  });

  it("states the setting for the challenge page", () => {
    expect(walkWindowSummary(90)).toBe("1 hour 30 minutes before the deadline");
  });
});
