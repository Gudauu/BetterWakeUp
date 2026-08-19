/**
 * The port a reminder is scheduled through, and the hook that keeps the
 * device's picture of the future in step with the server's.
 *
 * The port exists for the same reason the pedometer's does: a screen that
 * reached for `expo-notifications` could only be tested on a device, and the
 * decision of what to remind about is worth testing without one. The real
 * implementation lives in `native-notifier.ts`, which is the only module in the
 * app that imports the native package.
 */

import type { ChallengeView } from "@betterwakeup/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Reminder, remindersFor } from "./reminders.ts";

/** What the operating system says about showing notifications for this app. */
export type ReminderPermission = "granted" | "denied" | "undetermined";

export interface Notifier {
  getPermission(): Promise<ReminderPermission>;
  /**
   * Asks the operating system. Only ever called from a press: iOS gives an app
   * one prompt for the lifetime of an install, and spending it on launch - in
   * front of a user who has not yet seen what the app is for - is how an app
   * ends up permanently unable to remind anyone of anything.
   */
  requestPermission(): Promise<ReminderPermission>;
  /**
   * Replaces every reminder this app has scheduled with exactly these. Replace
   * rather than add, because the app's knowledge of what is due is refreshed
   * whole on every read of the challenge.
   */
  replaceAll(reminders: readonly Reminder[]): Promise<void>;
}

/** How a notifier is built. Substituted in tests; a build passes nothing. */
export type NotifierFactory = () => Notifier;

/**
 * The notifier this build uses: the real one, imported only when it is first
 * asked for. Nothing above this line pulls the native package into its import
 * graph, so the screens stay testable without a device.
 */
export function createConfiguredNotifier(): Notifier {
  const native = async () => (await import("./native-notifier.ts")).createNativeNotifier();
  return {
    getPermission: async () => (await native()).getPermission(),
    requestPermission: async () => (await native()).requestPermission(),
    replaceAll: async (reminders) => (await native()).replaceAll(reminders),
  };
}

/**
 * Takes every reminder off the device once nobody is signed in.
 *
 * `useReminders` only ever replaces what it schedules while home is mounted, so
 * a session that ends leaves the last set it wrote standing: the phone goes on
 * waking someone at 6:15 for an account it can no longer reach, and the walk
 * the alarm asks for cannot be taken, because taking it needs a session. An
 * alarm that cannot be acted on is worse than no alarm.
 *
 * It runs on the transition rather than on every render, and it runs for a
 * first launch too - a device with no session should hold no reminders, whether
 * it lost one or never had one. Clearing is silent for the same reason
 * scheduling is: there is no screen this could usefully fail on.
 */
export function useRemindersClearedWhenSignedOut(notifier: Notifier, signedOut: boolean): void {
  useEffect(() => {
    if (!signedOut) {
      return;
    }
    void notifier.replaceAll([]).catch(() => undefined);
  }, [notifier, signedOut]);
}

export interface RemindersState {
  readonly permission: ReminderPermission;
  /** Asks the operating system, then schedules if it said yes. */
  enable(): void;
  /** True while the prompt is up, so the button it came from can say so. */
  readonly enabling: boolean;
}

/**
 * Keeps the device's scheduled reminders equal to what this challenge wants.
 *
 * It runs on every change of the challenge - which is every read home makes -
 * because that is when the app learns a task was completed, a challenge was
 * paused, or a new day was materialized. A device that was never granted
 * permission schedules nothing and asks nothing; the screen offers the switch
 * instead.
 *
 * `undefined` means the app does not yet know what the account is running, and
 * differs from `null` in exactly the way that matters: a read still in flight,
 * or one that failed, leaves the reminders already on the device alone, while
 * an answer of "no challenge" clears them. Losing tomorrow's alarm to a
 * momentary network failure is the one outcome this hook must not have.
 */
export function useReminders(
  challenge: ChallengeView | null | undefined,
  notifier: Notifier,
): RemindersState {
  const [permission, setPermission] = useState<ReminderPermission>("undetermined");
  const [enabling, setEnabling] = useState(false);
  // Every pass cancels what the device holds before scheduling its own, so two
  // running at once could have one's cancellation land on the other's
  // reminders. They are queued behind each other instead of racing.
  const pending = useRef<Promise<void>>(Promise.resolve());

  const schedule = useCallback(
    (target: ChallengeView | null | undefined) => {
      if (target === undefined) {
        return;
      }
      const reminders = remindersFor(target, new Date());
      // Failure here is silent on purpose: a device that refused to schedule a
      // notification has taken nothing away from the user that they had a
      // moment ago, and an error banner over today's walk would be noise.
      pending.current = pending.current
        .then(() => notifier.replaceAll(reminders))
        .catch(() => undefined);
    },
    [notifier],
  );

  useEffect(() => {
    let active = true;
    void notifier.getPermission().then(
      (status) => {
        if (!active) {
          return;
        }
        setPermission(status);
        if (status === "granted") {
          schedule(challenge);
        }
      },
      () => {
        // A notifier that cannot even be asked is treated as a device that
        // said no: the screen then offers the switch, and pressing it is the
        // one thing that could change the answer.
        if (active) {
          setPermission("denied");
        }
      },
    );
    return () => {
      active = false;
    };
  }, [challenge, notifier, schedule]);

  const enable = useCallback(() => {
    setEnabling(true);
    void notifier.requestPermission().then(
      (status) => {
        setPermission(status);
        setEnabling(false);
        if (status === "granted") {
          schedule(challenge);
        }
      },
      () => {
        setPermission("denied");
        setEnabling(false);
      },
    );
  }, [challenge, notifier, schedule]);

  return { permission, enable, enabling };
}
