/**
 * The commands that pause, resume, spend the Emergency Recovery, and delete
 * the account.
 *
 * Three of these cannot be taken back: pausing gives up the tasks it skips,
 * accepting the recovery consumes an allowance that never replenishes, and
 * deleting the account removes it. Each one therefore takes an explicit
 * `confirmed` flag and refuses before it builds a request when that flag is
 * missing, so "requires explicit confirmation" is a property of the command
 * rather than of whichever screen happens to call it. A test proves it by
 * asserting the API client was never asked for anything.
 *
 * Resume is deliberately not gated: nothing is given up by facing deadlines
 * again, and a confirmation that guards a reversible action teaches the user
 * to dismiss the ones that matter.
 */

import type {
  AcceptRecoveryResponse,
  ChallengeView,
  ErrorCode,
  PauseChallengeResponse,
  ResumeChallengeResponse,
} from "@betterwakeup/contract";
import type { ApiClient } from "../api/client.ts";
import { ApiError } from "../api/errors.ts";
import { waitMessageFor } from "../api/wait-again.ts";

export type CommandOutcome<Value> =
  | { readonly status: "done"; readonly value: Value }
  /** Something the user has not done, or cannot do. No request was made. */
  | { readonly status: "blocked"; readonly reasons: readonly string[] }
  | { readonly status: "failed"; readonly message: string };

const NETWORK_MESSAGE = "No connection to BetterWakeUp. Check your network and try again.";
const GENERIC_MESSAGE = "That did not go through. Try again in a moment.";

export const RECOVERY_EXPIRED = "That recovery offer expired, so the deposit has been settled.";
export const FUNDED_CHALLENGE_HOLDS_DELETION =
  "Your account still holds a funded challenge. It can be deleted once that challenge settles.";

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  challenge_already_paused: "This challenge is already paused.",
  challenge_not_paused: "This challenge is already running.",
  challenge_not_active: "This challenge is no longer running, so it cannot be paused or resumed.",
  pause_cutoff_passed: "It is too late to pause out of the next task. It stays live.",
  recovery_not_offered: "There is no recovery offer open for that day.",
  recovery_window_closed: RECOVERY_EXPIRED,
  recovery_already_consumed: "Your one Emergency Recovery has already been used.",
  account_has_active_funded_challenge: FUNDED_CHALLENGE_HOLDS_DELETION,
  session_expired: "Your session expired. Sign in again.",
  unauthenticated: "Sign in again to do that.",
};

export const PAUSE_CONFIRMATION_REQUIRED = "Confirm the pause before it is applied.";
export const RECOVERY_CONFIRMATION_REQUIRED =
  "Confirm that you want to spend your one Emergency Recovery. It cannot be undone.";
export const DELETION_CONFIRMATION_REQUIRED =
  "Confirm that you want to delete your account. It cannot be undone.";

export interface PauseInput {
  readonly api: ApiClient;
  readonly challenge: ChallengeView;
  readonly confirmed: boolean;
}

export async function pauseChallenge(
  input: PauseInput,
): Promise<CommandOutcome<PauseChallengeResponse>> {
  if (!input.confirmed) {
    return { status: "blocked", reasons: [PAUSE_CONFIRMATION_REQUIRED] };
  }
  return await attempt(async () =>
    input.api.request("pauseChallenge", {
      params: { challengeId: input.challenge.id },
      body: {},
    }),
  );
}

export async function resumeChallenge(input: {
  readonly api: ApiClient;
  readonly challenge: ChallengeView;
}): Promise<CommandOutcome<ResumeChallengeResponse>> {
  return await attempt(async () =>
    input.api.request("resumeChallenge", { params: { challengeId: input.challenge.id } }),
  );
}

export interface AcceptRecoveryInput {
  readonly api: ApiClient;
  readonly challenge: ChallengeView;
  readonly confirmed: boolean;
  readonly now: Date;
}

export async function acceptRecovery(
  input: AcceptRecoveryInput,
): Promise<CommandOutcome<AcceptRecoveryResponse>> {
  const offer = input.challenge.recoveryOffer;
  if (offer === null) {
    return { status: "blocked", reasons: ["There is no recovery offer open."] };
  }
  if (Date.parse(offer.expiresAt) <= input.now.getTime()) {
    // The server would refuse this too, and refusing here means an expired
    // offer never spends the allowance on a race the user cannot see.
    return { status: "blocked", reasons: [RECOVERY_EXPIRED] };
  }
  if (!input.confirmed) {
    return { status: "blocked", reasons: [RECOVERY_CONFIRMATION_REQUIRED] };
  }
  return await attempt(async () =>
    input.api.request("acceptRecovery", {
      params: { challengeId: input.challenge.id },
      // The offer's own task ID, so a stale offer held on screen cannot be
      // accepted against whatever task is current by the time it is tapped.
      body: { taskId: offer.taskId },
    }),
  );
}

export interface DeleteAccountInput {
  readonly api: ApiClient;
  /** The account's current challenge, or null when it holds none. */
  readonly challenge: ChallengeView | null;
  readonly confirmed: boolean;
}

export async function deleteAccount(input: DeleteAccountInput): Promise<CommandOutcome<null>> {
  const blocker = deletionBlocker(input.challenge);
  if (blocker !== null) {
    return { status: "blocked", reasons: [blocker] };
  }
  if (!input.confirmed) {
    return { status: "blocked", reasons: [DELETION_CONFIRMATION_REQUIRED] };
  }
  return await attempt(async () => {
    await input.api.request("deleteAccount", {});
    return null;
  });
}

/**
 * Why the account cannot be deleted yet, or null when it can. A funded
 * challenge holds money that has to settle first, and the flow has to say so
 * rather than fail at the server.
 */
export function deletionBlocker(challenge: ChallengeView | null): string | null {
  if (challenge === null) {
    return null;
  }
  const funded = challenge.configuration.deposit.amount > 0;
  // `expired` counts as settled: a pause that reached its year released the
  // hold and charged nothing, so there is no money left to wait on.
  const settled = challenge.status !== "active" && challenge.status !== "recovery_pending";
  if (funded && !settled) {
    return FUNDED_CHALLENGE_HOLDS_DELETION;
  }
  return null;
}

async function attempt<Value>(run: () => Promise<Value>): Promise<CommandOutcome<Value>> {
  try {
    return { status: "done", value: await run() };
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
  return waitMessageFor(cause) ?? MESSAGES[cause.code] ?? GENERIC_MESSAGE;
}
