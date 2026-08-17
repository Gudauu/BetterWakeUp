/**
 * Issue 18's pure half: what a configuration projects to.
 *
 * The projection is the screen a user reads before they commit money, so the
 * three facts on it and the flag under them are worth pinning exactly rather
 * than approximately. The maximum duration cases sit on both sides of the
 * boundary and on both sides of the deposit, because the rule is about a funded
 * challenge and says nothing about an unfunded one.
 */

import type { ChallengeConfiguration, Weekday } from "@betterwakeup/contract";
import { describe, expect, it } from "vitest";

import { assertDepositAmount, planChallenge } from "../src/challenges/plan.ts";

const EVERY_DAY: Weekday[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

/** Midnight UTC on Monday 5 January 2026, which is 16:00 the previous day in Los Angeles. */
const STARTING_AT = new Date("2026-01-05T00:00:00Z");

function configuration(overrides: Partial<ChallengeConfiguration> = {}): ChallengeConfiguration {
  return {
    requiredTaskCount: 5,
    schedule: EVERY_DAY.map((weekday) => ({ weekday, deadline: "08:00" })),
    stepTarget: 500,
    noRegretMinutes: 60,
    timeZone: "America/Los_Angeles",
    deposit: { amount: 0, currency: "USD" },
    ...overrides,
  };
}

describe("what a configuration projects to", () => {
  it("names the first task, its deadline, and the end date", () => {
    const { projection } = planChallenge(configuration(), STARTING_AT);

    // The Sunday deadline has already passed its cutoff at the starting
    // instant, so the challenge begins on the Monday.
    expect(projection).toEqual({
      firstTaskDate: "2026-01-05",
      firstTaskDeadline: "2026-01-05T16:00:00.000Z",
      projectedEndDate: "2026-01-09",
      withinMaximumDuration: true,
    });
  });

  it("returns exactly the required number of tasks, which is what the database holds", () => {
    const { tasks } = planChallenge(configuration({ requiredTaskCount: 12 }), STARTING_AT);

    expect(tasks).toHaveLength(12);
    expect(tasks.map((task) => task.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(tasks[11]?.date).toBe("2026-01-16");
  });

  it("skips the inactive weekdays when placing dates", () => {
    const { tasks, projection } = planChallenge(
      configuration({
        requiredTaskCount: 3,
        schedule: [
          { weekday: "monday", deadline: "08:00" },
          { weekday: "wednesday", deadline: "09:30" },
        ],
      }),
      STARTING_AT,
    );

    expect(tasks.map((task) => task.date)).toEqual(["2026-01-05", "2026-01-07", "2026-01-12"]);
    expect(projection.projectedEndDate).toBe("2026-01-12");
  });
});

describe("the maximum duration rule", () => {
  const funded = { amount: 5000, currency: "USD" } as const;

  it("holds a funded challenge that ends on the last permitted day", () => {
    const { projection } = planChallenge(
      configuration({ requiredTaskCount: 365, deposit: funded }),
      STARTING_AT,
    );

    // 2026-01-04 in Los Angeles is the day the money would be taken, and the
    // last task falls exactly 365 days later.
    expect(projection.projectedEndDate).toBe("2027-01-04");
    expect(projection.withinMaximumDuration).toBe(true);
  });

  it("refuses to call a funded challenge one day longer than that within the maximum", () => {
    const { projection } = planChallenge(
      configuration({ requiredTaskCount: 366, deposit: funded }),
      STARTING_AT,
    );

    expect(projection.projectedEndDate).toBe("2027-01-05");
    expect(projection.withinMaximumDuration).toBe(false);
  });

  it("holds the same configuration within the maximum when nothing is deposited", () => {
    const { projection } = planChallenge(
      configuration({ requiredTaskCount: 366, deposit: { amount: 0, currency: "USD" } }),
      STARTING_AT,
    );

    // The rule exists because an authorization cannot be held indefinitely.
    // There is nothing to hold, so the same schedule is fine.
    expect(projection.projectedEndDate).toBe("2027-01-05");
    expect(projection.withinMaximumDuration).toBe(true);
  });
});

describe("the deposit amount rule, restated in the domain", () => {
  it("rejects an amount between nothing and the funded minimum", () => {
    const between = configuration({ deposit: { amount: 50, currency: "USD" } });

    expect(() => assertDepositAmount(between)).toThrowError(
      expect.objectContaining({ code: "deposit_amount_invalid" }),
    );
    expect(() => planChallenge(between, STARTING_AT)).toThrowError(
      expect.objectContaining({ code: "deposit_amount_invalid" }),
    );
  });

  it("accepts nothing at all and accepts the minimum", () => {
    expect(() =>
      assertDepositAmount(configuration({ deposit: { amount: 0, currency: "USD" } })),
    ).not.toThrow();
    expect(() =>
      assertDepositAmount(configuration({ deposit: { amount: 100, currency: "USD" } })),
    ).not.toThrow();
  });
});
