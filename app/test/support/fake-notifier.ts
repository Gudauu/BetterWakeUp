/**
 * A notifier that records what would have been scheduled.
 *
 * Every screen test gets one, so that rendering home neither asks a device for
 * notification permission nor leaves the real scheduler to answer. What it
 * records is what the assertions are about: which reminders a challenge in a
 * given state produces, and that a permission is never requested unprompted.
 */

import type { Notifier, ReminderPermission } from "../../src/reminders/notifier.ts";
import type { Reminder } from "../../src/reminders/reminders.ts";

export interface FakeNotifier extends Notifier {
  /** Every set the app scheduled, oldest first. The last one is what stands. */
  readonly scheduled: readonly (readonly Reminder[])[];
  /** How many times the operating system was asked, which should be zero unless pressed. */
  readonly requests: number;
}

export function fakeNotifier(
  options: {
    /** What the device says before anything is pressed. */
    permission?: ReminderPermission;
    /** What the prompt answers. Defaults to the user allowing it. */
    onRequest?: ReminderPermission;
  } = {},
): FakeNotifier {
  const scheduled: (readonly Reminder[])[] = [];
  let permission = options.permission ?? "undetermined";
  let requests = 0;

  return {
    scheduled,
    get requests() {
      return requests;
    },
    async getPermission() {
      return permission;
    },
    async requestPermission() {
      requests += 1;
      permission = options.onRequest ?? "granted";
      return permission;
    },
    async replaceAll(reminders) {
      scheduled.push(reminders);
    },
  };
}
