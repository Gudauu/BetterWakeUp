/**
 * The real pedometer and the real foreground state.
 *
 * This is the only module that imports `expo-sensors` or React Native's
 * `AppState`, so nothing above the ports pulls a native module into its import
 * graph. It is wired in by the screen that captures movement, the same way
 * `native-providers.ts` is wired in by the root layout.
 */

import { Pedometer as ExpoPedometer } from "expo-sensors";
import { AppState, Platform } from "react-native";
import { createMovementCapture, type MovementCapture } from "./capture.ts";
import type { ForegroundState, MovementPermission, Pedometer } from "./pedometer.ts";

function toPermission(status: string): MovementPermission {
  switch (status) {
    case "granted":
      return "granted";
    case "denied":
      return "denied";
    default:
      return "undetermined";
  }
}

export function createNativePedometer(): Pedometer {
  return {
    isAvailable: () => ExpoPedometer.isAvailableAsync(),
    async getPermission() {
      const response = await ExpoPedometer.getPermissionsAsync();
      return toPermission(response.status);
    },
    async requestPermission() {
      const response = await ExpoPedometer.requestPermissionsAsync();
      return toPermission(response.status);
    },
    watchStepCount: (listener) => ExpoPedometer.watchStepCount(listener),
  };
}

/**
 * `active` is the only state that counts as being in front of the user.
 *
 * `inactive` covers the iOS app switcher and an incoming call: the app is on
 * screen but the user is not with it, and the pedometer keeps delivering. It
 * closes the window along with `background`, because the rule is about the
 * user's attention and not about whether the process is running.
 */
export function createNativeForegroundState(): ForegroundState {
  return {
    isForeground: () => AppState.currentState === "active",
    subscribe: (listener) =>
      AppState.addEventListener("change", (next) => {
        listener(next === "active");
      }),
  };
}

/**
 * The capture a screen actually uses, assembled from the real platform.
 *
 * This is the seam: every test builds a capture from fakes, and exactly one
 * function builds one from the device.
 */
export function createNativeMovementCapture(): MovementCapture {
  return createMovementCapture({
    pedometer: createNativePedometer(),
    foreground: createNativeForegroundState(),
    platform: Platform.OS,
  });
}
