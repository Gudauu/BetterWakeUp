/**
 * What ending a challenge early costs, said on the confirmation that ends it.
 *
 * Ending is a failure the user chooses, and the server settles it as one: a
 * funded deposit is charged in full, at once. That is the only action in the
 * app that charges money on a press, so the confirmation names the amount, says
 * it happens now, and says it cannot be undone, rather than leaving any of the
 * three to be inferred from the word "End".
 *
 * The Emergency Recovery is never spent by ending. Where the account still
 * holds it the text says so, because a user giving up a challenge with an offer
 * standing is exactly the user who needs to hear that the allowance is not the
 * price of leaving.
 */

import type { ChallengeView } from "@betterwakeup/contract";
import { formatMoney } from "./draft.ts";

export function endChallengeText(challenge: ChallengeView): string {
  const staked = challenge.configuration.deposit.amount;
  if (staked === 0) {
    return "Nothing is staked on this challenge, so ending it charges nothing. It cannot be undone: the challenge is over, and a new one starts from the first morning.";
  }

  const amount = formatMoney(staked);
  if (challenge.status === "recovery_pending") {
    return `Ending now gives up this recovery offer and charges your ${amount} now. Your one lifetime Emergency Recovery is not spent: it stays with your account for a future challenge. This cannot be undone.`;
  }

  const kept = challenge.recoveryAvailable
    ? " Your one lifetime Emergency Recovery is not spent and stays with your account."
    : "";
  return `Ending this challenge charges your ${amount} now, in full, the same as a missed morning.${kept} This cannot be undone.`;
}
