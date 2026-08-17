/**
 * Issue 38's server half: the metrics the alarms are built on.
 *
 * Two things are being pinned. The catalogue is an interface the
 * infrastructure package compiles against, so its size and its shape are
 * asserted here rather than left to whoever adds the next metric. And every
 * emission is asserted from the outside: a request goes through the real
 * application and the metric it produced is read back, so a metric that stops
 * being emitted fails a test rather than going quiet in production.
 */

import { ENDPOINTS } from "@betterwakeup/contract";
import type { Handler } from "hono";
import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors/app-error.ts";
import type { AppEnv } from "../src/http/app.ts";
import { createApp, HEALTH_PATH } from "../src/http/app.ts";
import {
  createEmfEmitter,
  createRecordingEmitter,
  FREE_CUSTOM_METRIC_ALLOWANCE,
  METRIC_CATALOG,
  METRIC_DIMENSION,
  METRIC_NAMES,
  METRIC_NAMESPACE,
  noMetrics,
} from "../src/observability/metrics.ts";

const COMPLETION_ROUTE = ENDPOINTS.createCompletion.path;
const WEBHOOK_ROUTE = ENDPOINTS.receivePaymentWebhook.path;

describe("the metric catalogue", () => {
  it("stays inside CloudWatch's free allowance for custom metrics", () => {
    expect(METRIC_NAMES.length).toBeLessThanOrEqual(FREE_CUSTOM_METRIC_ALLOWANCE);
  });

  it("names an alarm's metric for each thing Observability asks to be alarmed on", () => {
    expect(new Set(METRIC_NAMES)).toEqual(
      new Set([
        "ApiRequests",
        "ApiServerErrors",
        "CompletionAcknowledgmentLatencyMs",
        "SweepFailures",
        "PaymentWebhookFailures",
        "AuthorizationRenewalFailures",
        "DepositsUnsecuredOverADay",
        "OverdueSettlementCommands",
        "UncollectedForfeits",
        "RejectedClientCompletions",
      ]),
    );
  });

  it("gives every metric a unit CloudWatch understands", () => {
    for (const name of METRIC_NAMES) {
      expect(["Count", "Milliseconds"]).toContain(METRIC_CATALOG[name]);
    }
  });
});

describe("the embedded metric format emitter", () => {
  function capture() {
    const lines: Record<string, unknown>[] = [];
    const emitter = createEmfEmitter({
      stage: "dev",
      sink: (line) => lines.push(JSON.parse(line)),
      now: () => new Date("2026-08-17T09:00:00.000Z"),
    });
    return { emitter, lines };
  }

  it("writes one line CloudWatch can extract a metric from", () => {
    const { emitter, lines } = capture();

    emitter.record("UncollectedForfeits", 3);

    expect(lines).toEqual([
      {
        _aws: {
          Timestamp: Date.parse("2026-08-17T09:00:00.000Z"),
          CloudWatchMetrics: [
            {
              Namespace: METRIC_NAMESPACE,
              Dimensions: [[METRIC_DIMENSION]],
              Metrics: [{ Name: "UncollectedForfeits", Unit: "Count" }],
            },
          ],
        },
        Stage: "dev",
        UncollectedForfeits: 3,
      },
    ]);
  });

  it("counts one occurrence when no value is given", () => {
    const { emitter, lines } = capture();

    emitter.record("SweepFailures");

    expect(lines[0]?.SweepFailures).toBe(1);
  });

  it("carries the stage as the only dimension, so nothing bills per account", () => {
    const { emitter, lines } = capture();

    emitter.record("ApiRequests");

    const dimensions = (lines[0]?._aws as { CloudWatchMetrics: { Dimensions: string[][] }[] })
      .CloudWatchMetrics[0]?.Dimensions;
    expect(dimensions).toEqual([["Stage"]]);
  });

  it("publishes nothing for a value that is not a number", () => {
    const { emitter, lines } = capture();

    emitter.record("OverdueSettlementCommands", Number.NaN);

    expect(lines).toEqual([]);
  });
});

