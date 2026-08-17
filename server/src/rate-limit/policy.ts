/**
 * What is limited, how much, and against whom.
 *
 * Keyed by endpoint name and exhaustive by type, on the same principle as
 * `ERROR_PROPERTIES`: an endpoint added to the contract without a decision here
 * fails the server typecheck rather than quietly arriving unlimited. `null` is
 * that decision written down, not its absence.
 *
 * The numbers are policy and live in the server rather than the contract. An
 * app that knew them would be tempted to enforce them, and a client-side limit
 * is worth having as backoff but is no part of this: an abusive caller does not
 * run our client.
 */

import type { EndpointName } from "@betterwakeup/contract";

/**
 * Whose allowance is being spent.
 *
 * `account` is the authenticated caller, and is only meaningful on an endpoint
 * that has one, which `registerRoutes` checks at mount time. `client` is the
 * source address, which is all there is to count before a session exists.
 */
export type RateLimitScope = "account" | "client";

export interface RateLimitPolicy {
  /**
   * The allowance's name, independent of the route. Endpoints that share a
   * bucket share an allowance: pause and resume are one limit, so alternating
   * between them does not buy twice the calls.
   */
  readonly bucket: string;
  readonly scope: RateLimitScope;
  /** Requests permitted per window. The one that exceeds it is refused. */
  readonly limit: number;
  readonly windowSeconds: number;
}

const MINUTES = 60;
const HOUR = 3600;

/** One allowance shared by pause and resume. */
const PAUSE: RateLimitPolicy = {
  bucket: "challenge-pause",
  scope: "account",
  limit: 10,
  windowSeconds: HOUR,
};

/**
 * One allowance shared by the endpoints that move money around, since both
 * reach the payment provider and a provider call is the expensive thing.
 */
const PAYMENT: RateLimitPolicy = {
  bucket: "payment",
  scope: "account",
  limit: 10,
  windowSeconds: HOUR,
};

export const RATE_LIMITS: Readonly<Record<EndpointName, RateLimitPolicy | null>> = {
  // Before a session exists there is no account to count, so sign-in is counted
  // by source address. This is the only limit that has to hold against a caller
  // holding no credential at all.
  createSession: {
    bucket: "session-create",
    scope: "client",
    limit: 10,
    windowSeconds: 5 * MINUTES,
  },
  deleteSession: {
    bucket: "session-delete",
    scope: "account",
    limit: 20,
    windowSeconds: 5 * MINUTES,
  },
  // Deletion is destructive and irreversible; nobody legitimately calls it in
  // a loop.
  deleteAccount: { bucket: "account-delete", scope: "account", limit: 5, windowSeconds: HOUR },

  createCompletion: {
    bucket: "completion",
    scope: "account",
    limit: 20,
    windowSeconds: 5 * MINUTES,
  },

  pauseChallenge: PAUSE,
  resumeChallenge: PAUSE,

  createFundingIntent: PAYMENT,
  replacePaymentMethod: PAYMENT,

  // Reads and the projection persist nothing and cost one query, and the
  // Lambda's reserved concurrency is the ceiling that covers them.
  getCurrentChallenge: null,
  createChallengeProjection: null,
  // Creating a challenge is already bounded by the one-active-challenge index.
  createChallenge: null,
  changeChallengeTimeZone: null,
  acceptRecovery: null,

  // Not limited, deliberately. The caller is the payment provider proving
  // itself by signature, and dropping its retries would lose events that
  // decide whether money moved. Its volume is bounded by our own commands.
  receivePaymentWebhook: null,
};
