/**
 * The two real providers, assembled from build configuration.
 *
 * This is the only module that pulls both native SDKs in, and it is imported by
 * the router's root layout rather than by the session provider. That is what
 * keeps the SDKs out of everything above the `ProviderSignIn` interface: both
 * register a native module at import time, so a session provider that named
 * them directly would make every test that renders a screen depend on a device.
 */

import { loadAppConfig } from "../config.ts";
import { createAppleSignIn } from "./apple.ts";
import { createGoogleSignIn } from "./google.ts";
import type { ProviderSignIns } from "./provider-sign-in.ts";

export function createNativeProviders(): ProviderSignIns {
  return {
    apple: createAppleSignIn(),
    google: createGoogleSignIn(loadAppConfig().google),
  };
}
