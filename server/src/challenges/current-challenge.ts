/**
 * `GET /challenges/current`, the app's one read.
 *
 * "Current" means the challenge holding the account's slot: `active`, or
 * `recovery_pending`, which is a challenge that is still running and may return
 * to `active`. Every terminal challenge answers null for `challenge`, which is
 * what the contract says and what the app's empty state is built around.
 *
 * What a terminal challenge does answer is `lastEnded`: the outcome, the days
 * that were done, and what happened to the deposit. That is not the history of
 * finished challenges - it is one summary of the last one, with nothing on it
 * to act on - and the app needs it because a failure or an expiry is decided by
 * the sweep, which the app is never told about. Without it, the month a user
 * staked money on reads as an account that never held a challenge.
 */

import type { EndedChallengeSummary, GetCurrentChallengeResponse } from "@betterwakeup/contract";
import { and, count, desc, eq, inArray } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { challenges, scheduledTasks } from "../db/schema/challenges.ts";
import { loadChallengeView } from "./challenge-view.ts";

/** The challenge statuses that hold an account's one challenge slot. */
const OPEN_CHALLENGE_STATUSES = ["active", "recovery_pending"] as const;

/** The statuses from which no transition exists, which is what `lastEnded` reports on. */
const TERMINAL_CHALLENGE_STATUSES = ["succeeded", "failed", "expired"] as const;

type TerminalChallengeStatus = (typeof TERMINAL_CHALLENGE_STATUSES)[number];

export interface CurrentChallengeDependencies {
  readonly db: Database;
}

export async function getCurrentChallenge(
  deps: CurrentChallengeDependencies,
  accountId: string,
): Promise<GetCurrentChallengeResponse> {
  const [open] = await deps.db
    .select({ id: challenges.id })
    .from(challenges)
    .where(
      and(
        eq(challenges.accountId, accountId),
        inArray(challenges.status, [...OPEN_CHALLENGE_STATUSES]),
      ),
    )
    .limit(1);

  // A running challenge is the whole answer. Pairing it with an older outcome
  // would only invite the app to show two challenges at once.
  if (open !== undefined) {
    return { challenge: await loadChallengeView(deps.db, open.id), lastEnded: null };
  }

  return { challenge: null, lastEnded: await loadLastEnded(deps.db, accountId) };
}

/**
 * The account's most recent terminal challenge, or null if it has none.
 *
 * Ordered by `terminalAt` rather than by creation, because that is the instant
 * the outcome the user is being told about happened, and a challenge created
 * later can end earlier than one created before it.
 */
async function loadLastEnded(
  db: Database,
  accountId: string,
): Promise<EndedChallengeSummary | null> {
  const [ended] = await db
    .select({
      id: challenges.id,
      status: challenges.status,
      terminalAt: challenges.terminalAt,
      requiredTaskCount: challenges.requiredTaskCount,
      depositMinorUnits: challenges.depositMinorUnits,
    })
    .from(challenges)
    .where(
      and(
        eq(challenges.accountId, accountId),
        inArray(challenges.status, [...TERMINAL_CHALLENGE_STATUSES]),
      ),
    )
    .orderBy(desc(challenges.terminalAt))
    .limit(1);

  // The status and the instant agree by check constraint, so the null branch is
  // unreachable; narrowing it here is cheaper than a cast that could outlive it.
  if (ended === undefined || ended.terminalAt === null || !isTerminal(ended.status)) {
    return null;
  }

  const [completed] = await db
    .select({ value: count() })
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.challengeId, ended.id), eq(scheduledTasks.status, "completed")));

  return {
    id: ended.id,
    status: ended.status,
    endedAt: ended.terminalAt.toISOString(),
    requiredTaskCount: ended.requiredTaskCount,
    completedTaskCount: completed?.value ?? 0,
    // The column exists so a second currency is not a migration; version 1
    // prices in USD only, which is what the contract's literal says.
    deposit: { amount: ended.depositMinorUnits, currency: "USD" },
    depositOutcome: depositOutcomeOf(ended.status, ended.depositMinorUnits),
  };
}

function isTerminal(status: string): status is TerminalChallengeStatus {
  return (TERMINAL_CHALLENGE_STATUSES as readonly string[]).includes(status);
}

/**
 * What became of the deposit, stated here so the app never derives money from a
 * status. Only a failure forfeits: a challenge that succeeded, and one that
 * expired after a year of pause, both release the hold uncharged.
 */
function depositOutcomeOf(
  status: TerminalChallengeStatus,
  depositMinorUnits: number,
): EndedChallengeSummary["depositOutcome"] {
  if (depositMinorUnits === 0) return "none";
  return status === "failed" ? "charged" : "kept";
}
