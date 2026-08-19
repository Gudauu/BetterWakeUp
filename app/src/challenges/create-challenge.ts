/**
 * Turning a draft into a challenge.
 *
 * Two doors, and which one is taken is decided by the deposit alone: a zero
 * deposit challenge is created outright and never touches the payment
 * provider, while a funded one authorizes a hold first and becomes a challenge
 * on the provider's confirmation.
 *
 * The gates are here rather than on the screen. A screen that hides a button
 * has hidden a button; a command that refuses before it builds a request is
 * the thing that makes "the deposit action is unreachable until disclosures
 * are acknowledged" true of the app rather than of one layout.
 */

import {
  type ChallengeView,
  type CreateChallengeRequest,
  type CreateFundingIntentResponse,
  type CreateProjectionResponse,
  DISCLOSURE_POLICY_VERSION,
  disclosuresFor,
  type ErrorCode,
  MAXIMUM_CHALLENGE_DURATION_DAYS,
} from "@betterwakeup/contract";
import type { ApiClient } from "../api/client.ts";
import { ApiError } from "../api/errors.ts";
import { tryAgainMessage, unlistedMessage } from "../api/try-again.ts";
import { waitMessageFor } from "../api/wait-again.ts";
import { type ChallengeDraft, configurationOf, readinessOf } from "./draft.ts";

export type StartChallengeOutcome =
  /** A zero deposit challenge, active already. */
  | { readonly status: "created"; readonly challenge: ChallengeView }
  /**
   * A hold was authorized and the challenge does not exist yet: the app takes
   * the user through the provider's sheet and then polls the current challenge.
   */
  | { readonly status: "fundingRequired"; readonly intent: CreateFundingIntentResponse }
  /** Something the user has not done yet. No request was made. */
  | { readonly status: "blocked"; readonly reasons: readonly string[] }
  | { readonly status: "failed"; readonly message: string };

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  active_challenge_exists: "You already have a challenge running. Only one runs at a time.",
  maximum_duration_exceeded: maximumDurationSentence(MAXIMUM_CHALLENGE_DURATION_DAYS),
  zero_deposit_required: "That challenge has a deposit, so it has to go through the deposit step.",
  deposit_required_for_funding:
    "That challenge has no deposit, so it is created without a payment step.",
  deposit_amount_invalid: "A deposit is either nothing at all or at least one dollar.",
  schedule_invalid: "That weekly schedule cannot be used. Check the active days and deadlines.",
  payment_declined: "Your card was declined, so no hold was placed and no challenge was created.",
  session_expired: "Your session expired. Sign in again to create this challenge.",
  unauthenticated: "Sign in again to create this challenge.",
};

const NETWORK_MESSAGE = "No connection to BetterWakeUp. Check your network and try again.";
const FAILURE_LEAD = "The challenge could not be created.";
const GENERIC_MESSAGE = tryAgainMessage(FAILURE_LEAD);

export function maximumDurationSentence(days: number): string {
  return `A challenge with a deposit has to finish within ${days} days of funding. Shorten it, add active days, or run it with no deposit.`;
}

export interface StartChallengeInput {
  readonly api: ApiClient;
  readonly draft: ChallengeDraft;
  /**
   * The server's projection for this exact configuration, or null when none
   * has come back yet. A funded challenge cannot start without one, because
   * the projected end date is both what the user was shown and what the
   * maximum duration rule is measured against.
   */
  readonly projection: CreateProjectionResponse | null;
}

