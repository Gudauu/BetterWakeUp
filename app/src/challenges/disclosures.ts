/**
 * What the user is told before a challenge starts, and what they have to
 * acknowledge before one can be funded.
 *
 * Every item here is a rule stated in `docs/product.md` that costs the user
 * something if they learn it later than now: the synchronization
 * responsibility under "Disclosure", the all-or-nothing forfeit, what a hold
 * is, and the length of the Emergency Recovery offer, which product.md
 * requires be disclosed before the user deposits.
 *
 * The items are data rather than screen copy so that "which disclosures
 * apply" and "have they all been acknowledged" are questions a test can ask,
 * and so that the version the user accepted names an exact set of statements.
 */

import { RECOVERY_WINDOW_HOURS } from "@betterwakeup/contract";

/**
 * The terms version sent with a challenge and stored beside it forever.
 *
 * It names this exact list. Editing, adding, or removing an item means the
 * user of a later build accepted something different, so the version moves
 * with the list rather than with the app's own version number.
 */
export const DISCLOSURE_POLICY_VERSION = "disclosures.1";

/**
 * `all` items are true of every challenge, including a zero deposit one, which
 * still ends when a task is missed. `funded` items are about money, and
 * showing them to someone staking nothing would be telling them a falsehood.
 */
export type DisclosureScope = "all" | "funded";

export interface DisclosureItem {
  readonly id: string;
  readonly scope: DisclosureScope;
  /** The one sentence the user is agreeing they have understood. */
  readonly statement: string;
}

export const DISCLOSURES: readonly DisclosureItem[] = [
  {
    id: "local-completion-insufficient",
    scope: "all",
    statement: "Walking the steps on this phone is not enough on its own to complete a day.",
  },
  {
    id: "synchronization-required",
    scope: "all",
    statement:
      "The server must receive and acknowledge the day's result before that day's deadline.",
  },
  {
    id: "connection-can-prevent-sync",
    scope: "all",
    statement: "A poor or unavailable connection can stop a result from reaching the server.",
  },
  {
    id: "closing-app-can-leave-unsynced",
    scope: "all",
    statement: "Closing the app before the result is acknowledged can leave it unsent.",
  },
  {
    id: "confirming-both-checks",
    scope: "all",
    statement: "It is my responsibility to keep the app open until both checks appear.",
  },
  {
    id: "all-or-nothing-forfeit",
    scope: "funded",
    statement:
      "Missing either check on one active day ends the challenge and forfeits the whole deposit. There is no partial forfeit.",
  },
  {
    id: "deposit-is-held",
    scope: "funded",
    statement:
      "The full deposit is held against my card for the length of the challenge, and the hold is renewed while it runs.",
  },
  {
    id: "recovery-offer-window",
    scope: "funded",
    statement: `If I miss a day and still hold my one lifetime Emergency Recovery, the offer to spend it stands for ${RECOVERY_WINDOW_HOURS} hours after the miss, and letting it pass forfeits the deposit.`,
  },
] as const;

/** The items a challenge with this deposit has to disclose. */
export function disclosuresFor(depositMinorUnits: number): readonly DisclosureItem[] {
  return depositMinorUnits > 0 ? DISCLOSURES : DISCLOSURES.filter((item) => item.scope === "all");
}

/** Which applicable items have not been acknowledged yet. */
export function outstandingDisclosures(
  depositMinorUnits: number,
  acknowledged: Iterable<string>,
): readonly DisclosureItem[] {
  const seen = new Set(acknowledged);
  return disclosuresFor(depositMinorUnits).filter((item) => !seen.has(item.id));
}
