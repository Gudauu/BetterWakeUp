/**
 * The endpoint registry: every operation, its route, what it accepts, and what
 * it returns.
 *
 * This exists so the route table is data rather than prose. The server mounts
 * routes from it, the app builds requests from it, and the JSON Schema
 * artifact under `generated/` is produced from it, so a schema that no
 * endpoint uses cannot drift into the app unnoticed.
 */

import { z } from "zod";
import {
  acceptRecoveryRequest,
  acceptRecoveryResponse,
  changeTimeZoneRequest,
  changeTimeZoneResponse,
  createChallengeRequest,
  createChallengeResponse,
  createFundingIntentRequest,
  createFundingIntentResponse,
  createProjectionRequest,
  createProjectionResponse,
  getCurrentChallengeResponse,
  pauseChallengeRequest,
  pauseChallengeResponse,
  replacePaymentMethodRequest,
  replacePaymentMethodResponse,
  resumeChallengeRequest,
  resumeChallengeResponse,
} from "./challenges.ts";
import { createSessionRequest, createSessionResponse, emptyResponse } from "./identity.ts";
import { paymentProvider, paymentWebhookRequest, paymentWebhookResponse } from "./payments.ts";
import { resourceId } from "./primitives.ts";
import { deepStrict } from "./strict.ts";
import { createCompletionRequest, createCompletionResponse } from "./tasks.ts";

/**
 * Path parameters, which are as much part of a request as its body.
 *
 * They are named here so the server has something to validate them against
 * rather than trusting a segment of the URL because the router matched it.
 */
const challengeParams = z.strictObject({ challengeId: resourceId });
const taskParams = z.strictObject({ taskId: resourceId });
const webhookParams = z.strictObject({ provider: paymentProvider });

export type HttpMethod = "GET" | "POST" | "DELETE";

/**
 * Who the caller proves itself to be.
 *
 * `none` is the sign-in exchange, which is where a session comes from.
 * `signature` is the payment webhook, which carries a provider signature
 * instead of a session.
 */
export type EndpointAuth = "session" | "none" | "signature";

export interface EndpointDefinition {
  readonly method: HttpMethod;
  /** Route pattern with `:name` parameters, exactly as the server mounts it. */
  readonly path: string;
  readonly auth: EndpointAuth;
  /**
   * Whether the request must carry an idempotency key. True for every
   * state-changing client command, and false for reads and for the
   * projection, which persists nothing.
   */
  readonly idempotent: boolean;
  /**
   * The path parameters, or `null` for a route that takes none. Always an
   * object schema, keyed by the `:name` parameters in `path`.
   */
  readonly params: z.ZodType | null;
  /**
   * The request body, or `null` for a route that takes none. Every one of
   * these rejects unknown fields at every level: see `deepStrict`.
   */
  readonly request: z.ZodType | null;
  readonly response: z.ZodType;
}

export const ENDPOINTS = {
  createSession: {
    method: "POST",
    path: "/sessions",
    auth: "none",
    idempotent: false,
    params: null,
    request: deepStrict(createSessionRequest),
    response: createSessionResponse,
  },
  deleteSession: {
    method: "DELETE",
    path: "/sessions",
    auth: "session",
    idempotent: false,
    params: null,
    request: null,
    response: emptyResponse,
  },
  deleteAccount: {
    method: "DELETE",
    path: "/accounts",
    auth: "session",
    idempotent: true,
    params: null,
    request: null,
    response: emptyResponse,
  },
  createChallengeProjection: {
    method: "POST",
    path: "/challenges/projections",
    auth: "session",
    idempotent: false,
    params: null,
    request: deepStrict(createProjectionRequest),
    response: createProjectionResponse,
  },
  createChallenge: {
    method: "POST",
    path: "/challenges",
    auth: "session",
    idempotent: true,
    params: null,
    request: deepStrict(createChallengeRequest),
    response: createChallengeResponse,
  },
  createFundingIntent: {
    method: "POST",
    path: "/challenges/funding-intents",
    auth: "session",
    idempotent: true,
    params: null,
    request: deepStrict(createFundingIntentRequest),
    response: createFundingIntentResponse,
  },
  replacePaymentMethod: {
    method: "POST",
    path: "/challenges/:challengeId/payment-method",
    auth: "session",
    idempotent: true,
    params: challengeParams,
    request: deepStrict(replacePaymentMethodRequest),
    response: replacePaymentMethodResponse,
  },
  getCurrentChallenge: {
    method: "GET",
    path: "/challenges/current",
    auth: "session",
    idempotent: false,
    params: null,
    request: null,
    response: getCurrentChallengeResponse,
  },
  changeChallengeTimeZone: {
    method: "POST",
    path: "/challenges/:challengeId/time-zone",
    auth: "session",
    idempotent: true,
    params: challengeParams,
    request: deepStrict(changeTimeZoneRequest),
    response: changeTimeZoneResponse,
  },
  pauseChallenge: {
    method: "POST",
    path: "/challenges/:challengeId/pause",
    auth: "session",
    idempotent: true,
    params: challengeParams,
    request: deepStrict(pauseChallengeRequest),
    response: pauseChallengeResponse,
  },
  resumeChallenge: {
    method: "DELETE",
    path: "/challenges/:challengeId/pause",
    auth: "session",
    idempotent: true,
    params: challengeParams,
    request: deepStrict(resumeChallengeRequest),
    response: resumeChallengeResponse,
  },
  acceptRecovery: {
    method: "POST",
    path: "/challenges/:challengeId/recovery",
    auth: "session",
    idempotent: true,
    params: challengeParams,
    request: deepStrict(acceptRecoveryRequest),
    response: acceptRecoveryResponse,
  },
  createCompletion: {
    method: "POST",
    path: "/tasks/:taskId/completions",
    auth: "session",
    idempotent: true,
    params: taskParams,
    request: deepStrict(createCompletionRequest),
    response: createCompletionResponse,
  },
  receivePaymentWebhook: {
    method: "POST",
    path: "/payments/webhooks/:provider",
    auth: "signature",
    idempotent: false,
    params: webhookParams,
    request: deepStrict(paymentWebhookRequest),
    response: paymentWebhookResponse,
  },
} as const satisfies Record<string, EndpointDefinition>;

export type EndpointName = keyof typeof ENDPOINTS;

export const ENDPOINT_NAMES = Object.keys(ENDPOINTS) as EndpointName[];

/** The request body type of one endpoint, or `null` where it takes no body. */
export type RequestOf<Name extends EndpointName> =
  (typeof ENDPOINTS)[Name]["request"] extends z.ZodType
    ? z.infer<(typeof ENDPOINTS)[Name]["request"] & z.ZodType>
    : null;

/** The path parameter type of one endpoint, or `null` where it takes none. */
export type ParamsOf<Name extends EndpointName> =
  (typeof ENDPOINTS)[Name]["params"] extends z.ZodType
    ? z.infer<(typeof ENDPOINTS)[Name]["params"] & z.ZodType>
    : null;

/** The success response body type of one endpoint. */
export type ResponseOf<Name extends EndpointName> = z.infer<(typeof ENDPOINTS)[Name]["response"]>;
