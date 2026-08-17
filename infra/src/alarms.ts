/**
 * What wakes somebody, and what it takes to make each one fire.
 *
 * Every alarm the architecture lists under Observability is declared here as
 * data first and a construct second. The specification is separate from the
 * CDK objects because the acceptance boundary of issue 38 is that each alarm
 * has been fired once in a test: a test that could only assert a template would
 * be asserting that a threshold is the number somebody typed, which is not the
 * same as knowing the alarm goes off when the thing it names happens.
 * `evaluate` in `alarm-evaluation.ts` runs CloudWatch's own rule over a series
 * of datapoints, and the test drives it from the synthesized template, so an
 * alarm cannot be added without a series that breaches it and one that does not.
 *
 * Two decisions run through the whole list.
 *
 * **Missing data is not the same as good news.** For the metrics that count
 * something going wrong, no datapoint means nothing went wrong, so they are
 * `notBreaching`. For the two backlog levels, which the sweep publishes on
 * every run whatever it found, no datapoint means the sweep did not run, and
 * that is itself the outage: those alarms treat missing data as a breach and
 * are what covers a sweep that stopped being invoked at all.
 *
 * **Every alarm goes to one topic with no subscription of its own.** The topic
 * is the seam; where it is delivered is an account decision that arrives as
 * context, and no address is compiled in.
 */

import { type METRIC_CATALOG, METRIC_DIMENSION, METRIC_NAMESPACE } from "@betterwakeup/server";
import { Duration } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as actions from "aws-cdk-lib/aws-cloudwatch-actions";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";
import type { StackConfiguration } from "./config.ts";

/** How missing datapoints are read, in CloudWatch's own vocabulary. */
export type MissingData = "notBreaching" | "breaching";

export interface AlarmSpec {
  /** The construct id, and the suffix of the alarm's name. */
  readonly id: string;
  /** What an operator is being told. Becomes the alarm description. */
  readonly description: string;
  /**
   * What is watched. A catalogue metric, a Lambda built-in, or the one ratio
   * that needs two metrics.
   */
  readonly watches:
    | { readonly kind: "custom"; readonly metric: keyof typeof METRIC_CATALOG }
    | { readonly kind: "lambda"; readonly metric: "Errors" | "Throttles" }
    | { readonly kind: "errorRate" };
  /** How each period's datapoint is reduced. */
  readonly statistic: "Sum" | "Maximum" | "p95";
  readonly periodMinutes: number;
  readonly threshold: number;
  readonly comparison: "gte" | "gt";
  readonly evaluationPeriods: number;
  readonly datapointsToAlarm: number;
  readonly missingData: MissingData;
}

/**
 * The alarms, in the order Observability lists them.
 *
 * Thresholds are stated in the units of the thing they watch, and each one is
 * chosen to be quiet during ordinary operation rather than to be sensitive: an
 * alarm that fires on a single declined card teaches whoever carries it to
 * ignore the topic, which costs more than the alarm was worth.
 */
export const ALARM_SPECS: readonly AlarmSpec[] = [
  {
    id: "ApiErrorRate",
    description:
      "More than five percent of requests are being answered with a fault rather than a refusal.",
    watches: { kind: "errorRate" },
    statistic: "Sum",
    periodMinutes: 5,
    threshold: 5,
    comparison: "gt",
    evaluationPeriods: 3,
    // Two of three, so one bad five minute window during a deploy is not a
    // page while a sustained fault still is.
    datapointsToAlarm: 2,
    missingData: "notBreaching",
  },
  {
    id: "CompletionAcknowledgmentLatency",
    description:
      "Completions are taking longer than two seconds to acknowledge, which the app shows as an unconfirmed task.",
    watches: { kind: "custom", metric: "CompletionAcknowledgmentLatencyMs" },
    // The tail rather than the average: an average stays healthy while a
    // minority of users watch a spinner, and it is that minority who retry.
    statistic: "p95",
    periodMinutes: 5,
    threshold: 2000,
    comparison: "gt",
    evaluationPeriods: 3,
    datapointsToAlarm: 2,
    missingData: "notBreaching",
  },
  {
    id: "SweepFailure",
    description: "A sweep invocation failed, so overdue tasks may be going unresolved.",
    watches: { kind: "custom", metric: "SweepFailures" },
    statistic: "Sum",
    periodMinutes: 60,
    // One is enough. The sweep runs on a schedule with two attempts, so a
    // failure that reaches this metric has already been retried.
    threshold: 1,
    comparison: "gte",
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    missingData: "notBreaching",
  },
  {
    id: "PaymentWebhookFailures",
    description:
      "Payment webhooks are not being accepted, so funding and settlement events are not being applied.",
    watches: { kind: "custom", metric: "PaymentWebhookFailures" },
    statistic: "Sum",
    periodMinutes: 15,
    // Above one, because a provider probing an endpoint with an unsigned
    // request is normal and a run of failures is not.
    threshold: 3,
    comparison: "gte",
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    missingData: "notBreaching",
  },
  {
    id: "AuthorizationRenewalFailures",
    description: "Authorization renewals are being refused, which leaves deposits unsecured.",
    watches: { kind: "custom", metric: "AuthorizationRenewalFailures" },
    statistic: "Sum",
    // A day, because that is how often the pass that produces these runs. A
    // rate over a shorter window would be a rate over a single sweep.
    periodMinutes: 24 * 60,
    threshold: 5,
    comparison: "gte",
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    missingData: "notBreaching",
  },
  {
    id: "DepositsUnsecured",
    description:
      "A funded challenge has had no live authorization behind its deposit for longer than a day.",
    watches: { kind: "custom", metric: "DepositsUnsecuredOverADay" },
    statistic: "Maximum",
    periodMinutes: 24 * 60,
    threshold: 1,
    comparison: "gte",
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    // The sweep publishes this on every run, so an absent datapoint means the
    // sweep did not run: the one outage that produces no events at all.
    missingData: "breaching",
  },
  {
    id: "OverdueSettlements",
    description: "Settlement commands are sitting past the instant they became eligible.",
    watches: { kind: "custom", metric: "OverdueSettlementCommands" },
    statistic: "Maximum",
    periodMinutes: 24 * 60,
    threshold: 1,
    comparison: "gte",
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    missingData: "breaching",
  },
  {
    id: "UncollectedForfeits",
    description: "A forfeit was refused on every attempt, so money owed has not been collected.",
    watches: { kind: "custom", metric: "UncollectedForfeits" },
    statistic: "Sum",
    periodMinutes: 24 * 60,
    threshold: 1,
    comparison: "gte",
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    missingData: "notBreaching",
  },
  {
    id: "RejectedClientCompletions",
    description:
      "The server is rejecting completions the app believed were valid, which is a contract or logic defect.",
    watches: { kind: "custom", metric: "RejectedClientCompletions" },
    statistic: "Sum",
    periodMinutes: 60,
    // A handful an hour is users walking too little. Ten is the app and the
    // server disagreeing about what a valid completion is.
    threshold: 10,
    comparison: "gte",
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    missingData: "notBreaching",
  },
  {
    id: "FunctionErrors",
    description: "The function is failing before the application can classify the failure.",
    // Lambda's own metric, which catches what the application cannot report:
    // an initialization failure, an out of memory kill, a timeout.
    watches: { kind: "lambda", metric: "Errors" },
    statistic: "Sum",
    periodMinutes: 5,
    threshold: 5,
    comparison: "gte",
    evaluationPeriods: 3,
    datapointsToAlarm: 2,
    missingData: "notBreaching",
  },
  {
    id: "FunctionThrottles",
    description:
      "Requests are being turned away at the reserved concurrency ceiling rather than served.",
    watches: { kind: "lambda", metric: "Throttles" },
    statistic: "Sum",
    periodMinutes: 5,
    threshold: 1,
    comparison: "gte",
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    missingData: "notBreaching",
  },
];

