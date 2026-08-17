/**
 * The Hono application.
 *
 * It carries three things and nothing else: one request log line per
 * invocation, one error model on the way out, and the routes mounted from the
 * contract's endpoint registry. Every route inherits the first two because
 * they are registered here rather than per route.
 */

import { ENDPOINTS, IDEMPOTENCY_HEADER } from "@betterwakeup/contract";
import { type Context, Hono } from "hono";
import type { SessionGate } from "../auth/session-gate.ts";
import { AppError, toAppError } from "../errors/app-error.ts";
import { createLogger, type Logger } from "../observability/logger.ts";
import {
  type MetricEmitter,
  noMetrics,
  REJECTED_COMPLETION_CODES,
} from "../observability/metrics.ts";
import type { ProviderWebhookEvent } from "../payments/provider.ts";
import type { RateLimiter } from "../rate-limit/service.ts";
import { type EndpointHandlers, registerRoutes } from "./routes.ts";

/** The operational probe issue 35's deployed function has to answer. */
export const HEALTH_PATH = "/health";

export interface AppEnv {
  Bindings: {
    /** Set by the AWS Lambda adapter. Absent when the app is called directly. */
    readonly lambdaContext?: { readonly awsRequestId?: string };
    /**
     * The raw invocation event, also set by the adapter. Read only for the
     * source address AWS wrote into it: see `client-address.ts`.
     */
    readonly event?: unknown;
  };
  Variables: {
    readonly requestId: string;
    /** A logger already carrying this request's identifiers. */
    readonly logger: Logger;
    /**
     * The payment provider's delivery, once its signature verified. Set by the
     * signature verifier and read by the webhook handler, so nothing downstream
     * has to re-verify or, worse, trust an unverified payload.
     */
    readonly providerEvent?: ProviderWebhookEvent | undefined;
  };
}

export interface CreateAppOptions {
  /** The process-wide logger. Requests get children of it. */
  readonly logger?: Logger;
  /** A clock, so a test can assert a duration rather than tolerate one. */
  readonly now?: () => number;
  /**
   * The endpoint handlers to mount, keyed by contract endpoint name. An
   * endpoint with no handler is not mounted and answers `not_found`, which is
   * how the surface grows one issue at a time without a half-built route
   * pretending to work.
   */
  readonly handlers?: EndpointHandlers;
  /**
   * How a caller is authenticated and how ownership is proved. Mounting a
   * session endpoint without it fails here rather than serving it unguarded.
   */
  readonly sessionGate?: SessionGate;
  /** Verification for the signature-authenticated endpoints. See issue 25. */
  readonly signatureVerifier?: (c: Context<AppEnv>) => Promise<void>;
  /**
   * The counters enforcing `RATE_LIMITS`. Mounting an endpoint that declares a
   * limit without it fails here rather than serving it unlimited.
   */
  readonly rateLimiter?: RateLimiter;
  /** How a caller with no session is identified. Defaults to the envelope. */
  readonly clientAddress?: (c: Context<AppEnv>) => string;
  /**
   * Where the operational metrics go. Defaults to publishing nothing, so a
   * test asserting on responses does not also write metric lines.
   */
  readonly metrics?: MetricEmitter;
}

/** The routes two of the metrics are specific to, taken from the contract. */
const COMPLETION_ROUTE = ENDPOINTS.createCompletion.path;
const WEBHOOK_ROUTE = ENDPOINTS.receivePaymentWebhook.path;

