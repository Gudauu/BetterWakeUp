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
  readonly available?: boolean;
  /** A credential, `null` for a user who backed out, or a thrown error. */
  readonly result?: ProviderCredential | null | Error;
}

export interface FakeProvider extends ProviderSignIn {
  readonly calls: () => number;
}

export function fakeProvider(options: FakeProviderOptions = {}): FakeProvider {
  const available = options.available ?? true;
  const result = options.result ?? null;
  let calls = 0;
  return {
    calls: () => calls,
    isAvailable: async () => available,
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