export interface OperationalAlarmsProps {
  readonly configuration: StackConfiguration;
  readonly target: lambda.IFunction;
}

/** The alarms, and the one topic they all notify. */
export class OperationalAlarms extends Construct {
  readonly topic: sns.Topic;
  readonly alarms: readonly cloudwatch.Alarm[];

  constructor(scope: Construct, id: string, props: OperationalAlarmsProps) {
    super(scope, id);
    const { configuration, target } = props;

    this.topic = new sns.Topic(this, "Alerts", {
      topicName: `betterwakeup-alerts-${configuration.stage}`,
      displayName: "BetterWakeUp operational alerts",
    });

    // Optional, and absent in development by design: the topic is the contract,
    // and where it lands is an account decision. `readStackConfiguration`
    // refuses a production synth without one, so the only deployment that can
    // have unheard alarms is the one nobody is relying on.
    if (configuration.alertEmail !== undefined) {
      this.topic.addSubscription(new subscriptions.EmailSubscription(configuration.alertEmail));
    }

    const action = new actions.SnsAction(this.topic);
    this.alarms = ALARM_SPECS.map((spec) => {
      const alarm = new cloudwatch.Alarm(this, spec.id, {
        alarmName: `betterwakeup-${configuration.stage}-${spec.id}`,
        alarmDescription: spec.description,
        metric: metricFor(spec, target, configuration),
        threshold: spec.threshold,
        comparisonOperator:
          spec.comparison === "gte"
            ? cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
            : cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: spec.evaluationPeriods,
        datapointsToAlarm: spec.datapointsToAlarm,
        treatMissingData:
          spec.missingData === "breaching"
            ? cloudwatch.TreatMissingData.BREACHING
            : cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      // Both directions. An alarm that never returns to OK has to be reset by
      // hand, and one that is reset by hand is one somebody eventually leaves
      // disabled.
      alarm.addAlarmAction(action);
      alarm.addOkAction(action);
      return alarm;
    });
  }
}

function metricFor(
  spec: AlarmSpec,
  target: lambda.IFunction,
  configuration: StackConfiguration,
): cloudwatch.IMetric {
  const period = Duration.minutes(spec.periodMinutes);

  if (spec.watches.kind === "lambda") {
    return spec.watches.metric === "Errors"
      ? target.metricErrors({ period, statistic: "Sum" })
      : target.metricThrottles({ period, statistic: "Sum" });
  }

  if (spec.watches.kind === "errorRate") {
    // A ratio rather than a count, because a count that means an outage at
    // pilot volumes means nothing at ten times the traffic, and re-tuning a
    // threshold after every growth step is how alarms stop being trusted.
    return new cloudwatch.MathExpression({
      expression: "100 * errors / requests",
      usingMetrics: {
        errors: customMetric("ApiServerErrors", "Sum", period, configuration),
        requests: customMetric("ApiRequests", "Sum", period, configuration),
      },
      label: "Server error rate (%)",
      period,
    });
  }

  return customMetric(spec.watches.metric, spec.statistic, period, configuration);
}

function customMetric(
  name: keyof typeof METRIC_CATALOG,
  statistic: string,
  period: Duration,
  configuration: StackConfiguration,
): cloudwatch.Metric {
  return new cloudwatch.Metric({
    namespace: METRIC_NAMESPACE,
    metricName: name,
    // The same single dimension the server emits. A mismatch here would leave
    // the alarm watching a metric with no datapoints, which reads as quiet.
    dimensionsMap: { [METRIC_DIMENSION]: configuration.stage },
    statistic,
    period,
  });
}
