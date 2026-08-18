/**
 * The Lambda entry point.
 *
 * The discrimination happens here and nowhere else, before any application
 * code runs. A scheduled invocation is answered by the sweep and never
 * constructs a Request, never enters Hono, and never touches a route table.
 */

import type { LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { type App, createApp } from "../http/app.ts";
import { createLogger } from "../observability/logger.ts";
import { type SweepRunner, unconfiguredSweep } from "../sweep/run-sweep.ts";
import { isHttpEvent, isScheduledEvent } from "./events.ts";

export interface LambdaContext {
  readonly awsRequestId?: string;
}

export interface CreateHandlerOptions {
  readonly logger?: ReturnType<typeof createLogger>;
  /** A fully composed HTTP application. Tests and the deployed runtime supply one. */
  readonly app?: App;
  /**
   * What a scheduled event is answered by.
   *
   * Injected rather than constructed here because the sweep needs a database
   * handle and this module is evaluated at load time, before anything has
   * decided where one is opened across invocations. The default says so out
   * loud instead of connecting on its own.
   */
  readonly sweep?: SweepRunner;
}

export function createHandler(options: CreateHandlerOptions = {}) {
  const logger = options.logger ?? createLogger();
  const sweep = options.sweep ?? unconfiguredSweep;
  const httpHandler = handle(options.app ?? createApp({ logger }));

  return async (event: unknown, context?: LambdaContext): Promise<unknown> => {
    const requestId = context?.awsRequestId;
    if (isScheduledEvent(event)) {
      return await sweep(event, logger.child({ invocation: "scheduled", requestId }));
    }
    if (isHttpEvent(event)) {
      return await httpHandler(event as LambdaEvent, context as never);
    }
    // Neither shape means the function was wired to something nobody designed
    // for. Failing loudly is better than guessing which arm it belonged to.
    logger.error("unrecognized invocation event", {
      requestId,
      errorClassification: "internal",
      errorCode: "internal_error",
    });
    throw new Error("Unrecognized invocation event.");
  };
}

/**
 * The skeleton remains useful to tests and local probes. The deployed export
 * lives in `runtime.ts`, where asynchronous SSM and database setup can finish
 * before an invocation is dispatched.
 */
