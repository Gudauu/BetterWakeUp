/**
 * When the sweep runs.
 *
 * The architecture asks for two different things from the same pass. Correctness
 * is satisfied by a single daily invocation, because nothing in the product is
 * required to happen within minutes of a deadline. Warmth is the other half:
 * extra ticks through the hours that actually contain deadlines keep both the
 * Lambda execution environment and the autosuspending Neon compute alive while
 * users are completing tasks.
 *
 * The two are separate schedules rather than one dense expression, so the daily
 * pass survives any future decision to narrow, widen, or disable the warm
 * window. Disabling warmth must not be able to disable correctness.
 *
 * Both targets carry a fixed input rather than relying on whatever EventBridge
 * would otherwise send, because the Lambda handler discriminates a scheduled
 * invocation on `source` alone. That input is the entire contract between this
 * file and `server/src/lambda/events.ts`.
 */

import { Duration } from "aws-cdk-lib";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as targets from "aws-cdk-lib/aws-scheduler-targets";
import { Construct } from "constructs";
import type { StackConfiguration } from "./config.ts";

/**
 * The `source` value the Lambda handler recognizes as a scheduled invocation.
 *
 * EventBridge Scheduler does not stamp this itself when the target has a fixed
 * input: the whole payload is ours to write. Getting it wrong does not produce
 * a scheduled invocation that misbehaves, it produces one the handler refuses
 * outright, which is the failure mode worth having.
 */
export const SCHEDULED_EVENT_SOURCE = "aws.scheduler";

/** How the two schedules name themselves in the payload and in the logs. */
export const DAILY_SWEEP_DETAIL_TYPE = "bwu.sweep.daily";
export const WARM_TICK_DETAIL_TYPE = "bwu.sweep.warm";

/**
 * The UTC hour of the daily correctness pass.
 *
 * 20:00 UTC is afternoon in the Americas and late evening in Europe: outside
 * every hour the warm window below covers, so the correctness pass is
 * observable on its own rather than hidden inside a tick that would have run
 * anyway. A test holds that separation, because the warm hours are derived and
 * a change to a market could otherwise swallow this one silently.
 */
export const DAILY_SWEEP_UTC_HOUR = 20;

/**
 * The local hours a wake-up deadline falls in.
 *
 * A challenge is a morning task, so its deadline is a morning hour. The window
 * is inclusive at both ends and deliberately wider than the hours users pick,
 * because a tick has to be warm *before* the deadline it is warm for.
 */
export const WARM_LOCAL_HOURS = { first: 4, last: 10 } as const;

/**
 * The UTC offsets the warm window is computed for.
 *
 * Warmth is not a correctness property, so it is scoped to where users are
 * rather than to every offset on earth: crossing all 26 of those with a seven
 * hour local window covers all 24 UTC hours, which would silently turn "extra
 * ticks" into "hourly forever". These are the offsets of North America and
 * western Europe in standard time.
 *
 * Standard time rather than daylight time is intentional. Shifting the set by
 * an hour twice a year would need this stack redeployed to stay correct, and
 * `WARM_LOCAL_HOURS` is already wider than the deadlines it covers by more than
 * that hour.
 */
export const WARM_UTC_OFFSETS = [-8, -7, -6, -5, -4, 0, 1, 2] as const;

/**
 * The UTC hours a warm tick fires at, derived rather than listed.
 *
 * Listing them would make the two constants above decorative: the point of
 * deriving is that changing a market or a deadline hour changes the schedule,
 * and a test can assert the relationship instead of a copy of the answer.
 */
export function warmUtcHours(
  localHours: { readonly first: number; readonly last: number } = WARM_LOCAL_HOURS,
  offsets: readonly number[] = WARM_UTC_OFFSETS,
): number[] {
  const hours = new Set<number>();
  for (let local = localHours.first; local <= localHours.last; local += 1) {
    for (const offset of offsets) {
      // Local time minus the offset is UTC, wrapped into a day. The `+ 24` is
      // what keeps a western offset from producing a negative hour.
      hours.add((((local - offset) % 24) + 24) % 24);
    }
  }
  return [...hours].sort((a, b) => a - b);
}

/**
 * How long a missed invocation stays worth delivering.
 *
 * The sweep is idempotent and selects work by the state that makes it due, so a
 * retry is always safe. It is bounded anyway: an invocation delivered hours late
 * does nothing the next scheduled tick would not do, so retrying past that is
 * spending on a duplicate.
 */
export const SCHEDULE_MAX_EVENT_AGE = Duration.minutes(30);

/** Retries within that age. Safe because the sweep is idempotent. */
export const SCHEDULE_RETRY_ATTEMPTS = 2;

export interface SweepSchedulesProps {
  readonly configuration: StackConfiguration;
  /** The function both schedules invoke: the same one the Function URL fronts. */
  readonly target: lambda.IFunction;
}

/**
 * The payload a schedule sends.
 *
 * `time` is filled in by EventBridge Scheduler from the context attribute, so
 * the sweep reads the instant it was scheduled for rather than the instant the
 * container happened to start, which differ by a cold start and by any retry.
 */
export function sweepEventInput(detailType: string): scheduler.ScheduleTargetInput {
  return scheduler.ScheduleTargetInput.fromObject({
    source: SCHEDULED_EVENT_SOURCE,
    "detail-type": detailType,
    time: scheduler.ContextAttribute.scheduledTime,
  });
}

/** The daily correctness pass plus the warm ticks, both invoking one function. */
export class SweepSchedules extends Construct {
  readonly daily: scheduler.Schedule;
  readonly warm: scheduler.Schedule;

  constructor(scope: Construct, id: string, props: SweepSchedulesProps) {
    super(scope, id);
    const { configuration, target } = props;

    this.daily = new scheduler.Schedule(this, "Daily", {
      scheduleName: `betterwakeup-sweep-daily-${configuration.stage}`,
      description: "The daily overdue sweep. Correctness does not depend on any other tick.",
      schedule: scheduler.ScheduleExpression.cron({
        minute: "0",
        hour: String(DAILY_SWEEP_UTC_HOUR),
        day: "*",
        month: "*",
        year: "*",
      }),
      target: new targets.LambdaInvoke(target, {
        input: sweepEventInput(DAILY_SWEEP_DETAIL_TYPE),
        maxEventAge: SCHEDULE_MAX_EVENT_AGE,
        retryAttempts: SCHEDULE_RETRY_ATTEMPTS,
      }),
    });

    this.warm = new scheduler.Schedule(this, "Warm", {
      scheduleName: `betterwakeup-sweep-warm-${configuration.stage}`,
      description:
        "Extra ticks across the hours containing common deadlines, for warmth and promptness.",
      schedule: scheduler.ScheduleExpression.cron({
        minute: "0",
        hour: warmUtcHours().join(","),
        day: "*",
        month: "*",
        year: "*",
      }),
      target: new targets.LambdaInvoke(target, {
        input: sweepEventInput(WARM_TICK_DETAIL_TYPE),
        maxEventAge: SCHEDULE_MAX_EVENT_AGE,
        retryAttempts: SCHEDULE_RETRY_ATTEMPTS,
      }),
    });
  }
}