export async function startChallenge(input: StartChallengeInput): Promise<StartChallengeOutcome> {
  const { api, draft, projection } = input;
  const readiness = readinessOf(draft);
  const reasons: string[] = [];

  if (!readiness.configuration.ok) {
    reasons.push(...readiness.configuration.problems);
  }
  if (!readiness.timeZoneConfirmed) {
    reasons.push("Confirm the time zone your deadlines are read in.");
  }
  if (readiness.outstandingDisclosureIds.length > 0) {
    reasons.push(...outstandingSentences(draft, readiness.outstandingDisclosureIds));
  }

  const funded = draft.depositMinorUnits > 0;
  if (funded && reasons.length === 0) {
    if (projection === null) {
      reasons.push("Wait for the projected end date before depositing.");
    } else if (!projection.withinMaximumDuration) {
      reasons.push(maximumDurationSentence(MAXIMUM_CHALLENGE_DURATION_DAYS));
    }
  }

  if (reasons.length > 0) {
    return { status: "blocked", reasons };
  }

  const configuration = configurationOf(draft);
  if (!configuration.ok) {
    // Unreachable: readiness already established this, and the check is here
    // so the type narrows rather than as a second opinion.
    return { status: "blocked", reasons: configuration.problems };
  }

  const body: CreateChallengeRequest = {
    configuration: configuration.configuration,
    policyVersion: DISCLOSURE_POLICY_VERSION,
  };

  try {
    if (!funded) {
      // The zero deposit path, which is the whole point of the branch: no
      // funding intent, no provider, no sheet. The challenge is active on
      // return.
      const response = await api.request("createChallenge", { body });
      return { status: "created", challenge: response.challenge };
    }
    const intent = await api.request("createFundingIntent", { body });
    return { status: "fundingRequired", intent };
  } catch (cause) {
    return { status: "failed", message: messageFor(cause) };
  }
}

/**
 * What came back when the plan on screen was priced by the server.
 *
 * The three answers are different things to say to the user, which is why a
 * failure is not folded into an absent projection: a plan that is not a
 * challenge yet is waiting on the form above, while a read that did not come
 * back is waiting on nothing at all and needs a press to happen again.
 */
export type ProjectionOutcome =
  | { readonly status: "projected"; readonly projection: CreateProjectionResponse }
  /** Nothing to ask about: the configuration on screen is not a challenge yet. */
  | { readonly status: "unconfigured" }
  /** The server was asked and did not answer. Retryable, and said so. */
  | { readonly status: "unavailable"; readonly message: string };

const PROJECTION_NETWORK_MESSAGE =
  "No connection to BetterWakeUp, so the end date could not be worked out.";
const PROJECTION_GENERIC_MESSAGE = "The end date could not be worked out just now.";

/**
 * The projection, which persists nothing and is safe to ask for on every edit.
 * A failure is reported rather than thrown, because a projection the app could
 * not fetch must block a deposit rather than crash a screen that is being
 * typed into - and must say that it failed, because a funded challenge cannot
 * start without one and a silent failure is a form that never becomes ready.
 */
export async function projectChallenge(
  api: ApiClient,
  draft: ChallengeDraft,
  options: { signal?: AbortSignal } = {},
): Promise<ProjectionOutcome> {
  const configuration = configurationOf(draft);
  if (!configuration.ok) {
    return { status: "unconfigured" };
  }
  try {
    const projection = await api.request("createChallengeProjection", {
      body: { configuration: configuration.configuration },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return { status: "projected", projection };
  } catch (cause) {
    return { status: "unavailable", message: projectionMessageFor(cause) };
  }
}

function projectionMessageFor(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === null) {
    return PROJECTION_NETWORK_MESSAGE;
  }
  return PROJECTION_GENERIC_MESSAGE;
}

function outstandingSentences(draft: ChallengeDraft, ids: readonly string[]): readonly string[] {
  const applicable = disclosuresFor(draft.depositMinorUnits);
  // The ids come from the same list, so the fallback is only for a caller
  // that assembled them by hand.
  return ids.map((id) => applicable.find((item) => item.id === id)?.statement ?? id);
}

function messageFor(cause: unknown): string {
  if (!(cause instanceof ApiError)) {
    return GENERIC_MESSAGE;
  }
  if (cause.status === null) {
    return NETWORK_MESSAGE;
  }
  return waitMessageFor(cause) ?? MESSAGES[cause.code] ?? unlistedMessage(cause, FAILURE_LEAD);
}
