/**
 * The Lambda entry point.
 *
 * The discrimination happens here and nowhere else, before any application
 * code runs. A scheduled invocation is answered by the sweep and never
 * constructs a Request, never enters Hono, and never touches a route table.
 */

import type { LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { createApp } from "../http/app.ts";
import { createLogger } from "../observability/logger.ts";
import { runSweep } from "../sweep/run-sweep.ts";
import { isHttpEvent, isScheduledEvent } from "./events.ts";

interface LambdaContext {
  readonly awsRequestId?: string;
}

export interface CreateHandlerOptions {
  readonly logger?: ReturnType<typeof createLogger>;
}

export function createHandler(options: CreateHandlerOptions = {}) {
  const logger = options.logger ?? createLogger();
  const httpHandler = handle(createApp({ logger }));

  return async (event: unknown, context?: LambdaContext): Promise<unknown> => {
    const requestId = context?.awsRequestId;
    if (isScheduledEvent(event)) {
      return await runSweep(event, logger.child({ invocation: "scheduled", requestId }));
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

/** The handler AWS invokes. */
export const handler = createHandler();
