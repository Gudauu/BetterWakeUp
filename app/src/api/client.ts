/**
 * The API client, built from the contract's endpoint registry.
 *
 * No path string, method, or header rule is written here twice: the registry
 * says what an endpoint's route is, whether it needs a session, whether it
 * needs an idempotency key, and what it accepts and returns, and this module
 * turns that into one request. An endpoint added to the contract is callable
 * from the app with no edit here.
 */

import {
  ENDPOINTS,
  type EndpointDefinition,
  type EndpointName,
  errorResponse,
  type ParamsOf,
  type RequestOf,
  type ResponseOf,
} from "@betterwakeup/contract";
import { randomUUID } from "expo-crypto";
import type { SessionStore } from "../session/session-store.ts";
import { ApiError } from "./errors.ts";

/**
 * Every endpoint except the payment webhook, which the provider calls and the
 * app never does. Excluding it here is what keeps it uncallable rather than
 * merely unused.
 */
export type ClientEndpointName = Exclude<EndpointName, "receivePaymentWebhook">;

type ParamsPart<Name extends ClientEndpointName> = [ParamsOf<Name>] extends [null]
  ? { params?: never }
  : { params: ParamsOf<Name> };

type BodyPart<Name extends ClientEndpointName> = [RequestOf<Name>] extends [null]
  ? { body?: never }
  : { body: RequestOf<Name> };

export type ApiRequest<Name extends ClientEndpointName> = ParamsPart<Name> &
  BodyPart<Name> & {
    /**
     * The idempotency key for a command that requires one. The pending
     * completion store passes its own record ID, which is what makes a retry
     * after a crash the same command rather than a second one; anything else
     * gets a fresh key.
     */
    idempotencyKey?: string;
    signal?: AbortSignal;
  };

export interface ApiClient {
  request<Name extends ClientEndpointName>(
    name: Name,
    input: ApiRequest<Name>,
  ): Promise<ResponseOf<Name>>;
}

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly sessionStore: SessionStore;
  /** Injectable so a test drives the client without a network. */
  readonly fetch?: typeof globalThis.fetch;
  readonly newIdempotencyKey?: () => string;
  /**
   * Called after a stored session has been discarded because the server
   * refused it. The session provider uses it to move the whole app to the
   * signed-out state, so an expired session is noticed on the first request
   * that used it rather than left on screen as if it still worked.
   */
  readonly onSessionInvalid?: () => void;
}

interface LooseRequest {
  params?: unknown;
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/** `/challenges/:challengeId/pause` plus `{challengeId}` is a URL path. */
function buildPath(definition: EndpointDefinition, params: Record<string, string>): string {
  return definition.path.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      // Unreachable once the params schema has parsed: the registry's schema
      // keys and the route's parameters are the same set, and a test asserts it.
      throw new ApiError("validation_failed", `Missing path parameter ${name}.`);
    }
    return encodeURIComponent(value);
  });
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  const newKey = options.newIdempotencyKey ?? randomUUID;

  return {
    async request<Name extends ClientEndpointName>(
      name: Name,
      input: ApiRequest<Name>,
    ): Promise<ResponseOf<Name>> {
      const definition: EndpointDefinition = ENDPOINTS[name];
      const loose = input as LooseRequest;

      let path = definition.path;
      if (definition.params !== null) {
        const parsed = definition.params.safeParse(loose.params);
        if (!parsed.success) {
          throw new ApiError("validation_failed", `Invalid path parameters for ${name}.`, {
            cause: parsed.error,
          });
        }
        path = buildPath(definition, parsed.data as Record<string, string>);
      }

      const headers: Record<string, string> = { accept: "application/json" };

      let payload: string | undefined;
      if (definition.request !== null) {
        // Parsed before it is sent, so a request the server would reject fails
        // here without spending an idempotency key or a rate limit allowance.
        const parsed = definition.request.safeParse(loose.body);
        if (!parsed.success) {
          throw new ApiError("validation_failed", `Invalid request body for ${name}.`, {
            cause: parsed.error,
          });
        }
        payload = JSON.stringify(parsed.data);
        headers["content-type"] = "application/json";
      }

      if (definition.auth === "session") {
        const session = await options.sessionStore.read();
        if (session === null) {
          // The same code the server would answer with, so a caller has one
          // branch for "not signed in" rather than two.
          throw new ApiError("unauthenticated", "No session is stored on this device.");
        }
        headers.authorization = `Bearer ${session.token}`;
      }

      if (definition.idempotent) {
        headers["idempotency-key"] = loose.idempotencyKey ?? newKey();
      }

      let response: Response;
      try {
        response = await doFetch(`${baseUrl}${path}`, {
          method: definition.method,
          headers,
          ...(payload === undefined ? {} : { body: payload }),
          ...(loose.signal === undefined ? {} : { signal: loose.signal }),
        });
      } catch (cause) {
        // Never reached the server, so the command may or may not have run;
        // `retry` is safe because every command that changes anything carries
        // an idempotency key.
        throw new ApiError("internal_error", "The request did not reach the server.", {
          status: null,
          cause,
        });
      }

      const text = await response.text();
      const decoded = decodeJson(text);

      if (!response.ok) {
        const parsed = errorResponse.safeParse(decoded);
        if (!parsed.success) {
          throw new ApiError("internal_error", `Unreadable error response (${response.status}).`, {
            status: response.status,
          });
        }
        const error = ApiError.fromResponse(response.status, parsed.data);
        if (
          definition.auth === "session" &&
          (error.code === "unauthenticated" || error.code === "session_expired")
        ) {
          // The stored session is provably useless, so it goes now rather than
          // being presented on every later request. Only a request that carried
          // the session says anything about it: sign-in answers `unauthenticated`
          // for a provider token it could not verify, which is no evidence
          // about whatever is in storage.
          await options.sessionStore.clear();
          options.onSessionInvalid?.();
        }
        throw error;
      }

      const parsed = definition.response.safeParse(decoded ?? {});
      if (!parsed.success) {
        throw new ApiError("internal_error", `Unreadable response body for ${name}.`, {
          status: response.status,
          cause: parsed.error,
        });
      }
      return parsed.data as ResponseOf<Name>;
    },
  };
}

/** An empty body is `{}`: the two no-content commands answer with no bytes. */
function decodeJson(text: string): unknown {
  if (text.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
