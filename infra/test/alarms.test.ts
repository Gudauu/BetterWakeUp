/**
 * Issue 38's acceptance boundary: each alarm fired once.
 *
 * The alarms are read out of the synthesized template rather than out of the
 * specification, so what is being fired is the alarm CloudFormation would
 * create. Each one is then given two series: one that is the thing the alarm
 * names happening, and one that is ordinary operation. An alarm that cannot
 * be made to fire, or that fires on the quiet series, fails here.
 *
 * The series live in this file, beside the alarm they belong to, and the table
 * is checked against the template both ways: an alarm with no series and a
 * series naming no alarm are both failures, so the next alarm somebody adds
 * cannot be added without being fired.
 */

import { METRIC_NAMES, METRIC_NAMESPACE } from "@betterwakeup/server";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { type AlarmRule, type Datapoint, evaluate } from "../src/alarm-evaluation.ts";
import { ALARM_SPECS } from "../src/alarms.ts";
import { ApiStack } from "../src/api-stack.ts";
import { PLACEHOLDER_CODE_ASSET_PATH, stackName } from "../src/app.ts";
import { ACTUAL_SPEND_THRESHOLD_PERCENT, FORECAST_THRESHOLD_PERCENT } from "../src/budget.ts";
import { DEFAULT_MONTHLY_BUDGET_USD, type StackConfiguration } from "../src/config.ts";

