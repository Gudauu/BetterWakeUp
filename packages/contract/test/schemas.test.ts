import { describe, expect, it } from "vitest";
import {
  challengeConfiguration,
  challengeStatus,
  createCompletionRequest,
  depositAmount,
  ERROR_DISPOSITIONS,
  endedChallengeSummary,
  errorCode,
  ianaTimeZone,
  localTime,
  MAXIMUM_WALK_WINDOW_MINUTES,
  MINIMUM_FUNDED_DEPOSIT_MINOR_UNITS,
  MINIMUM_WALK_WINDOW_MINUTES,
  movementObservation,
  weeklySchedule,
} from "../src/index.ts";

const validConfiguration = {
  requiredTaskCount: 30,
  schedule: [
    { weekday: "monday", deadline: "09:00" },
    { weekday: "tuesday", deadline: "08:30" },
  ],
  stepTarget: 250,
  noRegretMinutes: 480,
  walkWindowMinutes: 10,
  timeZone: "America/Los_Angeles",
  deposit: { amount: 2000, currency: "USD" },
};

describe("deposit amount", () => {
  it("accepts no deposit at all", () => {
    expect(depositAmount.safeParse({ amount: 0, currency: "USD" }).success).toBe(true);
  });

  it("accepts exactly the funded minimum", () => {
    const deposit = { amount: MINIMUM_FUNDED_DEPOSIT_MINOR_UNITS, currency: "USD" };
    expect(depositAmount.safeParse(deposit).success).toBe(true);
  });

  it("rejects an amount between nothing and the funded minimum", () => {
    const deposit = { amount: MINIMUM_FUNDED_DEPOSIT_MINOR_UNITS - 1, currency: "USD" };
    expect(depositAmount.safeParse(deposit).success).toBe(false);
  });

  it("rejects a fractional amount, since money is carried in minor units", () => {
    expect(depositAmount.safeParse({ amount: 100.5, currency: "USD" }).success).toBe(false);
  });
});

describe("walk window", () => {
  const withWindow = (walkWindowMinutes: unknown) =>
    challengeConfiguration.safeParse({ ...validConfiguration, walkWindowMinutes }).success;

  it("accepts both bounds, which the product states as more than 2 minutes and less than 2 hours", () => {
    expect(MINIMUM_WALK_WINDOW_MINUTES).toBe(3);
    expect(MAXIMUM_WALK_WINDOW_MINUTES).toBe(119);
    expect(withWindow(MINIMUM_WALK_WINDOW_MINUTES)).toBe(true);
    expect(withWindow(MAXIMUM_WALK_WINDOW_MINUTES)).toBe(true);
  });

  it("rejects a window just outside either bound", () => {
    expect(withWindow(MINIMUM_WALK_WINDOW_MINUTES - 1)).toBe(false);
    expect(withWindow(MAXIMUM_WALK_WINDOW_MINUTES + 1)).toBe(false);
  });

  it("rejects a fractional window and a missing one", () => {
    expect(withWindow(10.5)).toBe(false);
    expect(withWindow(undefined)).toBe(false);
  });
});

describe("weekly schedule", () => {
  it("accepts one active weekday", () => {
    const parsed = weeklySchedule.safeParse([{ weekday: "monday", deadline: "09:00" }]);
    expect(parsed.success).toBe(true);
  });

  it("rejects the same weekday twice", () => {
    const parsed = weeklySchedule.safeParse([
      { weekday: "monday", deadline: "09:00" },
      { weekday: "monday", deadline: "10:00" },
    ]);
    expect(parsed.success).toBe(false);
  });

  it("rejects an empty schedule, which would produce no tasks", () => {
    expect(weeklySchedule.safeParse([]).success).toBe(false);
  });
});

describe("local time", () => {
  it.each(["00:00", "09:05", "23:59"])("accepts %s", (value) => {
    expect(localTime.safeParse(value).success).toBe(true);
  });

  it.each(["24:00", "9:00", "09:60", "09:00:00", "9am"])("rejects %s", (value) => {
    expect(localTime.safeParse(value).success).toBe(false);
  });
});

