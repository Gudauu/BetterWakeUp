/**
 * Telling a walking user the target is reached without them looking.
 *
 * Everything the walk card says while a window is open is said in pixels: the
 * step count, the steps still owed, and - the moment the target is met - a
 * success-toned "TARGET REACHED" over a button whose label changes to "Save my
 * walk". All of it is correct and none of it can be seen by the person it is
 * for. Walking is the one thing this app asks of anyone, it is done with the
 * phone held down or pocketed, and the screen is deliberately held awake so
 * that it can be pocketed. So the app's own instruction - keep walking until
 * the number is high enough - leaves a user staring at a screen they were told
 * they did not have to watch, or walking hundreds of steps past a target that
 * was met minutes ago.
 *
 * The device has two ways to reach someone who is not looking, and this module
 * uses both: it vibrates, and it says the sentence out loud through whatever
 * screen reader is running. The second is not a lesser copy of the first. A
 * blind user has no reading of the walk at all while it is under way, so the
 * announcement is the only thing on this screen that ever tells them the walk
 * is done.
 *
 * The port exists for the same reason the screen lock's does: the rule of when
 * to fire, and above all of firing exactly once for a window, is worth testing
 * without a device.
 */

import { useEffect, useRef } from "react";
import { AccessibilityInfo, Vibration } from "react-native";
import type { CaptureState } from "./capture.ts";

/** How the phone reaches someone who is not looking at it. */
export interface WalkAlerts {
  /** A pulse felt through a pocket. */
  vibrate(): void;
  /** Said out loud, if anything on the device is reading the screen aloud. */
  announce(message: string): void;
}

/**
 * Two pulses rather than one: a single buzz is what every notification on the
 * phone does, and this one means something the user has to act on.
 */
const PATTERN = [0, 220, 140, 220];

/**
 * The alerts this build uses. Both come from React Native itself rather than
 * from a native module of ours, so there is nothing here to import lazily:
 * `announceForAccessibility` is a no-op when nothing is reading the screen, and
 * a device with no vibrator ignores the pattern.
 */
export function createConfiguredWalkAlerts(): WalkAlerts {
  return {
    vibrate: () => Vibration.vibrate(PATTERN),
    announce: (message) => AccessibilityInfo.announceForAccessibility(message),
  };
}

/** An open window that has just earned the morning, and by how many steps. */
export interface TargetReached {
  /**
   * The window's own identity, taken from when it opened. A walk cannot be
   * resumed, so a second window is a second walk and deserves its own alert -
   * and a re-render of the same one does not.
   */
  readonly window: string;
  readonly steps: number;
}

/**
 * Whether the capture is, right now, an open window past its target.
 *
 * Only an open window counts: a closed one has either been saved or lost, and
 * both of those are states the screen draws for someone who is looking at it
 * again. A zero target would be met before a single step, which would celebrate
 * a walk nobody took.
 */
export function targetReached(state: CaptureState, target: number): TargetReached | null {
  if (state.status !== "recording" || target <= 0 || state.steps < target) {
    return null;
  }
  return { window: state.startedAt.toISOString(), steps: state.steps };
}

/**
 * What is said out loud when the target is met.
 *
 * It names the button rather than describing it, because the next thing a
 * screen-reader user has to do is find that control, and it states the count so
 * the sentence stands on its own for someone who has heard nothing since the
 * walk began.
 */
export function targetReachedText(steps: number): string {
  const counted = steps === 1 ? "1 step" : `${steps} steps`;
  return `Target reached. ${counted} counted. Press Save my walk to finish this morning.`;
}

/**
 * Fires the alerts once, the first time the open window passes its target.
 *
 * Once per window, not once per mount: the guard starts out holding whatever
 * window is already past its target when this is first called, so returning to
 * the task screen part-way through a walk that is already done does not buzz
 * the user a second time for a fact they were told the first time.
 */
export function useTargetReachedAlert(
  state: CaptureState,
  target: number,
  alerts: WalkAlerts,
): void {
  const alerted = useRef<string | null>(targetReached(state, target)?.window ?? null);

  useEffect(() => {
    const reached = targetReached(state, target);
    if (reached === null || alerted.current === reached.window) {
      return;
    }
    alerted.current = reached.window;
    alerts.vibrate();
    alerts.announce(targetReachedText(reached.steps));
  }, [alerts, state, target]);
}
