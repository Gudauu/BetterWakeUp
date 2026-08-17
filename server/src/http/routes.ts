/**
 * Mounting routes from the contract's endpoint registry.
 *
 * A route is never declared here with its own path string. The registry is the
 * one place a method and a path are written down, so the app and the server
 * cannot disagree about where an operation lives, and an endpoint whose
 * handler is not written yet is simply absent rather than wrong.
 *
 * The registry also decides what is checked: every mounted route parses its
 * path parameters, its body, and its idempotency key at the edge, and every
 * mounted route has its response parsed on the way out. A response that does
 * not match the contract is our bug, so it becomes `internal_error` rather
 * than reaching an app that cannot parse it.
 */

import {
  ENDPOINTS,
  type EndpointName,
  type ParamsOf,
  type RequestOf,
  type ResponseOf,
} from "@betterwakeup/contract";
import type { Context, Hono } from "hono";
import { AppError } from "../errors/app-error.ts";
import type { Logger } from "../observability/logger.ts";
import type { AppEnv } from "./app.ts";
import { validateRequest } from "./validation.ts";

/** Everything a handler is given, all of it already checked at the boundary. */
export interface HandlerInput<Name extends EndpointName> {
  readonly body: RequestOf<Name>;
  readonly params: ParamsOf<Name>;
  /** Present exactly when the endpoint requires an idempotency key. */
  readonly idempotencyKey: string | undefined;
  readonly logger: Logger;
  /** The raw context, for the handlers that need a header or a response header. */
  readonly context: Context<AppEnv>;
}

export type EndpointHandler<Name extends EndpointName> = (
  input: HandlerInput<Name>,
) => Promise<ResponseOf<Name>> | ResponseOf<Name>;

/** The handlers to mount. An endpoint absent from this map is not mounted. */
export type EndpointHandlers = {
  [Name in EndpointName]?: EndpointHandler<Name>;
};

export function registerRoutes(app: Hono<AppEnv>, handlers: EndpointHandlers): void {
  for (const name of Object.keys(handlers) as EndpointName[]) {
    // The map's value type is a union of handler types, one per endpoint, and
    // the one we hold is the one belonging to `name`. Only the loop's own
    // widening loses that, so the cast restores what the type already knows.
    const handler = handlers[name] as EndpointHandler<EndpointName> | undefined;
    if (handler === undefined) continue;
    const endpoint = ENDPOINTS[name];

    app.on(endpoint.method, endpoint.path, async (c) => {
      const validated = await validateRequest(c, endpoint);
      const result = await handler({
        body: validated.body as RequestOf<EndpointName>,
        params: validated.params as ParamsOf<EndpointName>,
        idempotencyKey: validated.idempotencyKey,
        logger: c.get("logger"),
        context: c,
      });

      // The type says this already matches. The parse is here for the cases
      // types cannot see: a column that was null, a date that was a Date, a
      // field a migration removed underneath a handler nobody re-read.
      const parsed = endpoint.response.safeParse(result);
      if (!parsed.success) {
        throw new AppError(
          "internal_error",
          `The ${name} response does not match the API contract: ${parsed.error.message}`,
          { cause: parsed.error },
        );
      }
      return c.json(parsed.data as object);
    });
  }
}
