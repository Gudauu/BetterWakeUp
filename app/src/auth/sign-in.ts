/**
 * The sign-in flow: native credential, then session exchange.
 *
 * It lives outside React so the three outcomes can be tested without a screen,
 * and so the screen has exactly one branch per outcome. Cancellation is one of
 * the three: a user who dismissed Apple's sheet has not failed at anything and
 * must not be shown an error.
 */

import type { ErrorCode, SessionView } from "@betterwakeup/contract";
import type { ApiClient } from "../api/client.ts";
import { ApiError } from "../api/errors.ts";
import { waitMessageFor } from "../api/wait-again.ts";
import type { ProviderSignIn } from "./provider-sign-in.ts";

export type SignInOutcome =
  | { readonly status: "signedIn"; readonly session: SessionView }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly message: string };

/**
 * What the user is told, per contract error code. Everything unlisted gets the
 * generic line: an operator-facing code such as `internal_error` names a server
 * problem, and repeating it to the user tells them nothing they can act on.
 */
const MESSAGES: Partial<Record<ErrorCode, string>> = {
  // The server answers `unauthenticated` for a provider token it could not
  // verify, which on this path means the credential and never a stale session.
  unauthenticated:
    "That sign-in could not be verified. Try again, and check the date and time on your device.",
  validation_failed: "That sign-in could not be verified. Try again.",
};

const NETWORK_MESSAGE = "No connection to BetterWakeUp. Check your network and try again.";
const GENERIC_MESSAGE = "Sign-in failed. Try again in a moment.";

export interface SignInDependencies {
  readonly api: ApiClient;
  readonly provider: ProviderSignIn;
}

export async function signInWithProvider(deps: SignInDependencies): Promise<SignInOutcome> {
  let credential: Awaited<ReturnType<ProviderSignIn["authenticate"]>>;
  try {
    credential = await deps.provider.authenticate();
  } catch {
    // The provider's own message is the SDK's, not ours, and may name a native
    // module. The user gets one sentence they can act on.
    return { status: "failed", message: GENERIC_MESSAGE };
  }

  if (credential === null) {
    return { status: "cancelled" };
  }

  try {
    const response = await deps.api.request("createSession", { body: credential });
    return { status: "signedIn", session: response.session };
  } catch (cause) {
    return { status: "failed", message: messageFor(cause) };
  }
}

function messageFor(cause: unknown): string {
  if (!(cause instanceof ApiError)) {
    return GENERIC_MESSAGE;
  }
  // A request that never reached the server is a network problem and not a
  // rejected credential, which is what `status === null` means.
  if (cause.status === null) {
    return NETWORK_MESSAGE;
  }
  return (
    waitMessageFor(cause, "Too many sign-in attempts.") ?? MESSAGES[cause.code] ?? GENERIC_MESSAGE
  );
}
