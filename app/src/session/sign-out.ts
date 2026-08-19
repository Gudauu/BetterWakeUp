/**
 * What signing out costs, said before the press takes effect.
 *
 * Signing out of this app is not the harmless press it is in most: the
 * challenge is the server's and carries on without the phone, its deadlines
 * keep counting, and only a walk taken in the app can meet one - while the
 * wake-up reminders that would have got the user out of bed come off the device
 * the moment the session ends. So the quietest control on home is the one that
 * can cost a deposit, and it had no confirmation at all.
 *
 * The consequence is assembled here rather than written into the screen because
 * it depends on facts the screen already holds and would otherwise word twice:
 * whether a challenge is running, whether it is paused, how much is staked, and
 * whether this phone is still holding a walk nobody has received.
 *
 * Answering null is the other half of the job: an account with nothing running
 * and nothing held loses nothing by signing out, and a confirmation over a
 * press with no consequence teaches the user to confirm without reading.
 */

import type { ChallengeView } from "@betterwakeup/contract";
import { formatMoney } from "../challenges/draft.ts";

export interface SignOutCostInput {
  /**
   * The challenge home is showing, or null for an account running none.
   * `unknown` is the third answer - see `challengeUnknown`.
   */
  readonly challenge: ChallengeView | null;
  /**
   * Walks written on this phone that nobody has received yet. They survive a
   * sign-out (nothing clears the store), but they cannot be sent without a
   * session, so the wait becomes open-ended rather than a matter of signal.
   */
  readonly heldWalks: number;
  /**
   * True where the challenge could not be read at all, which is the error
   * screen. Signing out from there is the same press with the same cost, and
   * the app cannot rule out a running challenge, so it says so as a condition
   * rather than staying silent.
   */
  readonly challengeUnknown?: boolean;
}

/** The wake-up alarms stop, which is the one consequence that is always news. */
const REMINDERS = "The wake-up reminders on this phone will be turned off until you sign back in.";

const RUNNING_TAIL =
  "Its deadlines still count while you are signed out, and only a walk taken in the app can meet one.";

/**
 * What signing out would do, in the user's terms, or null where it does
 * nothing worth stopping for.
 */
export function signOutConsequence(input: SignOutCostInput): string | null {
  const parts: string[] = [];
  const challenge = input.challenge;

  if (input.challengeUnknown === true) {
    parts.push(
      `Your challenge could not be read just now. If one is running, it carries on without you. ${RUNNING_TAIL}`,
      REMINDERS,
    );
  } else if (challenge !== null && challenge.pause.pausedAt !== null) {
    // A pause is the one running state where the deadlines are not the worry:
    // what is worth saying is that nothing restarts it but this app.
    parts.push(
      "Your challenge stays paused while you are signed out, and a pause never resumes on its own - only you can resume it, in this app.",
      REMINDERS,
    );
  } else if (challenge !== null) {
    const staked = challenge.configuration.deposit.amount;
    const money =
      staked === 0
        ? "Your challenge keeps running without you."
        : `Your challenge keeps running without you, with ${formatMoney(staked)} still on the line.`;
    parts.push(`${money} ${RUNNING_TAIL}`, REMINDERS);
  }

  const held = heldWalksOnSignOut(input.heldWalks);
  if (held !== null) {
    parts.push(held);
  }

  return parts.length === 0 ? null : parts.join(" ");
}

/**
 * The walks this phone is holding, worded for a sign-out.
 *
 * `heldWalksText` promises they send themselves as soon as the app can reach
 * the server, which stops being true the moment there is no session to send
 * them with - so the reassurance has to name the condition instead.
 */
function heldWalksOnSignOut(waiting: number): string | null {
  if (waiting <= 0) {
    return null;
  }
  return waiting === 1
    ? "A walk you saved is still on this phone and has not been sent yet; it stays here, and goes the moment you sign back in to this account."
    : `${waiting} walks you saved are still on this phone and have not been sent yet; they stay here, and go the moment you sign back in to this account.`;
}

/** The press that actually signs out, once the consequence has been read. */
export const SIGN_OUT_CONFIRM_LABEL = "Sign out anyway";
/** Backing out. Worded as the choice it is, not as leaving a setting alone. */
export const SIGN_OUT_CANCEL_LABEL = "Stay signed in";
