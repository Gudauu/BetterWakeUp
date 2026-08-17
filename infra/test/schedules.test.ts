import { createHandler, isHttpEvent, isScheduledEvent } from "@betterwakeup/server";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ApiStack } from "../src/api-stack.ts";
import { PLACEHOLDER_CODE_ASSET_PATH, stackName } from "../src/app.ts";
import type { StackConfiguration } from "../src/config.ts";
import {
  DAILY_SWEEP_DETAIL_TYPE,
  DAILY_SWEEP_UTC_HOUR,
  SCHEDULE_MAX_EVENT_AGE,
  SCHEDULE_RETRY_ATTEMPTS,
  WARM_LOCAL_HOURS,
  WARM_TICK_DETAIL_TYPE,
  WARM_UTC_OFFSETS,
  warmUtcHours,
} from "../src/schedules.ts";

const configuration: StackConfiguration = {
  stage: "dev",
  region: "us-east-1",
  account: undefined,
  codeAssetPath: PLACEHOLDER_CODE_ASSET_PATH,
};

function synthesize(overrides: Partial<StackConfiguration> = {}): Template {
  const app = new App();
  const merged = { ...configuration, ...overrides };
  const stack = new ApiStack(app, stackName(merged), {
    configuration: merged,
    env: { region: merged.region },
  });
  return Template.fromStack(stack);
}

/** The synthesized schedules, keyed by the detail type each one sends. */
function schedulesByDetailType(template: Template): Map<string, Record<string, unknown>> {
  const found = new Map<string, Record<string, unknown>>();
  for (const resource of Object.values(template.findResources("AWS::Scheduler::Schedule"))) {
    const target = resource.Properties?.Target as { Input?: string } | undefined;
    const input = JSON.parse(target?.Input ?? "{}") as Record<string, unknown>;
    found.set(String(input["detail-type"]), resource.Properties as Record<string, unknown>);
  }
  return found;
}

describe("the warm hour derivation", () => {
  it("turns a local deadline window and a set of offsets into UTC hours", () => {
    // 06:00 local at UTC-5 is 11:00 UTC; at UTC+1 it is 05:00 UTC.
    expect(warmUtcHours({ first: 6, last: 6 }, [-5, 1])).toEqual([5, 11]);
  });

  it("wraps rather than producing an hour outside a day", () => {
    expect(warmUtcHours({ first: 4, last: 5 }, [-8])).toEqual([12, 13]);
    expect(warmUtcHours({ first: 4, last: 5 }, [8])).toEqual([20, 21]);
    for (const hour of warmUtcHours({ first: 0, last: 23 }, [-12, 14])) {
      expect(hour).toBeGreaterThanOrEqual(0);
      expect(hour).toBeLessThan(24);
    }
  });

  it("collapses offsets that put the same local hour on the same UTC hour", () => {
    expect(warmUtcHours({ first: 7, last: 7 }, [-5, -5, -5])).toEqual([12]);
  });

  it("leaves hours uncovered, so warmth stays extra ticks rather than every hour", () => {
    const hours = warmUtcHours();
    expect(hours.length).toBeGreaterThan(0);
    expect(hours.length).toBeLessThan(24);
    // The daily pass is deliberately outside the warm window, so a failure of
    // the warm schedule cannot be mistaken for the correctness pass running.
    expect(hours).not.toContain(DAILY_SWEEP_UTC_HOUR);
  });

  it("covers every configured market's whole deadline window", () => {
    const hours = new Set(warmUtcHours());
    for (const offset of WARM_UTC_OFFSETS) {
      for (let local = WARM_LOCAL_HOURS.first; local <= WARM_LOCAL_HOURS.last; local += 1) {
        expect(hours.has((((local - offset) % 24) + 24) % 24)).toBe(true);
      }
    }
  });
});

