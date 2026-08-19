/**
 * How a walk in progress reads to the person taking it.
 *
 * The capture is written for evidence: it counts steps while the app is in
 * front of the user and closes the window the instant that stops being true.
 * That rule is right and it is also the one thing most likely to surprise
 * someone who has just got out of bed - a locked screen or a glance at a
 * message ends the walk, and the capture answers that with a `stopped` state
 * that looks exactly like the one a finished walk produces.
 *
 * This module turns the capture's state into the two facts the screen needs
 * and neither of which the capture states outright: whether the target has
 * already been reached, and whether the walk ended without the user asking it
 * to. A walk that ended on its own is the difference between "start moving"
 * appearing as a fresh invitation and appearing as an explanation.
 */

import type { CaptureState, StopReason } from "./capture.ts";

/** The two ways a walk ends without the user pressing stop. */
export type WalkInterruption = Exclude<StopReason, "requested">;

export interface WalkProgress {
  /** A window is open and steps are being counted right now. */
  readonly recording: boolean;
  /** Steps counted in the open window; zero when none is open. */
  readonly steps: number;
  readonly target: number;
  /** Steps still owed, never below zero. */
  readonly remaining: number;
  /** The open window has already earned the day; only the press is missing. */
  readonly reachedTarget: boolean;
  /**
   * The last window ended on its own, with the steps it took with it. Null
   * while recording, before the first walk, and after a walk the user stopped.
   */
  readonly interruption: { readonly reason: WalkInterruption; readonly steps: number } | null;
}

export function walkProgress(state: CaptureState, target: number): WalkProgress {
  if (state.status === "recording") {
    return {
      recording: true,
      steps: state.steps,
      target,
      remaining: Math.max(0, target - state.steps),
      // A zero target would otherwise be reached before a single step, which
      // would celebrate a walk nobody took.
      reachedTarget: target > 0 && state.steps >= target,
      interruption: null,
    };
  }

  const idle = {
    recording: false,
    steps: 0,
    target,
    remaining: target,
    reachedTarget: false,
  } as const;

  if (state.status === "stopped" && state.reason !== "requested") {
    return {
      ...idle,
      // A revoked permission discards its observation, so the steps it counted
      // are unknown rather than zero; zero is what the screen can honestly say.
      interruption: { reason: state.reason, steps: state.observation?.steps ?? 0 },
    };
  }

  return { ...idle, interruption: null };
}

/**
 * What a walking user is told while the window is open.
 *
 * The rule they cannot guess is that leaving the app ends the walk. Said on its
 * own that reads as an instruction to keep touching the phone, which is why the
 * sentence leads with the promise the app now keeps: the screen is held awake
 * for as long as the window is open, so the walk survives a pocket, and the one
 * thing left to avoid is switching to something else.
 */
export function walkingHintText(remaining: number): string {
  return `${remaining} to go. The screen stays on while you walk - leave the app, though, and the walk ends.`;
}

/**
 * What a user is told about a walk that ended on its own.
 *
 * Every wording names the same three things in the same order: what ended it,
 * what happened to the steps, and what to do now. The lost count is stated
 * because a walk that vanished without a number reads as a bug in the app
 * rather than as the rule it is.
 */
export function interruptionText(interruption: {
  reason: WalkInterruption;
  steps: number;
}): string {
  if (interruption.reason === "permission-revoked") {
    return "Motion access was turned off during the walk, so nothing could be counted. Turn it back on in Settings, then start again.";
  }
  if (interruption.steps === 0) {
    return "The walk ended because the app left the screen, and nothing was counted. Start again and keep this screen open until you press stop.";
  }
  return `The walk ended because the app left the screen, so the ${interruption.steps} steps it had counted were not saved. Start again and keep this screen open until you press stop.`;
}
