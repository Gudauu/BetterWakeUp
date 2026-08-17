/**
 * The validation boundary.
 *
 * Nothing reaches a route handler that has not been parsed by the contract
 * schema for that endpoint. The handler therefore receives a value of the
 * contract's own type and never a `Record<string, unknown>` it has to check
 * for itself, which is what stops a second, divergent idea of a valid request
 * growing inside the domain.
 *
 * Three kinds of failure produce the same documented shape, a
 * `validation_failed` body with a `details` entry per problem: an unknown
 * field, a missing field, and a field of the wrong type. Unknown fields are
 * rejected because the contract's request schemas are strict all the way down
 * (see `deepStrict`), not because anything here inspects keys.
 */

import {
  type EndpointDefinition,
  type ErrorDetail,
  IDEMPOTENCY_HEADER,
  idempotencyKey as idempotencyKeySchema,
} from "@betterwakeup/contract";
import type { Context } from "hono";
import type { z } from "zod";
import { AppError } from "../errors/app-error.ts";

/** What the boundary produces, and the only request material a handler sees. */
export interface ValidatedRequest {
  /** The parsed body, or `null` for an endpoint that takes none. */
  readonly body: unknown;
  /** The parsed path parameters, or `null` for a route that has none. */
  readonly params: unknown;
  /**
   * The idempotency key, present exactly when the endpoint requires one. A
   * missing key on a command that needs one never gets this far.
   */
  readonly idempotencyKey: string | undefined;
}

/**
 * Parse one request against its endpoint definition.
 *
 * Throws `AppError("validation_failed")`, which the application's error
 * renderer turns into the documented body.
 */
export async function validateRequest(
  c: Context,
  endpoint: EndpointDefinition,
): Promise<ValidatedRequest> {
  return {
    idempotencyKey: readIdempotencyKey(c, endpoint),
    params: endpoint.params === null ? null : parse(endpoint.params, c.req.param(), "params"),
    body: await readBody(c, endpoint),
  };
}

function readIdempotencyKey(c: Context, endpoint: EndpointDefinition): string | undefined {
  const header = c.req.header(IDEMPOTENCY_HEADER);
  if (!endpoint.idempotent) return undefined;
  if (header === undefined) {
    throw invalid(
      [
        {
          path: ["headers", IDEMPOTENCY_HEADER],
          message: "this command requires an idempotency key",
        },
      ],
      "headers",
    );
  }
  const parsed = idempotencyKeySchema.safeParse(header);
  if (!parsed.success) {
    throw invalid(detailsOf(parsed.error, ["headers", IDEMPOTENCY_HEADER]), "headers");
  }
  return parsed.data;
}

async function readBody(c: Context, endpoint: EndpointDefinition): Promise<unknown> {
  const raw = await c.req.text();

  if (endpoint.request === null) {
    // Silently dropping a body would hide the same mistake an unknown field
    // hides: a client sending something it believes the server acts on.
    if (raw.trim() !== "") {
      throw invalid([{ path: [], message: "this endpoint accepts no request body" }]);
    }
    return null;
  }

  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.split(";")[0]?.trim().toLowerCase().endsWith("/json")) {
    throw invalid(
      [{ path: ["headers", "content-type"], message: "expected a body of type application/json" }],
      "headers",
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new AppError("validation_failed", "The request body is not valid JSON.", {
      details: [{ path: [], message: "expected a JSON document" }],
      cause,
    });
  }

  return parse(endpoint.request, json, "body");
}

function parse(schema: z.ZodType, value: unknown, at: "body" | "params"): unknown {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw invalid(detailsOf(parsed.error), at);
}

const MESSAGES = {
  body: "The request body does not match the API contract.",
  params: "The path does not match the API contract.",
  headers: "The request headers do not match the API contract.",
} as const;

function invalid(details: ErrorDetail[], at: keyof typeof MESSAGES = "body"): AppError {
  return new AppError("validation_failed", MESSAGES[at], { details });
}

/**
 * Every failure, not only the first. A client fixing one field at a time
 * against a server that reports one field at a time is a slow way to find out
 * that four of them were wrong.
 */
function detailsOf(error: z.ZodError, prefix: ErrorDetail["path"] = []): ErrorDetail[] {
  return error.issues.map((issue) => ({
    // A Zod path segment can be a symbol, which has no place on the wire.
    path: [...prefix, ...issue.path.map((segment) => segmentOf(segment))],
    message: issue.message,
  }));
}

function segmentOf(segment: PropertyKey): string | number {
  return typeof segment === "symbol" ? segment.toString() : segment;
}
