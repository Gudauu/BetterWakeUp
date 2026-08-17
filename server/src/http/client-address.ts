/**
 * Who a request came from, for the limits that apply before a session exists.
 *
 * Only `requestContext.http.sourceIp` is read. That field is written by the
 * Function URL integration around the request, so a caller cannot set it. The
 * forwarding headers are the obvious alternative and are exactly wrong here: a
 * Function URL passes through whatever `X-Forwarded-For` the client sent, so
 * trusting it would let one caller spend a different address's allowance, or
 * mint a fresh one per request and never meet a limit at all.
 *
 * A request with no source address is not from the Function URL path: it is a
 * direct invocation or a test calling `app.fetch`. Those share one subject
 * rather than being waved through, because an unlimited fallback is a way
 * around the limit and a shared one is only inconvenient.
 */

import type { Context } from "hono";
import type { AppEnv } from "./app.ts";

/** The subject for a caller whose address the envelope did not carry. */
export const UNKNOWN_CLIENT = "unknown";

export function clientAddressFromEvent(c: Context<AppEnv>): string {
  const event = c.env?.event;
  if (!isRecord(event)) return UNKNOWN_CLIENT;
  const requestContext = event.requestContext;
  if (!isRecord(requestContext)) return UNKNOWN_CLIENT;
  const http = requestContext.http;
  if (!isRecord(http)) return UNKNOWN_CLIENT;
  return typeof http.sourceIp === "string" && http.sourceIp !== "" ? http.sourceIp : UNKNOWN_CLIENT;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