const configuration: StackConfiguration = {
  stage: "dev",
  region: "us-east-1",
  account: undefined,
  codeAssetPath: PLACEHOLDER_CODE_ASSET_PATH,
  alertEmail: undefined,
  monthlyBudgetUsd: DEFAULT_MONTHLY_BUDGET_USD,
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

interface SynthesizedAlarm {
  readonly name: string;
  readonly rule: AlarmRule;
  readonly properties: Record<string, unknown>;
}

/** Every alarm the template carries, read as the rule CloudWatch would apply. */
function alarmsOf(template: Template): SynthesizedAlarm[] {
  return Object.values(template.findResources("AWS::CloudWatch::Alarm")).map((resource) => {
    const properties = resource.Properties as Record<string, unknown>;
    const name = String(properties.AlarmName);
    return {
      name,
      properties,
      rule: {
        threshold: Number(properties.Threshold),
        comparison:
          properties.ComparisonOperator === "GreaterThanOrEqualToThreshold" ? "gte" : "gt",
        evaluationPeriods: Number(properties.EvaluationPeriods),
        datapointsToAlarm: Number(properties.DatapointsToAlarm ?? properties.EvaluationPeriods),
        missingData: properties.TreatMissingData === "breaching" ? "breaching" : "notBreaching",
      },
    };
  });
}

/**
 * What each alarm is being told about, as datapoints in the alarm's own units,
 * oldest first. `fires` is the incident; `quiet` is a healthy deployment.
 */
const SERIES: Readonly<Record<string, { fires: Datapoint[]; quiet: Datapoint[] }>> = {
  // Six percent of requests faulting, sustained across two of three windows.
  ApiErrorRate: { fires: [0.4, 6.2, 7.1], quiet: [0.4, 6.2, 0.9] },
  // The slow tail crossing two seconds and staying there.
  CompletionAcknowledgmentLatency: { fires: [400, 2600, 3100], quiet: [400, 2600, 900] },
  // One sweep invocation that failed after its own retries.
  SweepFailure: { fires: [1], quiet: [null] },
  // A run of deliveries the server would not accept.
  PaymentWebhookFailures: { fires: [4], quiet: [1] },
  // Five holds the provider refused over a day.
  AuthorizationRenewalFailures: { fires: [5], quiet: [2] },
  // One deposit that has been unsecured for longer than a day. The quiet
  // series is an explicit zero, because a missing datapoint here means the
  // sweep stopped running and is a breach in its own right.
  DepositsUnsecured: { fires: [1], quiet: [0] },
  OverdueSettlements: { fires: [3], quiet: [0] },
  UncollectedForfeits: { fires: [1], quiet: [0] },
  RejectedClientCompletions: { fires: [12], quiet: [3] },
  FunctionErrors: { fires: [6, 8], quiet: [6, 1] },
  FunctionThrottles: { fires: [1], quiet: [0] },
};

const template = synthesize();
const alarms = alarmsOf(template);

function alarmFor(id: string): SynthesizedAlarm {
  const found = alarms.find((alarm) => alarm.name.endsWith(`-${id}`));
  if (found === undefined) throw new Error(`no synthesized alarm for ${id}`);
  return found;
}

describe("each alarm", () => {
  it("covers everything Observability asks to be alarmed on and nothing that is unfireable", () => {
    expect(alarms).toHaveLength(ALARM_SPECS.length);
    expect(Object.keys(SERIES).sort()).toEqual(ALARM_SPECS.map((spec) => spec.id).sort());
  });

  for (const spec of ALARM_SPECS) {
    it(`fires on ${spec.id}, and stays quiet on ordinary traffic`, () => {
      const alarm = alarmFor(spec.id);
      const series = SERIES[spec.id];
      if (series === undefined) throw new Error(`no series for ${spec.id}`);

      expect(evaluate(alarm.rule, series.fires)).toBe("ALARM");
      expect(evaluate(alarm.rule, series.quiet)).toBe("OK");
    });
  }

  it("says what it means, so whoever is woken by it knows what happened", () => {
    for (const spec of ALARM_SPECS) {
      expect(alarmFor(spec.id).properties.AlarmDescription).toBe(spec.description);
    }
  });

  it("treats a silent sweep as a breach and a silent error counter as calm", () => {
    // The distinction the whole missing-data decision rests on: with no
    // datapoints at all, the backlog alarms fire and the incident counters
    // do not.
    expect(evaluate(alarmFor("DepositsUnsecured").rule, [])).toBe("ALARM");
    expect(evaluate(alarmFor("OverdueSettlements").rule, [])).toBe("ALARM");
    expect(evaluate(alarmFor("SweepFailure").rule, [])).toBe("OK");
    expect(evaluate(alarmFor("PaymentWebhookFailures").rule, [])).toBe("OK");
  });
});

describe("what the alarms watch", () => {
  it("names only metrics the server emits or Lambda publishes", () => {
    const known = new Set<string>([...METRIC_NAMES, "Errors", "Throttles"]);
    for (const alarm of alarms) {
      const direct = alarm.properties.MetricName;
      if (direct !== undefined) {
        expect(known).toContain(String(direct));
        continue;
      }
      // A math expression alarm: every metric it reads has to be known too.
      const queries = alarm.properties.Metrics as {
        MetricStat?: { Metric: { MetricName: string } };
      }[];
      const referenced = queries.flatMap((query) =>
        query.MetricStat === undefined ? [] : [query.MetricStat.Metric.MetricName],
      );
      expect(referenced.length).toBeGreaterThan(0);
      for (const name of referenced) expect(known).toContain(name);
    }
  });

  it("reads the custom metrics from the namespace and dimension the server writes", () => {
    const custom = alarms.filter((alarm) => alarm.properties.Namespace === METRIC_NAMESPACE);
    expect(custom.length).toBeGreaterThan(0);
    for (const alarm of custom) {
      expect(alarm.properties.Dimensions).toEqual([{ Name: "Stage", Value: "dev" }]);
    }
  });

  it("keeps one stage's alarms from reading another's numbers", () => {
    const prod = alarmsOf(synthesize({ stage: "prod", alertEmail: "oncall@example.com" })).filter(
      (alarm) => alarm.properties.Namespace === METRIC_NAMESPACE,
    );
    for (const alarm of prod) {
      expect(alarm.properties.Dimensions).toEqual([{ Name: "Stage", Value: "prod" }]);
    }
  });
});

describe("where an alarm is delivered", () => {
  it("notifies one topic, in both directions, from every alarm", () => {
    template.resourceCountIs("AWS::SNS::Topic", 1);
    for (const alarm of alarms) {
      expect(alarm.properties.AlarmActions).toHaveLength(1);
      expect(alarm.properties.OKActions).toEqual(alarm.properties.AlarmActions);
    }
  });

  it("subscribes the address the context named, and nothing when it named none", () => {
    template.resourceCountIs("AWS::SNS::Subscription", 0);

    synthesize({ alertEmail: "oncall@example.com" }).hasResourceProperties(
      "AWS::SNS::Subscription",
      Match.objectLike({ Protocol: "email", Endpoint: "oncall@example.com" }),
    );
  });
});

describe("the budget", () => {
  it("caps monthly spend and reports both what happened and what is forecast", () => {
    const withEmail = synthesize({ alertEmail: "oncall@example.com" });
    withEmail.resourceCountIs("AWS::Budgets::Budget", 1);
    withEmail.hasResourceProperties(
      "AWS::Budgets::Budget",
      Match.objectLike({
        Budget: Match.objectLike({
          BudgetType: "COST",
          TimeUnit: "MONTHLY",
          BudgetLimit: { Amount: DEFAULT_MONTHLY_BUDGET_USD, Unit: "USD" },
        }),
        NotificationsWithSubscribers: Match.arrayWith([
          Match.objectLike({
            Notification: Match.objectLike({
              NotificationType: "ACTUAL",
              Threshold: ACTUAL_SPEND_THRESHOLD_PERCENT,
            }),
            Subscribers: [{ SubscriptionType: "EMAIL", Address: "oncall@example.com" }],
          }),
          Match.objectLike({
            Notification: Match.objectLike({
              NotificationType: "FORECASTED",
              Threshold: FORECAST_THRESHOLD_PERCENT,
            }),
          }),
        ]),
      }),
    );
  });

  it("takes the ceiling from context when one is given", () => {
    synthesize({ alertEmail: "oncall@example.com", monthlyBudgetUsd: 75 }).hasResourceProperties(
      "AWS::Budgets::Budget",
      Match.objectLike({
        Budget: Match.objectLike({ BudgetLimit: { Amount: 75, Unit: "USD" } }),
      }),
    );
  });

  it("writes no budget when there is nobody for it to notify", () => {
    // A budget exists to send a notification. One with no subscriber is a
    // resource that reads as a cost control and is not.
    template.resourceCountIs("AWS::Budgets::Budget", 0);
  });
});
