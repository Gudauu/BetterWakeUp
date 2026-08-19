/**
 * The alarm being tapped, as a reason to open something.
 *
 * A reminder exists to get someone out of bed and walking, and the app answered
 * it by opening at home: the walk was two taps and a read of the screen away,
 * at the one moment in the day when the user is least able to do either. What
 * the notification was about is known when it is scheduled, so it travels with
 * the notification and the app opens the thing it named.
 *
 * The port is shaped like `AppReturnTrigger` and `BackPressTrigger`: a
 * subscription a test can drive, with the real implementation kept behind the
 * one module that imports `expo-notifications`.
 *
 * `taken` is separate from `subscribe` because a tap on a locked phone launches
 * the app from nothing: by the time anything has mounted, the tap has already
 * happened and there was no listener to hear it. The operating system holds it,
 * and the implementation hands it over exactly once - a second call answers
 * null, so remounting home does not send the user back to a walk they have
 * already been to.
 */

import type { ChallengeView } from "@betterwakeup/contract";
import { useEffect, useRef } from "react";
import type { ReminderTarget } from "./reminders.ts";

export interface ReminderTapTrigger {
  /**
   * The tap that launched the app, or null when it was opened some other way.
   * Answered once for the life of the process.
   */
  taken(): Promise<ReminderTarget | null>;
  /** Taps that arrive while the app is already running. */
  subscribe(onTap: (target: ReminderTarget) => void): () => void;
}

/**
 * The real one, built without importing anything: the native package is pulled
 * in the first time a tap is actually asked for, so nothing above this line
 * needs a device. A build with no notification module reports no taps rather
 * than failing - the app opening at home is what already happened.
 */
export const reminderTapTrigger: ReminderTapTrigger = {
  async taken() {
    try {
      return await (await native()).taken();
    } catch {
      return null;
    }
  },
  subscribe(onTap) {
    let wanted = true;
    let stop: (() => void) | null = null;
    void (async () => {
      try {
        const started = (await native()).subscribe(onTap);
        // The caller may have unsubscribed while the import was in flight.
        if (wanted) {
          stop = started;
        } else {
          started();
        }
      } catch {
        // Nothing to listen to in this build.
      }
    })();
    return () => {
      wanted = false;
      stop?.();
    };
  },
};

async function native(): Promise<ReminderTapTrigger> {
  return (await import("./native-notifier.ts")).createNativeReminderTaps();
}

/**
 * Calls `onTap` for the tap that launched the app and for every tap after it.
 *
 * `onTap` is held in a ref for the same reason the app-return hook holds its
 * callback: it is rebuilt on every render, and resubscribing that often would
 * drop taps.
 */
export function useReminderTaps(
  onTap: (target: ReminderTarget) => void,
  options: { readonly trigger?: ReminderTapTrigger } = {},
): void {
  const { trigger } = options;
  const latest = useRef(onTap);
  latest.current = onTap;

  useEffect(() => {
    const source = trigger ?? reminderTapTrigger;
    let mounted = true;
    void source
      .taken()
      .then((target) => {
        if (mounted && target !== null) {
          latest.current(target);
        }
      })
      .catch(() => undefined);
    const stop = source.subscribe((target) => latest.current(target));
    return () => {
      mounted = false;
      stop();
    };
  }, [trigger]);
}

/** Where a tap leads, given what the account is actually running right now. */
export type TapDestination = "walk" | "recovery" | "home";

/**
 * What the app should open for a tapped reminder.
 *
 * A reminder is scheduled from the last read and fires from the device, so by
 * the time it is tapped the thing it was about may be gone: the walk was taken
 * on another phone, the challenge was paused, the recovery offer was decided.
 * Home is the honest answer in every one of those cases - it says what is true
 * now - and opening a screen that has nothing left to do on it would be worse
 * than the extra tap this is here to remove.
 */
export function tapDestination(
  target: ReminderTarget,
  challenge: ChallengeView | null,
): TapDestination {
  if (challenge === null) {
    return "home";
  }
  if (target === "recovery") {
    return challenge.recoveryOffer === null ? "home" : "recovery";
  }
  const walkable =
    challenge.status === "active" &&
    challenge.pause.pausedAt === null &&
    challenge.currentTask !== null;
  return walkable ? "walk" : "home";
}
