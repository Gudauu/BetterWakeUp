/**
 * What a native sign-in provider has to be able to do.
 *
 * The app's only interest in Apple and Google is an ID token to post to
 * `POST /sessions`; everything else the two SDKs offer (profiles, access
 * tokens, silent refresh) is deliberately outside this interface, so no screen
 * can start depending on a provider's own notion of who is signed in. The
 * server's session is the only such notion.
 */

import type { CreateSessionRequest, IdentityProvider } from "@betterwakeup/contract";

/** Exactly the body `POST /sessions` takes, so nothing is assembled twice. */
export type ProviderCredential = CreateSessionRequest;

export interface ProviderSignIn {
  /**
   * Whether this provider can be offered on this device and in this build.
   * Sign in with Apple exists only on iOS 13 and later, and Google needs a
   * client ID that a build may not have been given, so a provider that cannot
   * work is hidden rather than shown and then failing.
   */
  isAvailable(): Promise<boolean>;
  /**
   * Run the native flow. Resolves to `null` when the user backed out, which is
   * not a failure and must never be reported as one; anything genuinely wrong
   * throws.
   */
  authenticate(): Promise<ProviderCredential | null>;
}

export type ProviderSignIns = Readonly<Record<IdentityProvider, ProviderSignIn>>;
