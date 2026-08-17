/**
 * The spend ceiling, and who hears about it.
 *
 * The architecture's cost argument is that this design runs on free tiers, so
 * the useful budget is not a forecast of growth but a tripwire: any real bill
 * means a loop, a leak, or a mistake, and the point is to hear about it in
 * hours rather than at the end of a month.
 *
 * Two notifications rather than one. The actual-spend threshold is what
 * happened; the forecast threshold is what is about to happen, which for a
 * runaway invocation loop arrives days earlier and is the only one that
 * arrives in time to matter.
 *
 * A CloudWatch alarm on `AWS/Billing`'s `EstimatedCharges` would be the other
 * way to do this, and it is deliberately not used: that metric is published
 * only in `us-east-1`, and this stack lives in whichever region Neon runs the
 * database in. An alarm in a second region would mean a second stack whose only
 * content is one alarm, and the budget's forecast notification already covers
 * what it would have said, several days sooner.
 *
 * Subscribers are email addresses rather than the alarm topic. AWS Budgets
 * requires an SNS topic in `us-east-1` and a topic policy naming the budgets
 * service, which is the same cross-region stack the billing alarm would have
 * needed. A budget with no subscriber at all is not written: it would be a
 * resource whose entire purpose is to notify, notifying nobody.
 */

import * as budgets from "aws-cdk-lib/aws-budgets";
import { Construct } from "constructs";
import type { StackConfiguration } from "./config.ts";

/** Where actual spend is reported. Well inside a month's free-tier headroom. */
export const ACTUAL_SPEND_THRESHOLD_PERCENT = 50;

/** Where a forecast is reported. Reaching the ceiling is the thing to prevent. */
export const FORECAST_THRESHOLD_PERCENT = 100;

export interface CostBudgetProps {
  readonly configuration: StackConfiguration;
}

export class CostBudget extends Construct {
  /** The budget, or undefined when there is nobody to notify. */
  readonly budget: budgets.CfnBudget | undefined;

  constructor(scope: Construct, id: string, props: CostBudgetProps) {
    super(scope, id);
    const { configuration } = props;
    const email = configuration.alertEmail;
    if (email === undefined) return;

    const subscribers = [{ subscriptionType: "EMAIL", address: email }];

    this.budget = new budgets.CfnBudget(this, "Monthly", {
      budget: {
        budgetName: `betterwakeup-${configuration.stage}-monthly`,
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: configuration.monthlyBudgetUsd, unit: "USD" },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: "ACTUAL",
            comparisonOperator: "GREATER_THAN",
            threshold: ACTUAL_SPEND_THRESHOLD_PERCENT,
            thresholdType: "PERCENTAGE",
          },
          subscribers,
        },
        {
          notification: {
            notificationType: "FORECASTED",
            comparisonOperator: "GREATER_THAN",
            threshold: FORECAST_THRESHOLD_PERCENT,
            thresholdType: "PERCENTAGE",
          },
          subscribers,
        },
      ],
    });
  }
}
