/**
 * Why a funded challenge is holding up deletion, said in full.
 *
 * `deletionBlocker` answers the question the command has to ask - may this
 * account be deleted - and its one sentence, "it can be deleted once that
 * challenge settles", is the whole of what the screen used to say. That leaves
 * a user who wants out with no idea when settling happens, whether waiting
 * costs them anything, or what they could do about it, on the one screen in the
 * app they reached because they had already decided to leave.
 *
 * Everything needed to answer that is already on the challenge the screen
 * holds: the deposit, the pause, the recovery offer, and the projected end
 * date. This turns those into the three things worth saying - what is held,
 * when it stops being held, and what waiting costs - plus, where one exists,
 * the screen that would actually move things along.
 */

import type { ChallengeView } from "@betterwakeup/contract";
import { formatDay } from "../ui/format.ts";
import { formatMoney } from "./draft.ts";
import { deletionBlocker } from "./lifecycle-commands.ts";

/** The screen that would move the settling along, when there is one. */
export interface DeletionHoldAction {
  readonly route: "pause" | "recovery";
  readonly label: string;
}

export interface DeletionHold {
  /** What is being held, and against what. */
  readonly held: string;
  /** When it stops being held, and what has to happen first. */
  readonly settles: string;
  /** What waiting costs, which is the fear the other two sentences raise. */
  readonly cost: string;
  /** Where to go to get on with it, or null when only time settles it. */
  readonly action: DeletionHoldAction | null;
}

/**
 * Waiting is not a penalty, and the sentence above it - a deposit held on a
 * card until some unnamed later - reads like one. Only a missed morning ever
 * charges the hold, so the honest reassurance names the one thing that would.
 */
const COST =
  "Waiting costs nothing. The hold is only charged if the challenge ends on a missed morning - finishing it, or letting a pause run out, releases it uncharged.";

/**
 * The detail behind the blocker, or null when nothing is holding deletion up.
 *
 * It defers to `deletionBlocker` for whether there is anything to say at all,
 * so the sentence the screen reads and the rule the command enforces cannot
 * drift apart into a screen that explains a hold that is not there.
 */
export function deletionHold(challenge: ChallengeView | null): DeletionHold | null {
  if (challenge === null || deletionBlocker(challenge) === null) {
    return null;
  }
  const held = `Your ${formatMoney(challenge.configuration.deposit.amount)} deposit is still held against your card, and the account cannot be deleted while it is.`;

  // A recovery decision outranks everything else: the challenge is not running,
  // and nothing else about it moves until the offer is answered or lapses.
  if (challenge.status === "recovery_pending") {
    return {
      held,
      settles:
        "A recovery decision is open on this challenge. It settles as soon as you answer it, or when the offer's window closes on its own.",
      cost: COST,
      action: { route: "recovery", label: "Decide on your recovery" },
    };
  }

  // A pause is the trap: nothing settles while it stands still, and unlike
  // every other state there is no date to wait for - the challenge sits there
  // until its owner resumes it or the year runs out.
  if (challenge.pause.pausedAt !== null) {
    return {
      held,
      settles:
        "The challenge is paused, so nothing settles while it stands still: no day passes and no deadline counts. Resume it and it can finish, or leave it and the pause closes the challenge on its own after a year.",
      cost: COST,
      action: { route: "pause", label: "Resume the challenge" },
    };
  }

  return {
    held,
    settles: `Walk every morning from here and the challenge finishes on ${formatDay(challenge.projectedEndDate)}. That is when the hold is released and this account can be deleted.`,
    cost: COST,
    action: null,
  };
}
