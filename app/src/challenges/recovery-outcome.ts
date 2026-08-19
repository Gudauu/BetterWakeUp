/**
 * What spending the Emergency Recovery actually does, before and after.
 *
 * The screen said the missed day is forgiven and the challenge continues, which
 * is true and is not the whole of it. `acceptRecovery` runs five things in one
 * transaction, and one of them is a replacement morning appended past the
 * challenge's last day, which moves the projected end date later. So the deal
 * is not "the miss is undone" but "the miss is traded for one more morning at
 * the end" - a fact the user was never told before pressing a button whose
 * whole subject is permanence.
 *
 * The other half is what the app did with the answer. The response carries the
 * forgiven task and the appended one by name, and the screen threw both away
 * and returned the user to home, so the one irreversible press in the product
 * was acknowledged by a screen change. This turns both ends into sentences: the
 * trade before the press, and what came back after it.
 */

import type { ChallengeView, TaskView } from "@betterwakeup/contract";
import { formatDay, formatDeadline } from "../ui/format.ts";

/**
 * The morning added at the end, said before the press.
 *
 * Deliberately unnamed by date: the replacement lands on the next date the
 * challenge's own weekly schedule allows past its last task, and the app would
 * be guessing at the server's schedule engine to name it. The date is stated
 * afterwards, from the server's own answer.
 */
export const RECOVERY_REPLACEMENT =
  "Your challenge does not get shorter. A replacement morning is added after your last day, so you still walk every morning you signed up for and your end date moves later.";

/**
 * The morning the offer is open about, or null when the app cannot tell.
 *
 * The offer itself carries only a task ID, so the date comes from the row of
 * days the challenge already reports. The last missed day is the one: a
 * challenge only ever reaches `recovery_pending` on its first miss, and reading
 * the last rather than the first keeps a challenge whose earlier miss was
 * forgiven (that day is `forgiven`, not `missed`) answering about this one.
 */
export function missedDay(challenge: ChallengeView): string | null {
  if (challenge.recoveryOffer === null) {
    return null;
  }
  const missed = challenge.days.filter((day) => day.status === "missed");
  const last = missed.at(-1);
  return last === undefined ? null : last.date;
}

/** What spending it buys, naming the morning when the row of days shows one. */
export function recoveryTrade(challenge: ChallengeView): string {
  const day = missedDay(challenge);
  return day === null
    ? "The missed morning is forgiven and the challenge continues from your next task."
    : `${formatDay(day)} is forgiven and the challenge continues from your next task.`;
}

/** The four things that changed, in the order the user cares about them. */
export interface RecoveryResult {
  /** The morning that no longer counts against the challenge. */
  readonly forgiven: string;
  /** The morning added at the end, with the time it is due. */
  readonly appended: string;
  /** Where the challenge now ends. */
  readonly ends: string;
  /** That the allowance is gone, said once and plainly. */
  readonly spent: string;
}

/**
 * What the server did, read back from its own answer rather than from a later
 * re-read: `GET /challenges/current` would show a running challenge again and
 * say nothing about which day was traded for which.
 */
export function recoveryResult(input: {
  readonly challenge: ChallengeView;
  readonly forgivenTask: TaskView;
  readonly appendedTask: TaskView;
}): RecoveryResult {
  const zone = input.challenge.configuration.timeZone;
  return {
    forgiven: `${formatDay(input.forgivenTask.date)} is forgiven. It no longer counts against your challenge.`,
    appended: `A morning was added on ${formatDay(input.appendedTask.date)}, due by ${formatDeadline(input.appendedTask.deadline, zone)}.`,
    ends: `Your challenge now ends on ${formatDay(input.challenge.projectedEndDate)}.`,
    spent:
      "Your Emergency Recovery is spent. There is no second one, so the next missed morning ends the challenge and charges the deposit.",
  };
}
