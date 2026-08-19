/**
 * A wake-up reminder being tapped, as something a test can do.
 *
 * The real trigger is the operating system handing back a notification
 * response, which a test has no way to produce. Here a tap is a call, and a
 * launch tap - the one that opened the app from nothing - is stated up front,
 * because that is the case with no listener to hear it.
 */

import { act } from "@testing-library/react-native";
import type { ReminderTapTrigger } from "../../src/reminders/reminder-taps.ts";
import type { ReminderTarget } from "../../src/reminders/reminders.ts";

export interface FakeReminderTaps {
  readonly trigger: ReminderTapTrigger;
  /** A reminder is tapped while the app is running. Settles what it opens. */
  tap(target: ReminderTarget): Promise<void>;
}

export function fakeReminderTaps(
  options: { readonly launchedBy?: ReminderTarget } = {},
): FakeReminderTaps {
  const listeners = new Set<(target: ReminderTarget) => void>();
  // Handed over exactly once, the way the real one does: the operating system
  // keeps answering with the same launch response for the life of the process.
  let launch = options.launchedBy ?? null;
  return {
    trigger: {
      async taken() {
        const target = launch;
        launch = null;
        return target;
      },
      subscribe(onTap) {
        listeners.add(onTap);
        return () => {
          listeners.delete(onTap);
        };
      },
    },
    async tap(target) {
      await act(async () => {
        for (const listener of [...listeners]) {
          listener(target);
        }
      });
    },
  };
}
