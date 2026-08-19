/**
 * How much of the morning is left.
 *
 * The task screen states the deadline as a wall-clock time - "250 steps by 7:00
 * AM" - and then says nothing more about it until a walk is already saved and
 * waiting to be sent. That leaves the two moments that decide the day unspoken.
 * Someone who opens the app at 6:52 is not told they have eight minutes, and
 * someone who opens it at 7:20 is told "Not done yet" and offered a button that
 * starts a walk the server will refuse: a completion has to reach the server by
 * the deadline, and its own reported instant has to be at or before it, so a
 * walk begun after the deadline cannot count no matter how far it goes.
 *
 * This module turns the minutes the state already carries into the reading the
 * screen needs: how long is left, whether that is worth raising the user's
 * pulse over, and the sentence for each. The wording lives here beside the rule
 * that produced it, the way the interruption wording lives beside the walk.
 *
 * Home reads the same clock from the other end - it holds the task the server
 * sent rather than the derived state - and it is the screen most people open
 * first, so the countdown and the closed morning are worded once here and drawn
 * on both.
 */

import { ALARM_LEAD_MINUTES } from "../reminders/reminders.ts";
import { formatDuration } from "../ui/format.ts";

/**
 * How urgently the remaining time reads.
 *
 * The boundary is the alarm's own lead time: the app has already decided that
 * `ALARM_LEAD_MINUTES` before the deadline is the moment a user should be up
 * and walking, so it is the same moment the countdown stops being background
 * information.
 */
export type TimeLeftUrgency = "ample" | "closing" | "expired";

export const CLOSING_MINUTES = ALARM_LEAD_MINUTES;

export interface TimeLeft {
  readonly urgency: TimeLeftUrgency;
  /** Whole minutes still to run, never below zero. */
  readonly minutes: number;
  readonly sentence: string;
}

/**
 * The countdown, from the whole minutes to the deadline that
 * `dailyCompletionState` derives. Null when there is no deadline to count to,
 * so a screen with no open task draws nothing rather than counting to zero.
 */
export function timeLeft(minutesToDeadline: number | null): TimeLeft | null {
  if (minutesToDeadline === null) {
    return null;
  }
  if (minutesToDeadline < 0) {
    return { urgency: "expired", minutes: 0, sentence: "The deadline has passed." };
  }
  return {
    urgency: minutesToDeadline <= CLOSING_MINUTES ? "closing" : "ample",
    minutes: minutesToDeadline,
    sentence: `${formatDuration(minutesToDeadline)} left to walk.`,
  };
}

/**
 * The same countdown, from the instant the server sent rather than from the
 * minutes `dailyCompletionState` derived. Home holds the task and not the
 * derived state, and the two screens must not word the same clock two ways.
 */
export function timeLeftUntil(deadline: string, now: Date): TimeLeft | null {
  const at = new Date(deadline).getTime();
  if (Number.isNaN(at)) {
    return null;
  }
  return timeLeft(Math.floor((at - now.getTime()) / 60_000));
}

/**
 * What home says in place of the step target once the morning has gone by with
 * nothing saved on the device.
 *
 * It stops short of calling the day lost - the server decides that, and the
 * sweep has not run yet - and it points at the offer that can still save it
 * without promising one, because a challenge that has already spent its
 * Emergency Recovery gets none.
 */
export function morningGoneText(deadlineTime: string): string {
  return `The ${deadlineTime} deadline passed with no walk saved, so today can no longer be kept. If your Emergency Recovery is still unspent, the offer appears here once the missed day is recorded.`;
}

/**
 * What home says when the device is holding a walk the deadline overtook.
 *
 * The waiting sentence otherwise asks the user to keep the app open where there
 * is signal, which is work with nothing left to buy: the request had to reach
 * the server by the deadline, so sending it now is the server's call and not
 * something the user can still influence.
 */
export function unsentPastDeadlineText(deadlineTime: string): string {
  return `Walked and saved on this phone, but the ${deadlineTime} deadline passed before it reached the server. It will still be sent, and BetterWakeUp decides whether it counts.`;
}

/**
 * What a user is told when the deadline went by with no walk saved.
 *
 * It names the time that passed, says plainly that nothing done now counts -
 * the screen would otherwise offer a walk that ends in a refusal - and points
 * at the one thing that can still change the day, which lives on home rather
 * than here because the offer only exists once the server has recorded the miss.
 */
export function deadlineMissedText(deadlineTime: string): string {
  return `The ${deadlineTime} deadline has passed, so a walk now cannot count for today. If you still have your Emergency Recovery, home will offer it once BetterWakeUp has recorded the missed day.`;
}

/**
 * The one thing a walker racing the clock cannot guess: it is the moment the
 * walk is saved that is judged, not the moment it started, so a window opened
 * in time and finished late is refused.
 */
export function finishByText(deadlineTime: string): string {
  return `Save it before ${deadlineTime} - a walk finished after the deadline does not count.`;
}
