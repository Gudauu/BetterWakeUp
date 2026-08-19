/**
 * The real notification scheduler.
 *
 * This is the only module in the app that imports `expo-notifications`, the
 * same way `native-pedometer.ts` is the only one that imports `expo-sensors`,
 * so nothing above the port pulls a native module into its import graph.
 *
 * Everything scheduled here is local. A reminder is a wall-clock fact the
 * device already knows - the deadline came from the server on the last read -
 * so it needs no push token, no server-side scheduler, and no network at the
 * moment it has to fire, which is exactly the moment a phone on a bedside
 * table is least likely to have one.
 */

import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { Notifier, ReminderPermission } from "./notifier.ts";
import type { ReminderTapTrigger } from "./reminder-taps.ts";
import type { Reminder, ReminderTarget } from "./reminders.ts";

/**
 * Android puts every notification in a channel, and one that names itself is
 * one the user can turn down rather than turn off: someone who wants the alarm
 * without a sound has a setting instead of a decision about the whole app.
 */
const CHANNEL_ID = "wake-up";

/**
 * A reminder that arrives while the app is open is still worth showing. The
 * user may be on any screen, and the deadline is the same deadline.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

function toPermission(status: string, canAskAgain: boolean): ReminderPermission {
  if (status === "granted") {
    return "granted";
  }
  // A device that has not been asked and one that said no look the same in the
  // status alone on Android; `canAskAgain` is what separates "we have not asked
  // yet" from "the user has decided", and only the first is worth a button.
  return status === "denied" && !canAskAgain ? "denied" : "undetermined";
}

export function createNativeNotifier(): Notifier {
  return {
    async getPermission() {
      const response = await Notifications.getPermissionsAsync();
      return toPermission(response.status, response.canAskAgain);
    },

    async requestPermission() {
      if (Platform.OS === "android") {
        await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
          name: "Wake-up reminders",
          importance: Notifications.AndroidImportance.HIGH,
          sound: "default",
        });
      }
      const response = await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowSound: true },
      });
      // A refusal is a refusal, whatever the platform says about asking again:
      // the user has just been shown the prompt and answered it.
      return response.status === "granted" ? "granted" : "denied";
    },

    async replaceAll(reminders) {
      // Cancelling first is what makes the id stable rather than incidental:
      // the app's scheduled set is replaced whole on every read, so a task that
      // was completed, skipped or paused away takes its reminders with it.
      await Notifications.cancelAllScheduledNotificationsAsync();
      await Promise.all(reminders.map(schedule));
    },
  };
}

/**
 * The tap that opened the app, and the ones that arrive while it is open.
 *
 * A launch tap is read once and then forgotten: the operating system keeps
 * answering with the same response for the life of the process, so a second
 * read - after home remounts, or after signing back in - would send the user
 * off to the walk again from wherever they had got to.
 */
export function createNativeReminderTaps(): ReminderTapTrigger {
  let launchRead = false;
  return {
    async taken() {
      if (launchRead) {
        return null;
      }
      launchRead = true;
      return targetOf(await Notifications.getLastNotificationResponseAsync());
    },
    subscribe(onTap) {
      const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
        const target = targetOf(response);
        if (target !== null) {
          onTap(target);
        }
      });
      return () => subscription.remove();
    },
  };
}

/**
 * What a tapped notification was asking for. Anything without the app's own
 * `opens` payload - a notification from an older install, or one this app did
 * not schedule - leads nowhere in particular and is ignored.
 */
function targetOf(response: Notifications.NotificationResponse | null): ReminderTarget | null {
  const opens = response?.notification.request.content.data?.opens;
  return opens === "walk" || opens === "recovery" ? opens : null;
}

async function schedule(reminder: Reminder): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    identifier: reminder.id,
    content: {
      title: reminder.title,
      body: reminder.body,
      sound: "default",
      // Read back when the notification is tapped, which is the only moment
      // the app can find out what the user was answering.
      data: { opens: reminder.opens },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: new Date(reminder.at),
      ...(Platform.OS === "android" ? { channelId: CHANNEL_ID } : {}),
    },
  });
}
