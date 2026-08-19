/**
 * Keeping the screen on for as long as a walk is being counted.
 *
 * A capture window exists only while the app is in front of the user, and the
 * operating system ends that by itself: a phone left untouched hits its
 * auto-lock timer, the screen goes off, the app is no longer in front of
 * anyone, and `createMovementCapture` closes the window and discards what it
 * had counted. Walking is exactly the activity during which nobody touches
 * their phone, so the app's central interaction was the one most likely to be
 * cut short by the device, without the user doing anything wrong.
 *
 * So the screen is held awake for precisely as long as a window is open, and
 * released the moment it closes - a walk is minutes, and a lock left on after
 * one would quietly drain the battery of a phone in a pocket.
 *
 * The port exists for the same reason the pedometer's does: the rule of when to
 * hold and when to release is worth testing without a device. The real
 * implementation lives in `native-screen-lock.ts`, the only module in the app
 * that imports `expo-keep-awake`.
 */

import type { MovementCapture } from "./capture.ts";

export interface ScreenLock {
  /** Stop the device turning its screen off on its own. */
  keepAwake(): Promise<void>;
  /** Hand the screen back to the device's own timer. */
  allowSleep(): Promise<void>;
}

/**
 * The lock this build uses: the real one, imported only when it is first asked
 * for, so nothing above this line pulls the native package into its import
 * graph.
 */
export function createConfiguredScreenLock(): ScreenLock {
  const native = async () => (await import("./native-screen-lock.ts")).createNativeScreenLock();
  return {
    keepAwake: async () => (await native()).keepAwake(),
    allowSleep: async () => (await native()).allowSleep(),
  };
}

/**
 * Holds the screen awake while `capture` is recording. Returns the release,
 * which both stops watching and lets the screen sleep again - a caller that
 * disposed while a window was somehow still open must not leave a lock behind.
 *
 * Requests are queued rather than issued as they arrive: activating and
 * releasing are separate round trips to the operating system, and two in flight
 * at once could land in the opposite order and leave the phone awake for good.
 * Failure is silent, because a device that will not hold its screen on has
 * taken nothing away from a walk that is already being counted, and an error in
 * front of a walking user would be noise they cannot act on.
 */
export function keepScreenAwakeWhileWalking(
  capture: MovementCapture,
  lock: ScreenLock,
): () => void {
  // What the screen has been asked for, not what the device has done yet: the
  // requests below are ordered, so the last one asked for is the one that wins.
  let awake = false;
  let pending: Promise<void> = Promise.resolve();

  function want(next: boolean): void {
    if (next === awake) {
      return;
    }
    awake = next;
    pending = pending
      .then(() => (next ? lock.keepAwake() : lock.allowSleep()))
      .catch(() => undefined);
  }

  want(capture.getState().status === "recording");
  const unsubscribe = capture.subscribe((state) => want(state.status === "recording"));

  return () => {
    unsubscribe();
    want(false);
  };
}
