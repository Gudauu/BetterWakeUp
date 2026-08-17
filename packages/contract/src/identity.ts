/**
 * Sign-in, sign-out, and account deletion.
 *
 * The app posts a provider ID token and receives a BetterWakeUp session. The
 * provider `sub` never leaves the server, and an email address is never an
 * identifier: Sign in with Apple may return a private relay address, so
 * treating it as a key would split one person into two accounts.
 */

import { z } from "zod";
import { instant, resourceId } from "./primitives.ts";

export const identityProvider = z.enum(["apple", "google"]);

export const createSessionRequest = z.object({
  provider: identityProvider,
  /** The provider's ID token, verified against its published JWKS. */
  idToken: z.string().min(1),
  /**
   * Apple returns the display name only on the first authorization, so the
   * app forwards it when it has it and omits it otherwise.
   */
  displayName: z.string().min(1).max(120).optional(),
});

export const sessionView = z.object({
  accountId: resourceId,
  token: z.string().min(1),
  expiresAt: instant,
});

export const accountView = z.object({
  id: resourceId,
  displayName: z.string().nullable(),
  /** Display only. Never a key, and absent when the provider withheld it. */
  email: z.string().nullable(),
  createdAt: instant,
  /** False once the account's one lifetime Emergency Recovery has been spent. */
  emergencyRecoveryAvailable: z.boolean(),
});

export const createSessionResponse = z.object({
  session: sessionView,
  account: accountView,
});

/** Sign-out and account deletion both answer with no body. */
export const emptyResponse = z.object({});

export type IdentityProvider = z.infer<typeof identityProvider>;
export type CreateSessionRequest = z.infer<typeof createSessionRequest>;
export type CreateSessionResponse = z.infer<typeof createSessionResponse>;
export type SessionView = z.infer<typeof sessionView>;
export type AccountView = z.infer<typeof accountView>;
export type EmptyResponse = z.infer<typeof emptyResponse>;
