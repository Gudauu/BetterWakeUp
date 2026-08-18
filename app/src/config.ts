/**
 * Where the app talks to, and what it calls itself when it does.
 *
 * The base URL is read from the build rather than hardcoded, because a
 * development build points at a local server while a store build points at the
 * deployed one, and neither should be a code edit away from the other.
 */

import Constants from "expo-constants";

/**
 * What Google needs to mint an ID token for us. Both are absent in a build
 * that has not been given a Google project, which makes Google Sign-In
 * unavailable rather than broken.
 */
export interface GoogleClientIds {
  readonly webClientId: string | undefined;
  readonly iosClientId: string | undefined;
}

export interface AppConfig {
  readonly apiBaseUrl: string;
  /** Sent with every completion, so a bad client build can be identified. */
  readonly appVersion: string;
  readonly google: GoogleClientIds;
  /**
   * Where crash and synchronization reports go. Absent in a build with no
   * Sentry project, which makes reporting inactive rather than broken.
   */
  readonly sentryDsn: string | undefined;
  /**
   * Whether today's task counts typed-in steps instead of walked ones. Off
   * unless a build asks for it, because a store build that invented movement
   * would make the deposit meaningless.
   */
  readonly simulateMovement: boolean;
}

function readApiBaseUrl(): string {
  // An EAS build profile sets the environment variable; app.json's `extra`
  // carries the local default for `expo start`.
  const fromEnvironment = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (typeof fromEnvironment === "string" && fromEnvironment.length > 0) {
    return fromEnvironment.replace(/\/+$/, "");
  }

  const fromManifest = Constants.expoConfig?.extra?.apiBaseUrl;
  if (typeof fromManifest === "string" && fromManifest.length > 0) {
    return fromManifest.replace(/\/+$/, "");
  }

  // Failing here is better than defaulting: a build with no API address would
  // otherwise look installable and fail on the first request.
  throw new Error(
    "No API base URL configured. Set EXPO_PUBLIC_API_BASE_URL or extra.apiBaseUrl in app.json.",
  );
}

/**
 * A client ID is a public identifier and not a secret, so it travels in the
 * same two places the base URL does. Blank and absent are the same answer,
 * because an EAS profile that declares the variable without a value would
 * otherwise configure the SDK with an empty audience.
 */
function readOptional(
  fromEnvironment: string | undefined,
  manifestKey: string,
): string | undefined {
  if (typeof fromEnvironment === "string" && fromEnvironment.length > 0) {
    return fromEnvironment;
  }
  const fromManifest = Constants.expoConfig?.extra?.[manifestKey];
  if (typeof fromManifest === "string" && fromManifest.length > 0) {
    return fromManifest;
  }
  return undefined;
}

/**
 * A switch a build can throw, read the same two ways everything else is.
 *
 * Only "1" and "true" turn it on: an environment variable is a string, so any
 * other spelling - including "false" and "0" - is treated as off rather than as
 * a non-empty and therefore truthy value.
 */
function readFlag(fromEnvironment: string | undefined, manifestKey: string): boolean {
  const value = fromEnvironment ?? Constants.expoConfig?.extra?.[manifestKey];
  if (typeof value === "boolean") {
    return value;
  }
  return value === "1" || value === "true";
}

export function loadAppConfig(): AppConfig {
  return {
    apiBaseUrl: readApiBaseUrl(),
    appVersion: Constants.expoConfig?.version ?? "0.0.0",
    google: {
      webClientId: readOptional(process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID, "googleWebClientId"),
      iosClientId: readOptional(process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID, "googleIosClientId"),
    },
    // A DSN is a public identifier like a client ID, so it travels the same
    // two ways and is never a secret in the repository.
    sentryDsn: readOptional(process.env.EXPO_PUBLIC_SENTRY_DSN, "sentryDsn"),
    simulateMovement: readFlag(process.env.EXPO_PUBLIC_SIMULATE_MOVEMENT, "simulateMovement"),
  };
}
