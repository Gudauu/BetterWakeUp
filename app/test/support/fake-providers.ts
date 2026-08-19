/**
 * Stand-ins for the two native sign-in SDKs.
 *
 * Neither Apple's sheet nor Google's activity can run under Jest, so the tests
 * substitute the `ProviderSignIn` interface instead. That is the whole reason
 * the interface exists: everything above it (the exchange, the persistence, the
 * three outcomes, the screen) is then testable without a device, and only the
 * two thin wrappers are not.
 */

import type {
  ProviderCredential,
  ProviderSignIn,
  ProviderSignIns,
} from "../../src/auth/provider-sign-in.ts";

export interface FakeProviderOptions {
  /**
   * Whether the provider works here - or `"failed"` for a check that throws
   * instead of answering, and `"pending"` for one that never comes back, which
   * are the two states the screen has to tell apart from a plain `false`.
   */
  readonly available?: boolean | "failed" | "pending";
  /** A credential, `null` for a user who backed out, or a thrown error. */
  readonly result?: ProviderCredential | null | Error;
  /**
   * Answers of the second and later checks, for a retry that goes differently
   * from the launch check that led to it.
   */
  readonly thenAvailable?: boolean | "failed" | "pending";
}

export interface FakeProvider extends ProviderSignIn {
  readonly calls: () => number;
  /** How many times the availability check has been asked. */
  readonly checks: () => number;
}

export function fakeProvider(options: FakeProviderOptions = {}): FakeProvider {
  const available = options.available ?? true;
  const result = options.result ?? null;
  let calls = 0;
  let checks = 0;
  return {
    calls: () => calls,
    checks: () => checks,
    isAvailable: async () => {
      checks += 1;
      const answer = checks === 1 ? available : (options.thenAvailable ?? available);
      if (answer === "failed") {
        throw new Error("the native module did not answer");
      }
      if (answer === "pending") {
        return new Promise<boolean>(() => {});
      }
      return answer;
    },
    authenticate: async () => {
      calls += 1;
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  };
}

export function appleCredential(): ProviderCredential {
  return { provider: "apple", idToken: "apple-id-token", displayName: "Ada Lovelace" };
}

export function fakeProviders(overrides: Partial<ProviderSignIns> = {}): ProviderSignIns {
  return {
    apple: overrides.apple ?? fakeProvider({ result: appleCredential() }),
    google: overrides.google ?? fakeProvider({ available: false }),
  };
}
