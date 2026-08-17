/**
 * The Hono application.
 *
 * It carries two things at this stage and nothing else: one request log line
 * per invocation, and one error model on the way out. Routes arrive in issue
 * 11, mounted from the contract's endpoint registry, and every one of them
 * inherits both because they are registered here rather than per route.
 */

import { IDEMPOTENCY_HEADER } from "@betterwakeup/contract";
import { type Context, Hono } from "hono";
import { AppError, toAppError } from "../errors/app-error.ts";
import { createLogger, type Logger } from "../observability/logger.ts";

export interface AppEnv {
  Bindings: {
    /** Set by the AWS Lambda adapter. Absent when the app is called directly. */
    readonly lambdaContext?: { readonly awsRequestId?: string };
  };
  Variables: {
    readonly requestId: string;
    /** A logger already carrying this request's identifiers. */
    readonly logger: Logger;
  };
}

export interface CreateAppOptions {
  /** The process-wide logger. Requests get children of it. */
  readonly logger?: Logger;
  /** A clock, so a test can assert a duration rather than tolerate one. */
  readonly now?: () => number;
}

export function createApp(options: CreateAppOptions = {}) {
  const rootLogger = options.logger ?? createLogger();
  const now = options.now ?? (() => Date.now());
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
    logger.info("request handled", {
      // The matched pattern, so a log query groups by route rather than by
      // identifier, and so no query string can reach a log line.
      route: c.req.routePath,
      status: c.res.status,
      durationMs: now() - startedAt,
    });
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
