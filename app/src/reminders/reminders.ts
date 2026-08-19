/**
 * The nudge before the deadline.
 *
 * The product is a wake-up challenge with money on it, and until now the only
 * thing that ever told a user their walk was due was the user. Opening the app
 * on the right morning, before a wall-clock time, with a deposit riding on it,
 * was left entirely to memory - so a forgotten morning cost real money for a
 * reason that had nothing to do with wanting to get up.
 *
 * What is scheduled comes from instants the server sent. A challenge carries
 * one open task at a time and that task carries its own deadline, so the app
 * never derives when a walk is due from the weekly schedule: it reminds about
 * the task it was handed, and asks again the next time it reads the challenge.
 *
 * Two reminders per task, because they answer different things. The first is
 * the alarm - enough time to get up and walk. The second is the last call, for
 * a morning that is already going wrong. A third would be nagging.
 */

import type { ChallengeView } from "@betterwakeup/contract";
import { formatTimeOfDay } from "../ui/format.ts";

/** How long before the deadline the alarm lands. Enough time to walk it off. */
export const ALARM_LEAD_MINUTES = 45;

/** The last call, for a user who slept through the first one. */
export const LAST_CALL_LEAD_MINUTES = 10;

/**
 * How long before a recovery offer lapses the user is told. The offer decides
 * whether a deposit is charged, so it is the one reminder that is about money
 * rather than about walking.
 */
export const RECOVERY_LEAD_MINUTES = 60;

/**
 * What a reminder is asking for, and therefore what tapping it should open.
 * Carried on the notification itself rather than worked out when the tap
 * arrives: the app may have been launched by the tap and know nothing yet.
 */
export type ReminderTarget = "walk" | "recovery";

/**
 * One scheduled notification.
 *
 * The `id` is derived from what the reminder is about rather than generated,
 * so re-scheduling the same task after another read of the challenge replaces
 * the notification instead of stacking a second copy of it.
 */
export interface Reminder {
  readonly id: string;
  /** When it fires, as an instant. */
  readonly at: string;
  readonly title: string;
  readonly body: string;
  /** What the user is being asked to do, so the tap can lead there. */
  readonly opens: ReminderTarget;
}

/**
 * What this challenge should have scheduled right now.
 *
 * The whole set is returned every time rather than a difference, because the
 * notifier replaces what it holds: the app's picture of the future is only ever
 * as old as the last read, and a reminder for a task that has since been
 * completed, skipped or paused away has to disappear rather than fire.
 */
export function remindersFor(challenge: ChallengeView | null, now: Date): readonly Reminder[] {
  if (challenge === null) {
    return [];
  }

  const reminders: Reminder[] = [];
  const { configuration, currentTask, recoveryOffer } = challenge;

  // Nothing is due while a challenge is paused, and nothing is due once it has
  // ended, so neither gets an alarm. A `recovery_pending` challenge has no open
  // task either - it is waiting on a decision, which is the reminder below.
  if (challenge.status === "active" && challenge.pause.pausedAt === null && currentTask !== null) {
    if (currentTask.status === "scheduled") {
      const time = formatTimeOfDay(currentTask.deadline, configuration.timeZone);
      reminders.push({
        id: `${currentTask.id}:alarm`,
        at: minutesBefore(currentTask.deadline, ALARM_LEAD_MINUTES),
        title: "Time to get moving",
        body: `${configuration.stepTarget} steps by ${time}. Open BetterWakeUp and walk.`,
        opens: "walk",
      });
      reminders.push({
        id: `${currentTask.id}:last-call`,
        at: minutesBefore(currentTask.deadline, LAST_CALL_LEAD_MINUTES),
        title: `Last call - ${time}`,
        body: `${LAST_CALL_LEAD_MINUTES} minutes left to walk your ${configuration.stepTarget} steps.`,
        opens: "walk",
      });
    }
  }

  if (recoveryOffer !== null) {
    const time = formatTimeOfDay(recoveryOffer.expiresAt, configuration.timeZone);
    reminders.push({
      id: `${recoveryOffer.taskId}:recovery`,
      at: minutesBefore(recoveryOffer.expiresAt, RECOVERY_LEAD_MINUTES),
      title: "Your recovery is about to expire",
      body: `Decide before ${time} or the missed day stands.`,
      opens: "recovery",
    });
  }

  // A reminder whose moment has passed would fire immediately on some
  // platforms and be dropped on others, and neither is a nudge.
  return reminders.filter((reminder) => Date.parse(reminder.at) > now.getTime());
}

/**
 * When the next alarm would land, whatever the clock says now.
 *
 * Home names this so the user can see the promise being kept - "Reminder at
 * 6:15 AM" under the walk it is about. It deliberately ignores `now`: a screen
 * whose text appears and disappears as the deadline passes would be describing
 * the schedule rather than the setting.
 */
export function nextAlarmAt(challenge: ChallengeView): string | null {
  const { currentTask } = challenge;
  if (currentTask === null || currentTask.status !== "scheduled") {
    return null;
  }
  if (challenge.status !== "active" || challenge.pause.pausedAt !== null) {
    return null;
  }
  return minutesBefore(currentTask.deadline, ALARM_LEAD_MINUTES);
}

function minutesBefore(instant: string, minutes: number): string {
  return new Date(Date.parse(instant) - minutes * 60_000).toISOString();
}
