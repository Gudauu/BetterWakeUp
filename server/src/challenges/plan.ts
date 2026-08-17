/**
 * Turning a challenge configuration into a plan.
 *
 * A plan is the task list the schedule engine derives plus the three facts the
 * projection screen shows. `POST /challenges/projections` returns the second
 * half and throws the first away; `POST /challenges` writes both. They call
 * the same function with the same arguments, which is what makes "the
 * projection equals the schedule later materialized from the same
 * configuration" true by construction rather than by two implementations
 * agreeing.
 *
 * The maximum duration rule lives here too, because it is a property of a
 * configuration and an instant and nothing else. It is reported rather than
 * enforced: the projection is a question the app asks before the user has
 * committed to anything, so the answer is a flag. Enforcement belongs to the
 * command that takes the money, which is the funding intent in issue 19.
 */

import {
  type ChallengeConfiguration,
  type CreateProjectionResponse,
  MAXIMUM_CHALLENGE_DURATION_DAYS,
  MINIMUM_FUNDED_DEPOSIT_MINOR_UNITS,
} from "@betterwakeup/contract";

import { AppError } from "../errors/app-error.ts";
import {
  daysBetween,
  type MaterializedTask,
  materializeSchedule,
  type ScheduleConfiguration,
} from "../schedule/engine.ts";
import { localDateOf } from "../schedule/zoned-time.ts";

export interface ChallengePlan {
  /** Exactly `requiredTaskCount` tasks, which is what the database will hold it to. */
  readonly tasks: readonly MaterializedTask[];
  readonly projection: CreateProjectionResponse;
}

/** The part of a configuration the schedule engine reads. */
export function scheduleConfigurationOf(
  configuration: ChallengeConfiguration,
): ScheduleConfiguration {
  return {
    requiredTaskCount: configuration.requiredTaskCount,
    schedule: configuration.schedule,
    noRegretMinutes: configuration.noRegretMinutes,
    timeZone: configuration.timeZone,
  };
}

/**
 * The deposit rule, restated in the domain.
 *
 * The contract already rejects an amount between zero and the funded minimum,
 * so a request arriving over HTTP is refused at the validation boundary and
 * never reaches here. This is the second statement of the same rule for the
 * callers that are not HTTP requests: the sweep, a future administrative path,
 * and the tests that call the domain directly. A money rule stated only at the
 * edge is a money rule that holds only for the edge.
 */
export function assertDepositAmount(configuration: ChallengeConfiguration): void {
  const { amount } = configuration.deposit;
  if (amount > 0 && amount < MINIMUM_FUNDED_DEPOSIT_MINOR_UNITS) {
    throw new AppError(
      "deposit_amount_invalid",
      `A deposit is either nothing at all or at least ${MINIMUM_FUNDED_DEPOSIT_MINOR_UNITS} minor units. ${amount} is neither.`,
    );
  }
}

/**
 * The schedule this configuration produces for a challenge starting now, and
 * what the app needs to show about it.
 */
export function planChallenge(
  configuration: ChallengeConfiguration,
  startingAt: Date,
): ChallengePlan {
  assertDepositAmount(configuration);

  const tasks = materializeSchedule(scheduleConfigurationOf(configuration), startingAt);
  const first = tasks[0];
  const last = tasks[tasks.length - 1];
  if (first === undefined || last === undefined) {
    throw new AppError("internal_error", "a materialized schedule has no tasks");
  }

  return {
    tasks,
    projection: {
      firstTaskDate: first.date,
      firstTaskDeadline: first.deadline.toISOString(),
      projectedEndDate: last.date,
      withinMaximumDuration: isWithinMaximumDuration(configuration, startingAt, last.date),
    },
  };
}

/**
 * Whether a funded challenge with this configuration would end inside the
 * maximum duration.
 *
 * Always true for a zero deposit challenge: the rule exists because an
 * authorization cannot be held indefinitely, and there is nothing to hold. The
 * span is measured in calendar days in the challenge's own zone, from the day
 * the money would be taken to the day the last task falls on, so it does not
 * change because a transition made one of those days 23 hours long.
 */
export function isWithinMaximumDuration(
  configuration: ChallengeConfiguration,
  startingAt: Date,
  projectedEndDate: string,
): boolean {
  if (configuration.deposit.amount === 0) return true;
  const startDate = localDateOf(startingAt, configuration.timeZone);
  return daysBetween(startDate, projectedEndDate) <= MAXIMUM_CHALLENGE_DURATION_DAYS;
}
