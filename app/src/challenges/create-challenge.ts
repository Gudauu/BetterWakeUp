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
  type CreateFundingIntentResponse,
  type CreateProjectionResponse,
  type ErrorCode,
  MAXIMUM_CHALLENGE_DURATION_DAYS,
} from "@betterwakeup/contract";
import type { ApiClient } from "../api/client.ts";
import { ApiError } from "../api/errors.ts";
import { DISCLOSURE_POLICY_VERSION, disclosuresFor } from "./disclosures.ts";
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
  rate_limited: "Too many attempts. Wait a moment and try again.",
  session_expired: "Your session expired. Sign in again to create this challenge.",
  unauthenticated: "Sign in again to create this challenge.",
};

const NETWORK_MESSAGE = "No connection to BetterWakeUp. Check your network and try again.";
const GENERIC_MESSAGE = "The challenge could not be created. Try again in a moment.";

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

  const body = {
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
 * The projection, which persists nothing and is safe to ask for on every edit.
 * A failure is reported as an absent projection rather than thrown, because a
 * projection the app could not fetch must block a deposit rather than crash a
 * screen.
 */
export async function projectChallenge(
  api: ApiClient,
  draft: ChallengeDraft,
  options: { signal?: AbortSignal } = {},
): Promise<CreateProjectionResponse | null> {
  const configuration = configurationOf(draft);
  if (!configuration.ok) {
    return null;
  }
  try {
    return await api.request("createChallengeProjection", {
      body: { configuration: configuration.configuration },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    return null;
  }
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
  return MESSAGES[cause.code] ?? GENERIC_MESSAGE;
}
