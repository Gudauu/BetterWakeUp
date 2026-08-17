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
import type { AuthenticatedSession, SessionGate } from "../auth/session-gate.ts";
import { AppError } from "../errors/app-error.ts";
import type { Logger } from "../observability/logger.ts";
import type { AppEnv } from "./app.ts";
import { validateRequest } from "./validation.ts";

/**
 * The caller, for the endpoints that have one.
 *
 * Typed off the registry's own `auth` value, so a handler for a session
 * endpoint reads `input.session.accountId` with no check, and a handler for the
 * sign-in exchange cannot read one at all.
 */
export type SessionOf<Name extends EndpointName> =
  (typeof ENDPOINTS)[Name]["auth"] extends "session" ? AuthenticatedSession : null;

/** Everything a handler is given, all of it already checked at the boundary. */
export interface HandlerInput<Name extends EndpointName> {
  readonly body: RequestOf<Name>;
  readonly params: ParamsOf<Name>;
  /**
   * The authenticated caller, who is already known to own every resource the
   * path addresses. Null for the endpoints the contract marks as taking no
   * session.
   */
  readonly session: SessionOf<Name>;
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

export interface RegisterRoutesOptions {
  /**
   * How a caller is identified and how ownership is proved. Required to mount
   * any endpoint the contract marks `auth: "session"`: mounting one without it
   * would serve a command to anybody, so it is a refusal at startup rather
   * than a hole discovered in production.
   */
  readonly sessionGate?: SessionGate | undefined;
  /**
   * Verification for the endpoints authenticated by a provider signature
   * instead of a session. Issue 25 supplies it; until then an endpoint that
   * needs one cannot be mounted.
   */
  readonly signatureVerifier?: ((c: Context<AppEnv>) => Promise<void>) | undefined;
}

export function registerRoutes(
  app: Hono<AppEnv>,
  handlers: EndpointHandlers,
  options: RegisterRoutesOptions = {},
): void {
  for (const name of Object.keys(handlers) as EndpointName[]) {
    // The map's value type is a union of handler types, one per endpoint, and
    // the one we hold is the one belonging to `name`. Only the loop's own
    // widening loses that, so the cast restores what the type already knows.
    const handler = handlers[name] as EndpointHandler<EndpointName> | undefined;
    if (handler === undefined) continue;
    const endpoint = ENDPOINTS[name];
    const gate = gateFor(name, endpoint.auth, options);

    app.on(endpoint.method, endpoint.path, async (c) => {
      // Authentication before validation. A caller with no usable credential
      // is told that and nothing else: field-level feedback on a body it was
      // never entitled to send would describe the API to a stranger.
      const session = await gate(c);
      const validated = await validateRequest(c, endpoint);
      if (session !== null) {
        await options.sessionGate?.assertOwnership(session, validated.params);
        c.set("logger", c.get("logger").child({ accountId: session.accountId }));
      }

      const result = await handler({
        body: validated.body as RequestOf<EndpointName>,
        params: validated.params as ParamsOf<EndpointName>,
        session: session as SessionOf<EndpointName>,
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

/**
 * The authentication step for one endpoint, decided once at mount time.
 *
 * Deciding it here rather than per request is what makes the missing-gate case
 * a startup failure: a deployment that forgot to configure authentication
 * cannot serve a single session-protected request, rather than serving all of
 * them to anyone until someone notices.
 */
function gateFor(
  name: EndpointName,
  auth: (typeof ENDPOINTS)[EndpointName]["auth"],
  options: RegisterRoutesOptions,
): (c: Context<AppEnv>) => Promise<AuthenticatedSession | null> {
  if (auth === "session") {
    const sessionGate = options.sessionGate;
    if (sessionGate === undefined) {
      throw new Error(`Cannot mount ${name}: it requires a session and no session gate was given.`);
    }
    return async (c) => await sessionGate.authenticate(c.req.header("authorization"));
  }

  if (auth === "signature") {
    const verifier = options.signatureVerifier;
    if (verifier === undefined) {
      throw new Error(`Cannot mount ${name}: it requires a signature verifier and none was given.`);
    }
    return async (c) => {
      await verifier(c);
      return null;
    };
  }

  return async () => null;
}
