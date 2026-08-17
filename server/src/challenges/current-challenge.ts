/**
 * `GET /challenges/current`, the app's one read.
 *
 * "Current" means the challenge holding the account's slot: `active`, or
 * `recovery_pending`, which is a challenge that is still running and may return
 * to `active`. Every terminal challenge answers null, which is what the
 * contract says and what the app's empty state is built around. The history of
 * finished challenges is not this endpoint's job, and returning the last one
 * would make the app guess whether it is looking at something it can act on.
 */

import type { GetCurrentChallengeResponse } from "@betterwakeup/contract";
import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { challenges } from "../db/schema/challenges.ts";
import { loadChallengeView } from "./challenge-view.ts";

/** The challenge statuses that hold an account's one challenge slot. */
const OPEN_CHALLENGE_STATUSES = ["active", "recovery_pending"] as const;

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

  if (open === undefined) return { challenge: null };
  return { challenge: await loadChallengeView(deps.db, open.id) };
}
