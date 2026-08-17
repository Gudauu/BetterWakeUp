/**
 * The endpoint registry: every operation, its route, what it accepts, and what
 * it returns.
 *
 * This exists so the route table is data rather than prose. The server mounts
 * routes from it, the app builds requests from it, and the JSON Schema
 * artifact under `generated/` is produced from it, so a schema that no
 * endpoint uses cannot drift into the app unnoticed.
 */

import type { z } from "zod";
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
import { paymentWebhookRequest, paymentWebhookResponse } from "./payments.ts";
import { createCompletionRequest, createCompletionResponse } from "./tasks.ts";

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
  readonly request: z.ZodType | null;
  readonly response: z.ZodType;
}

export const ENDPOINTS = {
  createSession: {
    method: "POST",
    path: "/sessions",
    auth: "none",
    idempotent: false,
    request: createSessionRequest,
    response: createSessionResponse,
  },
  deleteSession: {
    method: "DELETE",
    path: "/sessions",
    auth: "session",
    idempotent: false,
    request: null,
    response: emptyResponse,
  },
  deleteAccount: {
    method: "DELETE",
    path: "/accounts",
    auth: "session",
    idempotent: true,
    request: null,
    response: emptyResponse,
  },
  createChallengeProjection: {
    method: "POST",
    path: "/challenges/projections",
    auth: "session",
    idempotent: false,
    request: createProjectionRequest,
    response: createProjectionResponse,
  },
  createChallenge: {
    method: "POST",
    path: "/challenges",
    auth: "session",
    idempotent: true,
    request: createChallengeRequest,
    response: createChallengeResponse,
  },
  createFundingIntent: {
    method: "POST",
    path: "/challenges/funding-intents",
    auth: "session",
    idempotent: true,
    request: createFundingIntentRequest,
    response: createFundingIntentResponse,
  },
  replacePaymentMethod: {
    method: "POST",
    path: "/challenges/:challengeId/payment-method",
    auth: "session",
    idempotent: true,
    request: replacePaymentMethodRequest,
    response: replacePaymentMethodResponse,
  },
  getCurrentChallenge: {
    method: "GET",
    path: "/challenges/current",
    auth: "session",
    idempotent: false,
    request: null,
    response: getCurrentChallengeResponse,
  },
  changeChallengeTimeZone: {
    method: "POST",
    path: "/challenges/:challengeId/time-zone",
    auth: "session",
    idempotent: true,
    request: changeTimeZoneRequest,
    response: changeTimeZoneResponse,
  },
  pauseChallenge: {
    method: "POST",
    path: "/challenges/:challengeId/pause",
    auth: "session",
    idempotent: true,
    request: pauseChallengeRequest,
    response: pauseChallengeResponse,
  },
  resumeChallenge: {
    method: "DELETE",
    path: "/challenges/:challengeId/pause",
    auth: "session",
    idempotent: true,
    request: resumeChallengeRequest,
    response: resumeChallengeResponse,
  },
  acceptRecovery: {
    method: "POST",
    path: "/challenges/:challengeId/recovery",
    auth: "session",
    idempotent: true,
    request: acceptRecoveryRequest,
    response: acceptRecoveryResponse,
  },
  createCompletion: {
    method: "POST",
    path: "/tasks/:taskId/completions",
    auth: "session",
    idempotent: true,
    request: createCompletionRequest,
    response: createCompletionResponse,
  },
  receivePaymentWebhook: {
    method: "POST",
    path: "/payments/webhooks/:provider",
    auth: "signature",
    idempotent: false,
    request: paymentWebhookRequest,
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

/** The success response body type of one endpoint. */
export type ResponseOf<Name extends EndpointName> = z.infer<(typeof ENDPOINTS)[Name]["response"]>;
