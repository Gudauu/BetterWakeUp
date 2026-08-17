/**
 * Every promise the product makes to a user before they stake money, stated
 * once, as data.
 *
 * These statements used to live in the app, next to the screen that shows
 * them. They belong here instead, because a promise is a two-sided artifact:
 * the app displays it, the server has to behave the way it says, and the
 * version the user accepted is recorded beside their challenge forever. Moving
 * the list into the contract is what lets `server/test/policy-audit.test.ts`
 * assert each sentence against the code that has to honor it, rather than
 * against a paraphrase of it.
 *
 * Wherever a statement names a number, that number is interpolated from the
 * constant the server enforces. A promise that says "24 hours" while the sweep
 * uses some other window cannot be written here, because there is only one
 * place the figure comes from.
 */

import { z } from "zod";
import {
  DONATED_SHARE_OF_FORFEIT_PERCENT,
  MAXIMUM_CHALLENGE_DURATION_DAYS,
  MAXIMUM_PAUSE_DAYS,
  RECEIPT_GRACE_SECONDS,
  RECOVERY_WINDOW_HOURS,
} from "./primitives.ts";

/**
 * The terms version sent with a challenge and stored beside it forever.
 *
 * It names this exact list. Editing, adding, or removing an item means the
 * user of a later build accepted something different, so the version moves
 * with the list rather than with the app's own version number.
 */
export const DISCLOSURE_POLICY_VERSION = "disclosures.2";

/**
 * Every version this build knows how to interpret, newest last.
 *
 * A stored version is history and stays readable whatever it says, which is
 * why `challengeView.policyVersion` is an open string. An incoming acceptance
 * is different: it claims the user was shown a particular set of sentences, so
 * it has to name a set this build actually publishes.
 */
export const KNOWN_POLICY_VERSIONS = ["disclosures.1", DISCLOSURE_POLICY_VERSION] as const;

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
    id: "receipt-grace",
    scope: "all",
    statement: `A result that arrives up to ${RECEIPT_GRACE_SECONDS} seconds after the deadline still counts, but the walk itself must have finished at or before the deadline.`,
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
    id: "no-automatic-resume",
    scope: "all",
    statement: `A paused challenge never resumes on its own, and a single pause reaching ${MAXIMUM_PAUSE_DAYS} days ends the challenge with nothing charged.`,
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
    id: "maximum-duration",
    scope: "funded",
    statement: `A funded challenge may not be projected to end more than ${MAXIMUM_CHALLENGE_DURATION_DAYS} days after it is funded, because the hold has to be renewed for as long as it runs.`,
  },
  {
    id: "recovery-offer-window",
    scope: "funded",
    statement: `If I miss a day and still hold my one lifetime Emergency Recovery, the offer to spend it stands for ${RECOVERY_WINDOW_HOURS} hours after the miss, and letting it pass forfeits the deposit.`,
  },
  {
    id: "forfeit-becomes-revenue",
    scope: "funded",
    statement: `A forfeited deposit becomes the platform's own revenue. The platform commits to donating ${DONATED_SHARE_OF_FORFEIT_PERCENT}% of what remains after processing costs to charity, and publishes what it actually gave. I do not choose a recipient and no part of my deposit is passed to one.`,
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

/**
 * A version the user could have been shown by some build of this app.
 *
 * Pinned rather than free text so that a client which forgot to update its
 * disclosures, or invented a version string, is refused at the validation
 * boundary instead of recording a meaningless acceptance against real money.
 */
export const acceptedPolicyVersion = z.enum(KNOWN_POLICY_VERSIONS);

export type AcceptedPolicyVersion = z.infer<typeof acceptedPolicyVersion>;
