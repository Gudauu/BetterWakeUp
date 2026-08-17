/**
 * The operational metrics the alarms are built on.
 *
 * Every alarm the architecture lists under Observability watches either a
 * metric AWS publishes for us (Lambda's own `Errors`, `Throttles`, and
 * `Duration`) or one of the ten named here. Nothing else is emitted, and the
 * set is closed for two reasons.
 *
 * The first is cost. CloudWatch's free allowance is ten custom metrics, and a
 * custom metric is billed per unique name and dimension combination, so a
 * metric carrying an account or a challenge as a dimension would bill per
 * account. The dimension set is therefore the stage and nothing else, and a
 * test asserts the catalogue never grows past the allowance.
 *
 * The second is that a metric is a public interface. The infrastructure package
 * builds its alarms from `METRIC_CATALOG` and `METRIC_NAMESPACE`, so a metric
 * renamed here and not there would leave an alarm watching nothing, which is
 * the failure mode where an alarm is worse than no alarm at all: it reads as
 * quiet rather than as broken. An infrastructure test asserts every alarm's
 * metric is one of these.
 *
 * Values travel as CloudWatch's embedded metric format: a JSON line on the
 * function's own log stream that CloudWatch extracts metrics from. That means
 * no `PutMetricData` call, so no added latency on a request path, no IAM grant
 * beyond writing logs, and no metric lost when an invocation is frozen before
 * a network call completes.
 */

/** What a metric counts, which is also its CloudWatch unit. */
export type MetricUnit = "Count" | "Milliseconds";

/**
 * Every metric this server emits, and what it means.
 *
 * The comments matter as much as the names: an alarm is only actionable if the
 * person woken by it can tell what the number counted.
 */
export const METRIC_CATALOG = {
  /** Every request that reached the application, including the ones it refused. */
  ApiRequests: "Count",
  /**
   * Requests answered with a 5xx: our own failures, never a refusal. The
   * elevated-error-rate alarm is these over `ApiRequests`.
   */
  ApiServerErrors: "Count",
  /**
   * How long the server took to acknowledge a completion, measured from the
   * request arriving to the response leaving. This is the half of the app's
   * acknowledgment latency the server can see; the app's own retry backoff is
   * the other half and is not ours to measure from here.
   */
  CompletionAcknowledgmentLatencyMs: "Milliseconds",
  /**
   * Sweep invocations that ended in a failure rather than a result. Separate
   * from Lambda's `Errors` because a sweep that throws and a request that
   * throws are the same Lambda metric, and only one of them means overdue
   * tasks are going unresolved.
   */
  SweepFailures: "Count",
  /** Webhook deliveries the server could not accept, by signature or by fault. */
  PaymentWebhookFailures: "Count",
  /** Renewal attempts the provider refused, leaving a deposit unsecured. */
  AuthorizationRenewalFailures: "Count",
  /**
   * Funded challenges whose deposit has been without a live authorization for
   * longer than a day. A level rather than an event: the sweep measures it on
   * every run, so the alarm reads the current backlog rather than a rate.
   */
  DepositsUnsecuredOverADay: "Count",
  /** Pending settlement commands whose `execute_after` instant has passed. */
  OverdueSettlementCommands: "Count",
  /** Forfeits the provider refused on every attempt, which is money owed and unpaid. */
  UncollectedForfeits: "Count",
  /**
   * Completions the server rejected on the movement evidence itself. A user
   * who really walked should not see one, so any sustained volume is a contract
   * or logic defect rather than user behaviour.
   */
  RejectedClientCompletions: "Count",
} as const satisfies Readonly<Record<string, MetricUnit>>;

export type MetricName = keyof typeof METRIC_CATALOG;

export const METRIC_NAMES = Object.keys(METRIC_CATALOG) as readonly MetricName[];

/** CloudWatch's free allowance for custom metrics. The catalogue lives inside it. */
export const FREE_CUSTOM_METRIC_ALLOWANCE = 10;

/** The namespace every metric is published under. Shared with the alarms. */
export const METRIC_NAMESPACE = "BetterWakeUp";

/**
 * The only dimension. One deployment's numbers must not be read as another's,
 * and nothing finer than a stage can be a dimension without billing per value.
 */
export const METRIC_DIMENSION = "Stage";

/**
 * The error codes that mean the server rejected the movement evidence itself.
 *
 * Deliberately not every failure of the completion endpoint. A completion
 * refused because its deadline passed or its key was reused is the API working;
 * these four are the ones that say the client believed it had a valid
 * completion and the server disagreed, which is the defect the alarm is for.
 */
export const REJECTED_COMPLETION_CODES = [
  "completion_outside_task_window",
  "movement_provenance_rejected",
  "step_target_not_met",
  "task_already_resolved",
] as const;

/** Where a finished metric line goes. Injected, so a test reads lines. */
export type MetricSink = (line: string) => void;

export interface MetricEmitter {
  /** Publish one observation. A count defaults to one occurrence. */
  record(name: MetricName, value?: number): void;
}

export interface EmfEmitterOptions {
  readonly stage: string;
  readonly sink?: MetricSink;
  readonly now?: () => Date;
  readonly namespace?: string;
}

/**
 * An emitter writing one embedded-metric-format line per observation.
 *
 * One line per observation rather than one per invocation: batching would mean
 * holding numbers across an `await` and losing them when an invocation fails,
 * and the failing invocations are the ones whose numbers matter most.
 */
export function createEmfEmitter(options: EmfEmitterOptions): MetricEmitter {
  const sink = options.sink ?? ((line) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const namespace = options.namespace ?? METRIC_NAMESPACE;

  return {
    record(name, value = 1) {
      // A metric with no observation is not zero, it is absent, and absent is
      // what `treatMissingData` on the alarms is written for. Emitting a zero
      // would make a stalled sweep look like a healthy one.
      if (!Number.isFinite(value)) return;
      sink(
        JSON.stringify({
          _aws: {
            Timestamp: now().getTime(),
            CloudWatchMetrics: [
              {
                Namespace: namespace,
                Dimensions: [[METRIC_DIMENSION]],
                Metrics: [{ Name: name, Unit: METRIC_CATALOG[name] }],
              },
            ],
          },
          [METRIC_DIMENSION]: options.stage,
          [name]: value,
        }),
      );
    },
  };
}

/** An emitter that publishes nothing, for tests and for local runs. */
export const noMetrics: MetricEmitter = { record: () => {} };

export interface RecordingMetricEmitter extends MetricEmitter {
  readonly observations: readonly { readonly name: MetricName; readonly value: number }[];
  /** The total observed for one metric, or zero when it was never observed. */
  total(name: MetricName): number;
}

/** An emitter a test asserts against. */
export function createRecordingEmitter(): RecordingMetricEmitter {
  const observations: { name: MetricName; value: number }[] = [];
  return {
    observations,
    record: (name, value = 1) => {
      observations.push({ name, value });
    },
    total: (name) =>
      observations.filter((one) => one.name === name).reduce((sum, one) => sum + one.value, 0),
  };
}