export function createApp(options: CreateAppOptions = {}) {
  const rootLogger = options.logger ?? createLogger();
  const now = options.now ?? (() => Date.now());
  const metrics = options.metrics ?? noMetrics;
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const requestId = c.env?.lambdaContext?.awsRequestId ?? crypto.randomUUID();
    const logger = rootLogger.child({
      requestId,
      invocation: "http",
      method: c.req.method,
      // The key is a client-generated UUID by contract, so it identifies a
      // command attempt and never authenticates one.
      idempotencyKey: c.req.header(IDEMPOTENCY_HEADER),
    });
    c.set("requestId", requestId);
    c.set("logger", logger);

    const startedAt = now();
    await next();
    // Read back rather than closed over: a route that authenticated the caller
    // replaces this request's logger with one carrying the account, and the
    // request line is the line most worth having it on.
    const durationMs = now() - startedAt;

    // The probe is deliberately outside both numbers. It always succeeds and
    // nothing user-facing depends on it, so counting it would dilute the error
    // rate by however often the deployment happens to be polled.
    if (c.req.routePath !== HEALTH_PATH) {
      metrics.record("ApiRequests");
      // Our own failures only. A refusal is the API working, and the rate
      // alarm is meant to fire on faults rather than on users being told no.
      if (c.res.status >= 500) metrics.record("ApiServerErrors");
      if (c.req.routePath === COMPLETION_ROUTE) {
        // Every completion attempt, answered or refused: an acknowledgment the
        // app waited a long time for and then had refused was still a long
        // wait, and dropping those would measure the fast half of the traffic.
        metrics.record("CompletionAcknowledgmentLatencyMs", durationMs);
      }
    }

    (c.get("logger") ?? logger).info("request handled", {
      // The matched pattern, so a log query groups by route rather than by
      // identifier, and so no query string can reach a log line.
      route: c.req.routePath,
      status: c.res.status,
      durationMs,
    });
  });

  // Deliberately not in the contract's endpoint registry. The registry is the
  // product's API, versioned with the app; this is an operational probe that
  // proves the function was deployed and can answer, so it takes no session,
  // spends no rate limit, opens no database connection, and reports nothing
  // about the account or the deployment that a caller could act on.
  app.get(HEALTH_PATH, (c) => c.json({ status: "ok" }));

  registerRoutes(app, options.handlers ?? {}, {
    sessionGate: options.sessionGate,
    signatureVerifier: options.signatureVerifier,
    rateLimiter: options.rateLimiter,
    clientAddress: options.clientAddress,
  });

  // Rendered rather than thrown: a throw here would escape the logging
  // middleware's `next()`, and an unmatched route would be the one request
  // with no "request handled" line.
  app.notFound((c) =>
    render(c, new AppError("not_found", `No route for ${c.req.method} ${c.req.path}.`)),
  );

  app.onError((thrown, c) => render(c, toAppError(thrown)));

  function render(c: Context<AppEnv>, error: AppError) {
    const logger = c.get("logger") ?? rootLogger;
    const fields = {
      route: c.req.routePath,
      status: error.status,
      errorCode: error.code,
      errorClassification: error.classification,
    };
    // Only our own failures are worth an operator's attention. A rejected
    // request is the API working, and logging it at error would drown the
    // signal the alarms are built on.
    if (error.classification === "internal") {
      logger.error(describe(error), fields);
    } else {
      logger.warn(describe(error), fields);
    }

    // Counted where the code is known. The request middleware sees a status
    // and nothing else, and a 409 on the completion route could be a replayed
    // key as easily as evidence the server would not believe.
    if (
      c.req.routePath === COMPLETION_ROUTE &&
      (REJECTED_COMPLETION_CODES as readonly string[]).includes(error.code)
    ) {
      metrics.record("RejectedClientCompletions");
    }
    // Every webhook the server did not accept, whichever side was at fault: a
    // rejected signature and an internal fault both end with the provider
    // holding an event we have not applied.
    if (c.req.routePath === WEBHOOK_ROUTE) {
      metrics.record("PaymentWebhookFailures");
    }

    if (error.retryAfterSeconds !== undefined) {
      c.header("Retry-After", String(error.retryAfterSeconds));
    }
    return c.json(error.toResponse(), error.status as 400);
  }

  return app;
}

export type App = ReturnType<typeof createApp>;

/** The message for the log, which unlike the response keeps the cause. */
function describe(error: AppError): string {
  const cause = error.cause;
  if (cause instanceof Error && cause !== error) return `${error.message}: ${cause.stack ?? ""}`;
  return error.message;
}
