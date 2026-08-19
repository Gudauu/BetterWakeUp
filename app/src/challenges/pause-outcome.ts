/**
 * What pausing and resuming actually did, read back from the server's answer.
 *
 * Both commands answer with more than the challenge. `pauseChallenge` names the
 * first task the pause consumed, and `resumeChallenge` names the first task the
 * user faces again - and the screen threw both away, called back to home and let
 * a screen change stand for the answer. So the two facts that decide what the
 * user should do next went unsaid: which morning was given up, and, far more
 * expensively, that resuming can put a deadline back in front of somebody within
 * the hour.
 *
 * A resume is the one command in the app that starts a clock. Nothing else the
 * user presses can hand them a deadline they did not ask for, which is why the
 * countdown belongs in the answer rather than in a home screen they may or may
 * not read on the way past.
 *
 * The instants are the server's throughout. This module compares them to the
 * clock and words them; it never decides which task is live or when a pause
 * runs out.
 */

import type { ChallengeView, TaskView } from "@betterwakeup/contract";
import { type TimeLeft, timeLeftUntil } from "../completions/time-left.ts";
import { formatDay, formatDeadline } from "../ui/format.ts";
import { pausedRestSentence } from "./pause.ts";

/** What a pause did, in the order a user asks after pressing it. */
export interface PauseResult {
  /** The morning the pause consumed, or that it consumed none. */
  readonly skipped: string;
  /** That nothing runs from here, and the exception when a task stayed live. */
  readonly rest: string;
  /** Where the challenge ends as things stand, and that the date keeps moving. */
  readonly ends: string;
  /** The year that closes a pause, or null when the server named no bound. */
  readonly expires: string | null;
}

/**
 * The pause, said back.
 *
 * `nextSkippedTask` is null when every remaining cutoff had already passed,
 * which is a different thing from "the pause did nothing": the pause stands,
 * and it is the days after the live one that it holds. The sentence says that
 * rather than implying the press was wasted.
 */
export function pauseResult(input: {
  readonly challenge: ChallengeView;
  readonly nextSkippedTask: TaskView | null;
}): PauseResult {
  const { challenge, nextSkippedTask } = input;
  const zone = challenge.configuration.timeZone;
  return {
    skipped:
      nextSkippedTask === null
        ? "No morning was skipped: every morning already scheduled was past the point where it can be skipped. The pause holds the days after them."
        : `Your morning on ${formatDay(nextSkippedTask.date)} is skipped. A skipped morning is not a failure, nothing is charged for it, and it does not count toward your required total.`,
    rest: pausedRestSentence(challenge.currentTask !== null),
    ends: `As things stand your challenge ends on ${formatDay(challenge.projectedEndDate)}, and that date moves one day later for every day you stay paused.`,
    expires:
      challenge.pause.expiresAt === null
        ? null
        : `If this pause runs all the way to ${formatDeadline(challenge.pause.expiresAt, zone)}, the challenge closes as neither a success nor a failure: nothing is charged, any hold is released, and your Emergency Recovery stays untouched.`,
  };
}

/** What a resume did, with the clock it started named first. */
export interface ResumeResult {
  /** The morning that is live again, or that none is scheduled yet. */
  readonly live: string;
  /** How long is left on that deadline, or null when there is none to count. */
  readonly countdown: TimeLeft | null;
  /** Where the challenge ends now that the days are counting again. */
  readonly ends: string;
  /** That the phone will ask again. */
  readonly reminders: string;
}

/**
 * The resume, said back.
 *
 * The countdown is the point of it. A pause set on a Friday and lifted on a
 * Monday evening can hand back a deadline that is hours away, and the app used
 * to answer that press by closing the screen - so the user learned the clock was
 * running from an alarm, or from missing it.
 */
export function resumeResult(input: {
  readonly challenge: ChallengeView;
  readonly nextLiveTask: TaskView | null;
  readonly now: Date;
}): ResumeResult {
  const { challenge, nextLiveTask, now } = input;
  const zone = challenge.configuration.timeZone;
  return {
    live:
      nextLiveTask === null
        ? "No morning is live yet. The next one on your schedule becomes live on its own, and its deadline counts from then."
        : `Your next morning is ${formatDay(nextLiveTask.date)}, due by ${formatDeadline(nextLiveTask.deadline, zone)}. Its deadline counts again from now.`,
    countdown: nextLiveTask === null ? null : timeLeftUntil(nextLiveTask.deadline, now),
    ends: `Your challenge ends on ${formatDay(challenge.projectedEndDate)} if you keep every morning from here.`,
    reminders:
      "Your wake-up reminders are set again on this phone for the mornings that are counting.",
  };
}
