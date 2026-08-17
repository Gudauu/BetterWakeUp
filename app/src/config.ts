/**
 * Where the app talks to, and what it calls itself when it does.
 *
 * The base URL is read from the build rather than hardcoded, because a
 * development build points at a local server while a store build points at the
 * deployed one, and neither should be a code edit away from the other.
 */

import Constants from "expo-constants";

export interface AppConfig {
  readonly apiBaseUrl: string;
  /** Sent with every completion, so a bad client build can be identified. */
  readonly appVersion: string;
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

export function loadAppConfig(): AppConfig {
  return {
    apiBaseUrl: readApiBaseUrl(),
    appVersion: Constants.expoConfig?.version ?? "0.0.0",
  };
}
