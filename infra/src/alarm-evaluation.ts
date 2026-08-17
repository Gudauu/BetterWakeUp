/**
 * CloudWatch's alarm rule, written out so an alarm can be fired in a test.
 *
 * Issue 38 is done when each alarm has been fired once. Firing them against the
 * real service would mean a deployed stack, an hour of waiting per evaluation
 * period, and a way to manufacture uncollected forfeits in a live account. What
 * is actually being asked is narrower and testable: given the datapoints the
 * thing this alarm names would produce, does the alarm go off, and given
 * ordinary datapoints, does it stay quiet.
 *
 * So this is the evaluation rule itself, applied to a series a test states. It
 * is deliberately small and covers exactly the two behaviours the alarms here
 * use: the M-out-of-N window, and what an absent datapoint counts as.
 *
 * The rule, from CloudWatch's documentation: the last N periods are examined,
 * the alarm goes to ALARM when at least M of them breach, and a period with no
 * datapoint counts as breaching or not breaching according to the alarm's own
 * setting. Anything else CloudWatch does (insufficient data before an alarm has
 * history, `ignore`, `missing`) is not modelled, because no alarm here uses it.
 */

import type { AlarmSpec } from "./alarms.ts";

/** A period's datapoint, or `null` for a period that produced none. */
export type Datapoint = number | null;

export type AlarmState = "ALARM" | "OK";

/**
 * The comparison and window an evaluation needs.
 *
 * Taken as a structure rather than an `AlarmSpec`, so a test can build it from
 * the synthesized template. That is the point: evaluating the specification
 * would prove the specification consistent with itself, while evaluating what
 * the template says proves the alarm CloudFormation will create is the one that
 * fires.
 */
export interface AlarmRule {
  readonly threshold: number;
  readonly comparison: "gte" | "gt";
  readonly evaluationPeriods: number;
  readonly datapointsToAlarm: number;
  readonly missingData: "breaching" | "notBreaching";
}

export function ruleOf(spec: AlarmSpec): AlarmRule {
  return {
    threshold: spec.threshold,
    comparison: spec.comparison,
    evaluationPeriods: spec.evaluationPeriods,
    datapointsToAlarm: spec.datapointsToAlarm,
    missingData: spec.missingData,
  };
}

/**
 * The state a rule reaches over a series, oldest datapoint first.
 *
 * A series shorter than the evaluation window is padded at the front with
 * missing periods, which is what CloudWatch sees for a metric that has only
 * just started reporting.
 */
export function evaluate(rule: AlarmRule, series: readonly Datapoint[]): AlarmState {
  const window = [
    ...Array.from<Datapoint>({ length: Math.max(0, rule.evaluationPeriods - series.length) }).fill(
      null,
    ),
    ...series,
  ].slice(-rule.evaluationPeriods);

  const breaches = window.filter((point) => breaching(rule, point)).length;
  return breaches >= rule.datapointsToAlarm ? "ALARM" : "OK";
}

function breaching(rule: AlarmRule, point: Datapoint): boolean {
  if (point === null) return rule.missingData === "breaching";
  return rule.comparison === "gte" ? point >= rule.threshold : point > rule.threshold;
}
