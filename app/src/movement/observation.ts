/**
 * The one place a platform reading becomes a `MovementObservation`.
 *
 * Two rules hold here and nowhere else:
 *
 * `provenance` is never inferred and never defaulted. There is no parameter
 * with a fallback, no field copied off a reading, and no branch that decides
 * what a reading probably was. Each channel the app can observe movement
 * through gets its own function that states its provenance as a literal, and
 * version 1 has exactly one such channel, so `historical-query` is not
 * constructible from the app at all.
 *
 * `source` is derived from the platform the code is running on, and an
 * unsupported platform throws rather than guessing. A wrong `source` is a lie
 * the server has no way to catch.
 */

import {
  type MovementObservation,
  type MovementSource,
  movementObservation,
} from "@betterwakeup/contract";

/** The platforms the app ships on. `Platform.OS` widens beyond these. */
export type SupportedPlatform = "ios" | "android";

export function movementSourceFor(platform: string): MovementSource {
  switch (platform) {
    case "ios":
      return "expo-pedometer-ios";
    case "android":
      return "expo-pedometer-android";
    default:
      // Web and the simulator-only platforms have no step counter, so there is
      // no honest source to report. Refusing here is what keeps a reading
      // taken somewhere unsupported from reaching the server labelled as if it
      // came off a phone.
      throw new Error(`no pedometer source for platform ${platform}`);
  }
}

export interface LiveForegroundWindow {
  startedAt: Date;
  endedAt: Date;
  steps: number;
  platform: string;
}

/**
 * Normalize a window the app watched while it was open.
 *
 * The result is parsed through the contract rather than merely typed as it, so
 * a window that ends before it starts or a negative step count fails here
 * instead of at the server.
 */
export function observeLiveForeground(window: LiveForegroundWindow): MovementObservation {
  return movementObservation.parse({
    startedAt: window.startedAt.toISOString(),
    endedAt: window.endedAt.toISOString(),
    steps: window.steps,
    provenance: "live-foreground",
    source: movementSourceFor(window.platform),
  });
}
