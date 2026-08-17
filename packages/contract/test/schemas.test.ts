import { describe, expect, it } from "vitest";
import {
  challengeConfiguration,
  createCompletionRequest,
  depositAmount,
  ERROR_DISPOSITIONS,
  errorCode,
  ianaTimeZone,
  localTime,
  MINIMUM_FUNDED_DEPOSIT_MINOR_UNITS,
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
});