describe("what a request publishes", () => {
  function appWith(route: string, handler: Handler<AppEnv>) {
    const metrics = createRecordingEmitter();
    const app = createApp({ metrics, now: clock() });
    app.post(route, handler);
    app.get(route, handler);
    return { app, metrics };
  }

  /** A clock that advances 40ms per read, so a duration is stated rather than tolerated. */
  function clock() {
    let at = 1_000;
    return () => {
      at += 40;
      return at;
    };
  }

  it("counts every request that reached the application", async () => {
    const { app, metrics } = appWith("/challenges/:challengeId", (c) => c.json({ ok: true }));

    await app.request("/challenges/abc");

    expect(metrics.total("ApiRequests")).toBe(1);
    expect(metrics.total("ApiServerErrors")).toBe(0);
  });

  it("counts a fault as a server error and a refusal as not one", async () => {
    const faulty = appWith("/challenges/:challengeId", () => {
      throw new Error("database gone");
    });
    const refused = appWith("/challenges/:challengeId", () => {
      throw new AppError("challenge_not_active", "Not active.");
    });

    await faulty.app.request("/challenges/abc");
    await refused.app.request("/challenges/abc");

    expect(faulty.metrics.total("ApiServerErrors")).toBe(1);
    expect(refused.metrics.total("ApiServerErrors")).toBe(0);
    expect(refused.metrics.total("ApiRequests")).toBe(1);
  });

  it("leaves the health probe out of both numbers", async () => {
    const metrics = createRecordingEmitter();
    const app = createApp({ metrics });

    await app.request(HEALTH_PATH);

    expect(metrics.observations).toEqual([]);
  });

  it("measures how long a completion took to acknowledge", async () => {
    const { app, metrics } = appWith(COMPLETION_ROUTE, (c) => c.json({ ok: true }));

    await app.request(`/tasks/abc/completions`, { method: "POST" });

    expect(metrics.total("CompletionAcknowledgmentLatencyMs")).toBe(40);
  });

  it("counts a completion refused on its evidence and not one refused on its deadline", async () => {
    const rejected = appWith(COMPLETION_ROUTE, () => {
      throw new AppError("step_target_not_met", "Not enough steps.");
    });
    const late = appWith(COMPLETION_ROUTE, () => {
      throw new AppError("deadline_passed", "Too late.");
    });

    await rejected.app.request("/tasks/abc/completions", { method: "POST" });
    await late.app.request("/tasks/abc/completions", { method: "POST" });

    expect(rejected.metrics.total("RejectedClientCompletions")).toBe(1);
    expect(late.metrics.total("RejectedClientCompletions")).toBe(0);
    // Both still measured: an acknowledgment the app waited for and then had
    // refused was still a wait.
    expect(late.metrics.total("CompletionAcknowledgmentLatencyMs")).toBe(40);
  });

  it("counts a webhook the server did not accept, whichever side was at fault", async () => {
    const unsigned = appWith(WEBHOOK_ROUTE, () => {
      throw new AppError("webhook_signature_invalid", "Bad signature.");
    });
    const broken = appWith(WEBHOOK_ROUTE, () => {
      throw new Error("provider table missing");
    });
    const accepted = appWith(WEBHOOK_ROUTE, (c) => c.json({ ok: true }));

    await unsigned.app.request("/payments/webhooks/fake", { method: "POST" });
    await broken.app.request("/payments/webhooks/fake", { method: "POST" });
    await accepted.app.request("/payments/webhooks/fake", { method: "POST" });

    expect(unsigned.metrics.total("PaymentWebhookFailures")).toBe(1);
    expect(broken.metrics.total("PaymentWebhookFailures")).toBe(1);
    expect(accepted.metrics.total("PaymentWebhookFailures")).toBe(0);
  });

  it("publishes nothing when no emitter was configured", async () => {
    const app = createApp({ metrics: noMetrics });
    app.get("/challenges/:challengeId", (c) => c.json({ ok: true }));

    const response = await app.request("/challenges/abc");

    expect(response.status).toBe(200);
  });
});
