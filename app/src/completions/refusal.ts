/**
 * Why the server would not take a walk, said to the person who took it.
 *
 * A refused completion is the one failure in the app the user is asked to act
 * on, and until now the screen showed them the server's own message. The
 * contract is explicit that the message is "human-readable and for developers,
 * not for display to the user", and it reads like it: a walk that finished a
 * minute late was reported as "This completion arrived after the deadline and
 * its 60 second receipt grace", and one counted outside the app as "A
 * completion must be observed while the app is open: foreground_pedometer
 * movement only".
 *
 * So the code is what the user is told about, never the message. Each refusal
 * carries two things: what happened, and whether walking again this morning
 * could still buy anything - because that is the only decision left, and the
 * two halves are not the same question. A walk short of the step target can be
 * taken again while the deadline stands; a deadline that has gone by cannot be
 * answered by any amount of walking.
 */

import { type ErrorCode, errorCode } from "@betterwakeup/contract";

export interface Refusal {
  /** What happened, in the user's terms. */
  readonly reason: string;
  /** What is left to do about it. */
  readonly nextStep: string;
  /**
   * Whether another walk today could be accepted. False whenever the day is
   * settled either way, so the screen does not invite a walk that is already
   * spent.
   */
  readonly canWalkAgain: boolean;
}

/** What the app does not know how to explain. Never the server's own words. */
const UNKNOWN: Refusal = {
  reason: "BetterWakeUp could not accept this walk, and did not say why in a way the app can read.",
  nextStep:
    "If the deadline has not passed, start another walk and save it. If it has, home shows what the day cost.",
  canWalkAgain: true,
};

/**
 * The refusals a saved walk can actually meet, worded for the morning they
 * happen on. Everything unlisted is a code this request cannot answer with, or
 * one that says nothing a user could act on, and gets the line above.
 */
const REFUSALS: Partial<Record<ErrorCode, Refusal>> = {
  deadline_passed: {
    reason: "This walk reached BetterWakeUp after the deadline, so it could not count for today.",
    nextStep:
      "Nothing sent now can change today. If your challenge has an Emergency Recovery left, it is on the home screen.",
    canWalkAgain: false,
  },
  completion_outside_task_window: {
    reason: "This walk finished outside today's window, so it could not count for today.",
    nextStep:
      "Only a walk finished on the day itself, at or before the deadline, counts. Home shows what your challenge is asking for next.",
    canWalkAgain: false,
  },
  step_target_not_met: {
    reason: "This walk came in under the step target, so it could not be counted.",
    nextStep: "Start another walk and keep going until the target is met.",
    canWalkAgain: true,
  },
  movement_provenance_rejected: {
    reason:
      "The steps in this walk were not counted by BetterWakeUp with the app open, so they could not be used.",
    nextStep: "Start another walk from this screen and leave the app open until you save it.",
    canWalkAgain: true,
  },
  task_already_resolved: {
    reason: "Today was already settled before this walk arrived, so it changed nothing.",
    nextStep: "There is nothing to do here. Home shows where the challenge stands.",
    canWalkAgain: false,
  },
  challenge_not_active: {
    reason: "Your challenge is no longer running, so walks can no longer be recorded against it.",
    nextStep: "Home says how it ended.",
    canWalkAgain: false,
  },
  not_found: {
    reason: "This day is no longer on your account, so the walk had nowhere to go.",
    nextStep: "Home shows what your challenge is asking for now.",
    canWalkAgain: false,
  },
  validation_failed: {
    reason: "This phone could not put the walk into a form BetterWakeUp accepts.",
    nextStep: "Start another walk and save it. If that is refused too, please get in touch.",
    canWalkAgain: true,
  },
  idempotency_key_reused: {
    reason: "This walk had already been sent once, so it was not counted a second time.",
    nextStep: "Check home: if today is not already done, start another walk.",
    canWalkAgain: true,
  },
  forbidden: {
    reason: "BetterWakeUp would not accept this walk for your account.",
    nextStep: "Sign out and back in from home, then start another walk if the deadline stands.",
    canWalkAgain: true,
  },
  unauthenticated: {
    reason: "Your sign-in was not accepted, so the walk could not be sent.",
    nextStep: "Sign out and back in from home, then start another walk if the deadline stands.",
    canWalkAgain: true,
  },
  session_expired: {
    reason: "Your sign-in expired before the walk could be sent.",
    nextStep: "Sign out and back in from home, then start another walk if the deadline stands.",
    canWalkAgain: true,
  },
};

/**
 * The reading for a stored refusal.
 *
 * The stored code is a plain string - the store keeps whatever the server
 * answered rather than a contract type - so an unrecognised one is expected
 * rather than exceptional, and is read as the unknown refusal.
 */
export function refusalReading(code: string | null): Refusal {
  if (code === null) {
    return UNKNOWN;
  }
  const parsed = errorCode.safeParse(code);
  if (!parsed.success) {
    return UNKNOWN;
  }
  return REFUSALS[parsed.data] ?? UNKNOWN;
}
