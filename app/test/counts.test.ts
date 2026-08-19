/**
 * Reading the challenge's whole numbers.
 *
 * The rules here are what stands between a person clearing a field to type a
 * new number and the contract's schema, which answered the zero that used to
 * be written in its place with a path into the request body.
 */

import {
  COUNT_NOT_A_NUMBER,
  COUNT_TOO_LARGE,
  DAYS_TO_COMPLETE,
  NO_REGRET_MINUTES,
  readCount,
  STEP_TARGET,
} from "../src/challenges/counts.ts";

describe("a number that reads", () => {
  it("reads plain digits", () => {
    expect(readCount("30", DAYS_TO_COMPLETE)).toEqual({ count: 30, problem: null });
  });

  it("reads a padded number as the number", () => {
    expect(readCount("030", DAYS_TO_COMPLETE)).toEqual({ count: 30, problem: null });
  });

  it("reads a pasted number with its thousands separators", () => {
    expect(readCount("1,000", STEP_TARGET)).toEqual({ count: 1000, problem: null });
    expect(readCount(" 1 000 ", STEP_TARGET)).toEqual({ count: 1000, problem: null });
  });

  it("accepts zero where the field allows it", () => {
    expect(readCount("0", NO_REGRET_MINUTES)).toEqual({ count: 0, problem: null });
  });
});

describe("a number that does not read", () => {
  it("refuses an empty field rather than calling it zero", () => {
    const reading = readCount("", DAYS_TO_COMPLETE);

    expect(reading.count).toBeNull();
    expect(reading.problem).toBe(DAYS_TO_COMPLETE.missing);
  });

  it("refuses a decimal, because a challenge counts whole things", () => {
    expect(readCount("12.5", STEP_TARGET)).toEqual({
      count: null,
      problem: COUNT_NOT_A_NUMBER,
    });
  });

  it("refuses text", () => {
    expect(readCount("thirty", DAYS_TO_COMPLETE).problem).toBe(COUNT_NOT_A_NUMBER);
  });

  it("refuses a number larger than the contract can carry", () => {
    expect(readCount("99999999999999999999", STEP_TARGET)).toEqual({
      count: null,
      problem: COUNT_TOO_LARGE,
    });
  });

  it("names the field's own minimum rather than the schema's", () => {
    expect(readCount("0", DAYS_TO_COMPLETE).problem).toBe(
      "A challenge needs at least one day to complete.",
    );
    expect(readCount("0", STEP_TARGET).problem).toBe(
      "A morning needs a target of at least one step.",
    );
  });

  it("says nothing about a path into the request body", () => {
    const sentences = [
      COUNT_NOT_A_NUMBER,
      COUNT_TOO_LARGE,
      DAYS_TO_COMPLETE.missing,
      DAYS_TO_COMPLETE.tooSmall,
      STEP_TARGET.missing,
      STEP_TARGET.tooSmall,
      NO_REGRET_MINUTES.missing,
    ];

    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/requiredTaskCount|stepTarget|noRegretMinutes|>=/);
    }
  });
});
