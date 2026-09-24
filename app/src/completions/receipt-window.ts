/**
 * How long a walk saved on this phone still has to reach the server.
 *
 * A completion is only worth anything once the server has it. The rule is
 * `create-completion`'s first check: the request has to arrive by the task's
 * deadline plus a sixty second receipt grace, and after that the walk is
 * refused no matter how well it was walked. So a record sitting in the store is
 * not merely unsent - it is on a clock of its own, and that clock runs out
 * about a minute after the deadline.
 *
 * Neither surface said so. Home and the task screen both drew the morning's
 * countdown - "12 minutes left to walk" - over a walk that had already been
 * walked, which is the wrong sentence for the reader (they are not being asked
 * to walk) and the wrong deadline for the record (the grace is not in it). Past
 * the deadline both screens said the walk would still be sent and BetterWakeUp
 * would decide, which is true during the grace and misleading after it.
 *
 * This module answers the one question that state actually raises: how long has
 * this walk got, and what happens when that time is up.
 */

import { RECEIPT_GRACE_SECONDS } from "@betterwakeup/contract";
import { formatDuration, formatTimeOfDay } from "../ui/format.ts";

/**
 * How urgently the remaining time reads.
 *
 * The boundary is the last ten minutes. A walk that is walked but still unsent
 * then is in the position a morning going wrong is in - with the difference
 * that walking is no longer what fixes it, so the line turns amber while there
 * is still time to find signal.
 */
export type ReceiptUrgency = "ample" | "closing" | "gone";

export const RECEIPT_CLOSING_MINUTES = 10;

export interface ReceiptWindow {
  readonly urgency: ReceiptUrgency;
  /** Whole minutes the walk still has to arrive, never below zero. */
  readonly minutes: number;
  /** The last moment it can arrive, as a wall-clock time in the challenge's zone. */
  readonly closesAt: string;
  readonly sentence: string;
}

/**
 * The record's own countdown, or null when the deadline cannot be read - in
 * which case the screen says nothing rather than counting down to a guess.
 */
export function receiptWindow(deadline: string, timeZone: string, now: Date): ReceiptWindow | null {
  const deadlineAt = Date.parse(deadline);
  if (Number.isNaN(deadlineAt)) {
    return null;
  }
  const closes = deadlineAt + RECEIPT_GRACE_SECONDS * 1000;
  const closesAt = formatTimeOfDay(new Date(closes).toISOString(), timeZone);
  const minutes = Math.floor((closes - now.getTime()) / 60_000);
  if (minutes < 0) {
    return {
      urgency: "gone",
      minutes: 0,
      closesAt,
      sentence: `The time for this walk to reach BetterWakeUp ran out at ${closesAt}.`,
    };
  }
  return {
    urgency: minutes <= RECEIPT_CLOSING_MINUTES ? "closing" : "ample",
    minutes,
    closesAt,
    sentence: `${formatDuration(minutes)} left for this walk to reach BetterWakeUp - it stops counting at ${closesAt}.`,
  };
}

/**
 * What follows the "saved on this phone" opener once the window has closed.
 *
 * It stops short of calling the day lost - the sweep decides that, and the walk
 * is still being sent because a refusal is how the record leaves the store -
 * and it points at the offer that can still save the morning without promising
 * one, the same way the missed-deadline wording does.
 */
export function receiptGoneText(closesAt: string): string {
  return `It did not reach BetterWakeUp by ${closesAt}, so it can no longer count for today. It is still being sent, and if your Emergency Recovery is unspent the offer appears once the missed day is recorded.`;
}
