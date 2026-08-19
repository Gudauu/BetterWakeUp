/**
 * What starting a challenge actually did, read back from the challenge the
 * server made.
 *
 * Creation is the one press in the app that commits a user to a month of
 * mornings and, on the funded path, to a hold on their card - and it was the
 * press answered with the least. The zero deposit path drew a two line
 * congratulation and called back to its caller in the same breath, so home
 * replaced it before it could be read; the funded path did the same the moment
 * the bank's confirmation landed. Either way the user learned what they had
 * agreed to by arriving back at home and reading it off the screen they started
 * from.
 *
 * The first morning is the point of it. A challenge created at bedtime is due
 * in seven hours and one created on a Saturday afternoon may not be due for two
 * days, and which of those it is decides what the user does next. The server
 * has already materialized every day, so the answer is in the response the
 * screen was holding.
 *
 * The instants and dates are the server's throughout. This module compares them
 * to the clock and words them; it never decides which morning is first or where
 * the challenge ends.
 */

import type { ChallengeView } from "@betterwakeup/contract";
import { type TimeLeft, timeLeftUntil } from "../completions/time-left.ts";
import { ALARM_LEAD_MINUTES, LAST_CALL_LEAD_MINUTES } from "../reminders/reminders.ts";
import { formatDay, formatTimeOfDay } from "../ui/format.ts";
import { formatMoney } from "./draft.ts";

/** What a created challenge came to, in the order a user asks after starting it. */
export interface CreationResult {
  /** The first morning and the time it is due, or that none is live yet. */
  readonly first: string;
  /** How long is left on that first deadline, or null when there is none to count. */
  readonly countdown: TimeLeft | null;
  /** What each of those mornings asks for. */
  readonly proof: string;
  /** How many mornings in all, and where the challenge ends. */
  readonly length: string;
  /** What is at stake, and the one thing that would take it. */
  readonly stake: string;
  /** That the phone will ask, when, and what that depends on. */
  readonly reminders: string;
}

/**
 * The challenge, said back.
 *
 * `currentTask` is null when the first scheduled morning is still ahead of the
 * day the challenge was made on, which is a different thing from "nothing was
 * scheduled": the days exist, none of them is live yet. The sentence says that
 * rather than leaving a user who has just staked money looking at a challenge
 * with no morning in it.
 */
export function creationResult(input: {
  readonly challenge: ChallengeView;
  readonly now: Date;
}): CreationResult {
  const { challenge, now } = input;
  const { configuration } = challenge;
  const zone = configuration.timeZone;
  const task = challenge.currentTask;
  const days = challenge.progress.requiredTaskCount;
  const staked = configuration.deposit.amount;

  return {
    first:
      task === null
        ? "No morning is live yet. The first one on your schedule becomes live on its own, and its deadline counts from then."
        : // The day is named beside the time rather than through
          // `formatDeadline`, which would repeat the date it has just given.
          `Your first morning is ${formatDay(task.date)}, due by ${formatTimeOfDay(task.deadline, zone)}.`,
    countdown: task === null ? null : timeLeftUntil(task.deadline, now),
    proof: `Each morning asks for ${stepsSentence(configuration.stepTarget)} walked with the app open before its deadline. Nothing counts once the deadline has passed.`,
    length:
      days === 1
        ? `That is one morning in all, so this challenge ends on ${formatDay(challenge.projectedEndDate)}.`
        : `That is ${days} mornings in all, ending ${formatDay(challenge.projectedEndDate)} if you never pause. Every day you spend paused moves that date one day later.`,
    stake:
      staked === 0
        ? "Nothing is staked on this challenge, so nothing can ever be charged for it. What you have put up is the habit."
        : `${formatMoney(staked)} is held on your card, not charged. It is taken only if this challenge ends short, and released when it ends any other way.`,
    // Stated as a condition rather than as a promise: the alarms are only ever
    // set on a phone that has allowed notifications, and home is where that is
    // asked for and reported.
    reminders: `Once notifications are allowed on this phone, it wakes you ${ALARM_LEAD_MINUTES} minutes before each deadline, with a last call ${LAST_CALL_LEAD_MINUTES} minutes before it. Home says whether they are on.`,
  };
}

function stepsSentence(stepTarget: number): string {
  return stepTarget === 1 ? "1 step" : `${stepTarget} steps`;
}
