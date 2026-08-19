/**
 * Reading the money a challenge is staked with.
 *
 * The rules here stand between a person typing an amount in dollars and a hold
 * on their card. Two of them are the reason this module exists: text the field
 * cannot read used to become "no deposit at all" without a word, and an amount
 * one keystroke larger than the one meant used to be authorized in silence.
 */

import {
  DEPOSIT_BELOW_MINIMUM,
  DEPOSIT_NOT_AN_AMOUNT,
  DEPOSIT_TOO_LARGE,
  DEPOSIT_TOO_PRECISE,
  LARGE_DEPOSIT_MINOR_UNITS,
  readDeposit,
} from "../src/challenges/deposit.ts";

describe("an amount that reads", () => {
  it("reads dollars as dollars rather than as cents", () => {
    expect(readDeposit("20").minorUnits).toBe(2000);
  });

  it("reads cents after the point", () => {
    expect(readDeposit("19.99").minorUnits).toBe(1999);
    expect(readDeposit("19.9").minorUnits).toBe(1990);
  });

  it("reads a pasted amount with its symbol and separators", () => {
    expect(readDeposit(" $1,000.00 ").minorUnits).toBe(100_000);
  });

  it("reads an empty box as no deposit rather than refusing it", () => {
    expect(readDeposit("")).toEqual({
      minorUnits: 0,
      problem: null,
      reading: null,
      caution: null,
    });
    expect(readDeposit("   ").minorUnits).toBe(0);
  });

  it("reads a typed zero as the same answer as an empty box", () => {
    expect(readDeposit("0").minorUnits).toBe(0);
    expect(readDeposit("0.00").problem).toBeNull();
  });

  it("says what the amount comes to, so twenty dollars is visibly not twenty cents", () => {
    expect(readDeposit("20").reading).toBe("That is $20.00 held on your card until you finish.");
  });

  it("says nothing back about an empty box, whose hint already says what nothing means", () => {
    expect(readDeposit("").reading).toBeNull();
    expect(readDeposit("").caution).toBeNull();
  });
});

describe("an amount that does not read", () => {
  it("refuses text rather than staking nothing in silence", () => {
    expect(readDeposit("twenty")).toEqual({
      minorUnits: null,
      problem: DEPOSIT_NOT_AN_AMOUNT,
      reading: null,
      caution: null,
    });
  });

  it("refuses a point with nothing after it yet", () => {
    expect(readDeposit("12.").problem).toBe(DEPOSIT_NOT_AN_AMOUNT);
    expect(readDeposit(".").problem).toBe(DEPOSIT_NOT_AN_AMOUNT);
  });

  it("refuses more precision than money has", () => {
    expect(readDeposit("19.999").problem).toBe(DEPOSIT_TOO_PRECISE);
  });

  it("refuses an amount larger than whole minor units can carry", () => {
    expect(readDeposit("99999999999999999999").problem).toBe(DEPOSIT_TOO_LARGE);
  });

  it("names the processor's minimum in the user's own money", () => {
    expect(readDeposit("0.50").problem).toBe(DEPOSIT_BELOW_MINIMUM);
    expect(DEPOSIT_BELOW_MINIMUM).toContain("$1.00");
  });

  it("says nothing about minor units or a path into the request body", () => {
    const sentences = [
      DEPOSIT_NOT_AN_AMOUNT,
      DEPOSIT_TOO_PRECISE,
      DEPOSIT_TOO_LARGE,
      DEPOSIT_BELOW_MINIMUM,
    ];

    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/minor units|depositMinorUnits|deposit\.amount|>=/);
    }
  });
});

describe("an amount worth checking", () => {
  it("reads a large amount back as a caution rather than as a plain reading", () => {
    const reading = readDeposit(String(LARGE_DEPOSIT_MINOR_UNITS / 100));

    expect(reading.minorUnits).toBe(LARGE_DEPOSIT_MINOR_UNITS);
    expect(reading.problem).toBeNull();
    expect(reading.reading).toBeNull();
    expect(reading.caution).toContain("Check that is the amount you meant.");
  });

  it("names the amount in the caution, because that is the digit that slipped", () => {
    expect(readDeposit("200").caution).toContain("$200.00");
  });

  it("accepts it, because the app has no maximum to enforce", () => {
    expect(readDeposit("5000").minorUnits).toBe(500_000);
    expect(readDeposit("5000").problem).toBeNull();
  });

  it("leaves an ordinary amount uncautioned", () => {
    expect(readDeposit(String(LARGE_DEPOSIT_MINOR_UNITS / 100 - 1)).caution).toBeNull();
  });
});
