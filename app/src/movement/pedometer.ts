/**
 * What the app needs from a pedometer, and nothing more.
 *
 * `expo-sensors` is reachable only through this port, for the same reason the
 * sign-in SDKs are reachable only through `ProviderSignIn`: a native module
 * that calls `TurboModuleRegistry.getEnforcing` at import time cannot appear in
 * a test's import graph, and a narrow port is also the honest description of
 * how little the platform gives us. `PedometerResult` carries a step count and
 * nothing else on both platforms, so this port carries a step count and
 * nothing else.
 */

/**
 * What the operating system says about motion access right now.
 *
 * Three states rather than a boolean, because "not asked yet" and "refused"
 * lead to different screens: one asks, the other explains.
 */
export type MovementPermission = "granted" | "denied" | "undetermined";

export interface PedometerSubscription {
  remove(): void;
}

/**
 * A single delivery from `watchStepCount`.
 *
 * `steps` is cumulative since the subscription began, on both platforms, which
 * is why the capture keeps the latest value rather than adding readings up.
 */
export interface StepCountReading {
  steps: number;
}

export interface Pedometer {
  /** Whether this device has a step counter at all. */
  isAvailable(): Promise<boolean>;
  /** Read motion permission without prompting. */
  getPermission(): Promise<MovementPermission>;
  /** Prompt for motion permission, or report the standing answer. */
  requestPermission(): Promise<MovementPermission>;
  /**
   * Start delivering live step counts. There is no historical query here:
   * `getStepCountAsync` is unsupported on Android, so version 1 does not use
   * it on either platform.
   */
  watchStepCount(listener: (reading: StepCountReading) => void): PedometerSubscription;
}

/**
 * Whether the app is in front of the user.
 *
 * Movement counts only while the app is open, so the capture needs to be told
 * when that stops being true. This is a port for the same reason the pedometer
 * is: `AppState` comes from React Native.
 */
export interface ForegroundState {
  isForeground(): boolean;
  subscribe(listener: (foreground: boolean) => void): PedometerSubscription;
}
