/**
 * What one missed morning would cost, said before it happens.
 *
 * The whole app is built on a rule the user has to plan around: missing a
 * single active day ends the challenge and forfeits the deposit, unless the
 * account still holds its one lifetime Emergency Recovery and the miss can be
 * bought back within the recovery window. The terms say so at setup, once, in a
 * list of disclosures, and nothing afterwards says it again - so the answer to
 * "what happens if I sleep through tomorrow?" was only reachable by sleeping
 * through tomorrow.
 *
 * The two facts that decide the answer are the deposit and the allowance, and
 * the allowance is an account-level fact the app is told at sign-in and cannot
 * keep true on its own. The server states it per challenge as
 * `recoveryAvailable`, which is the sweep's own rule, so this module only picks
 * the wording.
 */

import { type ChallengeView, RECOVERY_WINDOW_HOURS } from "@betterwakeup/contract";
import { formatMoney } from "./draft.ts";

export interface MissCost {
  /** What a miss would do, in the user's terms. */
  readonly text: string;
  /**
   * `warning` only where there is nothing left between the user and losing the
   * money: a safety net that still stands is a fact, not an alarm.
   */
  readonly tone: "muted" | "warning";
}

/**
 * What a miss costs this challenge, or null where saying it would be noise.
 *
 * A challenge whose recovery offer is already standing is living the answer -
 * home draws the offer and its countdown above this - and a terminal one has no
 * morning left to miss. A paused challenge has none either, unless a task whose
 * pause cutoff had passed stayed live through the pause, which is the one case
 * where a paused challenge can still lose a morning.
 */
export function missCost(challenge: ChallengeView): MissCost | null {
  if (challenge.status !== "active") {
    return null;
  }
  if (challenge.pause.pausedAt !== null && challenge.currentTask === null) {
    return null;
  }

  const staked = challenge.configuration.deposit.amount;
  if (staked === 0) {
    return {
      text: "Nothing is staked on this challenge, so a missed morning costs no money. It does end the challenge: Emergency Recovery is only offered where a deposit is at stake.",
      tone: "muted",
    };
  }

  const amount = formatMoney(staked);
  if (challenge.recoveryAvailable) {
    return {
      text: `Miss a morning and your ${amount} is not gone yet. You still hold your one lifetime Emergency Recovery, and you would have ${RECOVERY_WINDOW_HOURS} hours to spend it and keep this challenge going. You can only ever do that once.`,
      tone: "muted",
    };
  }

  return {
    text: `Your one lifetime Emergency Recovery is already spent, so there is nothing left to fall back on. Missing a single morning now ends this challenge and charges your ${amount}.`,
    tone: "warning",
  };
}