describe("the sweep schedules", () => {
  it("defines the daily correctness pass and the warm ticks as two schedules", () => {
    const template = synthesize();
    template.resourceCountIs("AWS::Scheduler::Schedule", 2);
    expect([...schedulesByDetailType(template).keys()].sort()).toEqual(
      [DAILY_SWEEP_DETAIL_TYPE, WARM_TICK_DETAIL_TYPE].sort(),
    );
  });

  it("runs the daily pass once a day at the hour it names", () => {
    const daily = schedulesByDetailType(synthesize()).get(DAILY_SWEEP_DETAIL_TYPE);
    expect(daily?.ScheduleExpression).toBe(`cron(0 ${DAILY_SWEEP_UTC_HOUR} * * ? *)`);
  });

  it("runs a warm tick at every derived hour", () => {
    const warm = schedulesByDetailType(synthesize()).get(WARM_TICK_DETAIL_TYPE);
    expect(warm?.ScheduleExpression).toBe(`cron(0 ${warmUtcHours().join(",")} * * ? *)`);
  });

  it("names each schedule for its stage, so dev and prod do not collide", () => {
    for (const stage of ["dev", "prod"] as const) {
      const names = Object.values(
        synthesize({ stage }).findResources("AWS::Scheduler::Schedule"),
      ).map((resource) => resource.Properties?.Name as string);
      expect(names.sort()).toEqual([
        `betterwakeup-sweep-daily-${stage}`,
        `betterwakeup-sweep-warm-${stage}`,
      ]);
    }
  });

  it("invokes the one function the Function URL also fronts", () => {
    const template = synthesize();
    template.resourceCountIs("AWS::Lambda::Function", 1);
    const functionId = Object.keys(template.findResources("AWS::Lambda::Function"))[0];
    for (const properties of schedulesByDetailType(template).values()) {
      const target = properties.Target as { Arn?: unknown };
      expect(JSON.stringify(target.Arn)).toContain(functionId);
    }
  });

  it("grants each schedule's role nothing but invoking that function", () => {
    const template = synthesize();
    const policies = Object.values(template.findResources("AWS::IAM::Policy"));
    const schedulerPolicies = policies.filter((policy) =>
      JSON.stringify(policy).includes("lambda:InvokeFunction"),
    );
    expect(schedulerPolicies.length).toBeGreaterThan(0);
    for (const policy of schedulerPolicies) {
      const statements = (policy.Properties?.PolicyDocument as { Statement: { Action: unknown }[] })
        .Statement;
      for (const statement of statements) {
        expect(statement.Action).toBe("lambda:InvokeFunction");
      }
    }
    // Assumed by scheduler.amazonaws.com and nothing else.
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Principal: { Service: "scheduler.amazonaws.com" } }),
        ]),
      }),
    });
  });

  it("bounds how long a missed invocation is worth retrying", () => {
    for (const properties of schedulesByDetailType(synthesize()).values()) {
      const target = properties.Target as { RetryPolicy?: Record<string, number> };
      expect(target.RetryPolicy).toEqual({
        MaximumEventAgeInSeconds: SCHEDULE_MAX_EVENT_AGE.toSeconds(),
        MaximumRetryAttempts: SCHEDULE_RETRY_ATTEMPTS,
      });
    }
  });
});

describe("what a schedule actually delivers to the function", () => {
  /** The payload as EventBridge Scheduler sends it: context attributes filled in. */
  function delivered(detailType: string): unknown {
    const properties = schedulesByDetailType(synthesize()).get(detailType);
    const input = (properties?.Target as { Input: string }).Input;
    return JSON.parse(input.replace("<aws.scheduler.scheduled-time>", "2026-08-17T20:00:00Z"));
  }

  it("sends the scheduled instant rather than leaving the sweep to read a clock", () => {
    expect(delivered(DAILY_SWEEP_DETAIL_TYPE)).toMatchObject({ time: "2026-08-17T20:00:00Z" });
  });

  for (const detailType of [DAILY_SWEEP_DETAIL_TYPE, WARM_TICK_DETAIL_TYPE]) {
    it(`is recognized by the server as a scheduled event: ${detailType}`, () => {
      const event = delivered(detailType);
      expect(isScheduledEvent(event)).toBe(true);
      expect(isHttpEvent(event)).toBe(false);
    });

    it(`reaches the sweep and never an HTTP route: ${detailType}`, async () => {
      const seen: unknown[] = [];
      // A handler whose HTTP arm is the real application. If the payload ever
      // stopped being recognized as scheduled, this would answer with a 404
      // from a route table instead of failing, which is exactly the confusion
      // the discrimination exists to prevent.
      const handler = createHandler({
        sweep: async (event) => {
          seen.push(event);
          return await Promise.resolve({
            tasksMissed: 0,
            tasksSkipped: 0,
            tasksResolved: 0,
            challengesFailed: 0,
            challengesInRecovery: 0,
            challengesExpired: 0,
            settlementsCreated: 0,
            authorizationsReleased: 0,
            forfeitsCollected: 0,
            forfeitsUncollected: 0,
            authorizationsRenewed: 0,
            renewalsFailed: 0,
            moreWorkPending: false,
          });
        },
      });

      const result = (await handler(delivered(detailType))) as { moreWorkPending: boolean };

      expect(seen).toHaveLength(1);
      expect(result.moreWorkPending).toBe(false);
      // Nothing an HTTP response carries: no status, no headers, no body.
      expect(result).not.toHaveProperty("statusCode");
      expect(result).not.toHaveProperty("body");
    });
  }
});
