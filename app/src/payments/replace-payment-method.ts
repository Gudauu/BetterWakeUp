/**
 * The way back from a deposit that stopped being secured.
 *
 * A hold does not last a month. The server renews it, and a renewal fails when
 * a card expires, is replaced by the bank, or is declined; the sweep's answer
 * is to mark the challenge's deposit unsecured and keep the challenge running.
 * Home has said so since the field existed - "Your card no longer secures this
 * deposit. Add a new one" - with nothing behind the sentence to press.
 *
 * `POST /challenges/:challengeId/payment-method` has been there all along. This
 * is the app's half: which challenges are worth offering it for, and what each
 * refusal means in the user's terms. A decline here is the provider refusing
 * the new instrument off-session, which is answered with a different card
 * rather than by trying the same one again.
 */

import type {
  ChallengeView,
  ErrorCode,
  ReplacePaymentMethodResponse,
} from "@betterwakeup/contract";
import type { ApiClient } from "../api/client.ts";
import { ApiError } from "../api/errors.ts";
import type { CommandOutcome } from "../challenges/lifecycle-commands.ts";

/**
 * Whether this challenge has a deposit that could be secured again. It must
 * still be running - the server refuses a terminal one, which has no hold left
 * to keep alive - and it must have staked something, since a challenge with no
 * deposit has no payment method to replace.
 */
export function needsPaymentMethod(challenge: ChallengeView): boolean {
  if (challenge.depositSecured) {
    return false;
  }
  if (challenge.configuration.deposit.amount === 0) {
    return false;
  }
  return challenge.status === "active" || challenge.status === "recovery_pending";
}

const NETWORK_MESSAGE = "No connection to BetterWakeUp. Check your network and try again.";
const GENERIC_MESSAGE = "That card could not be put in place. Try again in a moment.";

export const DECLINED_MESSAGE =
  "Your bank declined that card, so nothing was held. Try a different one.";

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  payment_declined: DECLINED_MESSAGE,
  challenge_not_active: "This challenge has ended, so it has no deposit left to secure.",
  deposit_required_for_funding: "This challenge has no deposit, so it needs no card.",
  not_found: "This challenge is no longer on your account.",
  session_expired: "Your session expired. Sign in again to add a card.",
  unauthenticated: "Sign in again to add a card.",
  rate_limited: "Too many attempts. Wait a moment and try again.",
};

export interface ReplacePaymentMethodInput {
  readonly api: ApiClient;
  readonly challenge: ChallengeView;
  /** The instrument the provider now holds, from the sheet the user just used. */
  readonly providerPaymentMethodId: string;
}

/**
 * Put a card in place of the one that lapsed.
 *
 * Not confirmation-gated: the amount was agreed when the challenge was created
 * and is not being changed, and the user has just typed a card into a sheet on
 * purpose. Asking again would only delay the one action that makes their
 * challenge honest.
 */
export async function replacePaymentMethod(
  input: ReplacePaymentMethodInput,
): Promise<CommandOutcome<ReplacePaymentMethodResponse>> {
  if (input.providerPaymentMethodId.length === 0) {
    return { status: "blocked", reasons: ["No card was given, so nothing was changed."] };
  }
  try {
    const value = await input.api.request("replacePaymentMethod", {
      params: { challengeId: input.challenge.id },
      body: { providerPaymentMethodId: input.providerPaymentMethodId },
    });
    return { status: "done", value };
  } catch (cause) {
    return { status: "failed", message: messageFor(cause) };
  }
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