describe("time zone", () => {
  it("accepts an IANA zone the runtime can do arithmetic in", () => {
    expect(ianaTimeZone.safeParse("Europe/Berlin").success).toBe(true);
  });

  it("rejects a well-formed name that is not a zone", () => {
    expect(ianaTimeZone.safeParse("America/Atlantis").success).toBe(false);
  });

  it("rejects a UTC offset, which does not survive a daylight saving transition", () => {
    expect(ianaTimeZone.safeParse("UTC+2").success).toBe(false);
  });
});

describe("challenge configuration", () => {
  it("accepts a complete configuration", () => {
    expect(challengeConfiguration.safeParse(validConfiguration).success).toBe(true);
  });

  it("rejects a required task count of zero", () => {
    const parsed = challengeConfiguration.safeParse({
      ...validConfiguration,
      requiredTaskCount: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a step target of zero, which nothing could fail", () => {
    const parsed = challengeConfiguration.safeParse({ ...validConfiguration, stepTarget: 0 });
    expect(parsed.success).toBe(false);
  });
});

describe("movement observation", () => {
  const observation = {
    startedAt: "2026-03-01T14:00:00.000Z",
    endedAt: "2026-03-01T14:20:00.000Z",
    steps: 312,
    provenance: "live-foreground",
    source: "expo-pedometer-ios",
  };

  it("accepts a foreground reading", () => {
    expect(movementObservation.safeParse(observation).success).toBe(true);
  });

  it("accepts a historical reading, which the server rather than the schema rejects", () => {
    const parsed = movementObservation.safeParse({
      ...observation,
      provenance: "historical-query",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an observation that ends before it starts", () => {
    const parsed = movementObservation.safeParse({
      ...observation,
      endedAt: "2026-03-01T13:00:00.000Z",
    });
    expect(parsed.success).toBe(false);
  });

  it("compares instants by value, not by string order", () => {
    const parsed = movementObservation.safeParse({
      ...observation,
      startedAt: "2026-03-01T14:00:00Z",
      endedAt: "2026-03-01T14:00:00.500Z",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a negative step count", () => {
    expect(movementObservation.safeParse({ ...observation, steps: -1 }).success).toBe(false);
  });
});

describe("completion request", () => {
  it("requires the client record ID that is also the idempotency key", () => {
    const parsed = createCompletionRequest.safeParse({
      completedAt: "2026-03-01T14:20:00.000Z",
      observation: {
        startedAt: "2026-03-01T14:00:00.000Z",
        endedAt: "2026-03-01T14:20:00.000Z",
        steps: 312,
        provenance: "live-foreground",
        source: "expo-pedometer-android",
      },
      appVersion: "1.0.0",
      verificationPolicyVersion: "2026-01-01",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("challenge status", () => {
  it("names an ending the owner chose apart from a failure", () => {
    expect(challengeStatus.options).toContain("abandoned");
  });

  it("reports an abandoned challenge as ended, and never an open one", () => {
    const summary = {
      id: "5f0e1a8e-8f4b-4c9a-9d6b-2f1c3e4d5a6b",
      endedAt: "2026-01-06T16:00:00.000Z",
      requiredTaskCount: 30,
      completedTaskCount: 4,
      deposit: { amount: 2000, currency: "USD" },
      depositOutcome: "charged",
    };
    expect(endedChallengeSummary.safeParse({ ...summary, status: "abandoned" }).success).toBe(true);
    expect(endedChallengeSummary.safeParse({ ...summary, status: "active" }).success).toBe(false);
  });
});

describe("error dispositions", () => {
  it("classifies every error code", () => {
    expect(Object.keys(ERROR_DISPOSITIONS).sort()).toEqual([...errorCode.options].sort());
  });

  it("marks exactly the codes a later attempt could answer differently as retryable", () => {
    const retryable = Object.entries(ERROR_DISPOSITIONS)
      .filter(([, disposition]) => disposition === "retry")
      .map(([code]) => code)
      .sort();
    expect(retryable).toEqual(["idempotency_in_progress", "internal_error", "rate_limited"]);
  });

  it("refuses deleting a challenge that has not ended for good", () => {
    expect(ERROR_DISPOSITIONS.challenge_not_ended).toBe("reject");
  });
});
