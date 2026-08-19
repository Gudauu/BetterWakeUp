/**
 * The real screen lock.
 *
 * This is the only module that imports `expo-keep-awake`, so nothing above the
 * port pulls a native module into its import graph.
 *
 * The lock is taken under a tag of this app's own rather than the default one:
 * a tag is released independently of every other, so a walk's lock cannot be
 * dropped by some other part of the app releasing the shared default, nor hold
 * the screen on for whatever took that one out.
 */

import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import type { ScreenLock } from "./screen-lock.ts";

const WALK_TAG = "betterwakeup-walk";

export function createNativeScreenLock(): ScreenLock {
  return {
    keepAwake: () => activateKeepAwakeAsync(WALK_TAG),
    allowSleep: () => deactivateKeepAwake(WALK_TAG),
  };
}
