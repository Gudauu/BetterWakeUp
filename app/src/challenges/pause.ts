/**
 * What a pause looks like to the user, derived and nothing else.
 *
 * Pause is a mode the challenge is in, not an action applied to a day, so the
 * two things this module answers are separate questions:
 *
 * - While the challenge runs: which task would pausing skip? The product
 *   requires that task to be named before the user confirms, and a task whose
 *   pause cutoff has already passed stays live, so pausing right now would
 *   skip nothing yet. Saying "nothing yet" is the honest answer there.
 * - While the challenge is paused: is it obvious that nothing is running, and
 *   how close is the single pause to the year that closes the challenge?
 *
 * The instants are the server's. The app compares them to the clock; it never
 * computes a cutoff or an expiry itself.
 */

import { type ChallengeView, MAXIMUM_PAUSE_DAYS, type TaskView } from "@betterwakeup/contract";

const MS_PER_DAY = 86_400_000;

/**
 * How far ahead of the year the app starts saying what will happen. Thirty
 * days is long enough that a user who opens the app monthly still sees it, and
 * the sentence is informational because the outcome costs them nothing.
 */
export const PAUSE_EXPIRY_WARNING_DAYS = 30;

export interface PausePresentation {
  /** True only when the server says no pause is set. */
  readonly running: boolean;
  /** The task pausing would skip, or null when pausing would skip nothing yet. */
  readonly nextSkippedTask: TaskView | null;
  /**
   * True when there is an open task but its pause cutoff has passed, which is
   * why `nextSkippedTask` is null while a task is on screen.
   */
  readonly cutoffPassed: boolean;
  /** Whole days the current pause has lasted, or null while running. */
  readonly pausedDays: number | null;
  /** Whole days until the pause closes the challenge, or null while running. */
  readonly daysUntilExpiry: number | null;
  /** The year is close enough that the app states what will happen. */
  readonly expiryWarning: boolean;
}

export interface PausePresentationInput {
  readonly challenge: ChallengeView;
  readonly now: Date;
  readonly warnWithinDays?: number;
}

export function pausePresentation(input: PausePresentationInput): PausePresentation {
  const { challenge, now } = input;
  const warnWithin = input.warnWithinDays ?? PAUSE_EXPIRY_WARNING_DAYS;
  const { pausedAt, expiresAt } = challenge.pause;
  const running = pausedAt === null;

  if (running) {
    const task = challenge.currentTask;
    const cutoffPassed = task !== null && Date.parse(task.pauseCutoff) <= now.getTime();
    return {
      running: true,
      nextSkippedTask: cutoffPassed ? null : task,
      cutoffPassed,
      pausedDays: null,
      daysUntilExpiry: null,
      expiryWarning: false,
    };
  }

  const pausedDays = wholeDaysBetween(Date.parse(pausedAt), now.getTime());
  const daysUntilExpiry =
    expiresAt === null ? null : wholeDaysBetween(now.getTime(), Date.parse(expiresAt));

  return {
    running: false,
    // A paused challenge skips every subsequent task, so naming one would
    // suggest the pause is about a single day, which it is not.
    nextSkippedTask: null,
    cutoffPassed: false,
    pausedDays,
    daysUntilExpiry,
    expiryWarning: daysUntilExpiry !== null && daysUntilExpiry <= warnWithin,
  };
}

/** Floors toward zero on whole days, so "0 days" means "less than one". */
function wholeDaysBetween(fromMs: number, toMs: number): number {
  return Math.floor((toMs - fromMs) / MS_PER_DAY);
}

/**
 * How long the pause has lasted, as a person would say it.
 *
 * Shared by the pause screen and home so the two cannot word the same length
 * of time differently. A pause set today reads as today rather than as zero
 * days, because "Paused for 0 days" is a number nobody says.
 */
export function pausedForSentence(pausedDays: number | null): string {
  if (pausedDays === null || pausedDays <= 0) {
    return "Paused since today.";
  }
  return pausedDays === 1 ? "Paused for 1 day." : `Paused for ${pausedDays} days.`;
}

/**
 * What being paused means from here, said on the screen the user lands on.
 *
 * The single most expensive thing about a pause is that it never ends by
 * itself: no deadline arrives, no alarm sounds, and nothing on the device will
 * ever ask again. Someone who paused for a weekend and forgot has a challenge
 * that quietly stands still until the year runs out, so home says so every
 * time rather than only on the screen that set it.
 *
 * A task whose pause cutoff had already passed stays live through the pause,
 * so when one is still open the promise of "no deadline counts" would be a
 * lie and the sentence names the exception instead.
 */
export function pausedRestSentence(hasLiveTask: boolean): string {
  if (hasLiveTask) {
    return "Today's walk was already too far along to skip, so its deadline still counts. Everything after it waits until you resume - the challenge never starts again on its own.";
  }
  return "No deadline counts, no day can be failed, and no alarm will sound. The challenge never starts again on its own, so it waits here until you resume it.";
}

/**
 * The sentence shown as a pause nears its bound. It states the outcome and
 * asks for nothing, because resuming and letting the year arrive are both
 * acceptable and neither costs the user money.
 */
export function pauseExpirySentence(daysUntilExpiry: number): string {
  const when =
    daysUntilExpiry <= 0
      ? "Today"
      : daysUntilExpiry === 1
        ? "Tomorrow"
        : `In ${daysUntilExpiry} days`;
  return `${when} this pause reaches ${MAXIMUM_PAUSE_DAYS} days and the challenge closes. It counts as neither a success nor a failure, nothing is charged, any hold is released, and your Emergency Recovery stays untouched.`;
}
