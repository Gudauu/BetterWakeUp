/**
 * Deleting an ended challenge.
 *
 * `DELETE /challenges/:challengeId` takes the challenge out of what the owner
 * is shown, for good, and removes nothing. The row, its tasks, its payment
 * commands, and its ledger stay, because a later view of past challenges will
 * read them. What deleting writes is one instant, `deleted_at`, and what reads
 * it is `lastEnded`, which stops reporting the challenge.
 *
 * Only an ended challenge can be deleted, and that is the database's rule
 * before it is this module's: a check constraint refuses `deleted_at` on a
 * challenge that is still open. It is refused here first so the caller gets
 * `challenge_not_ended` rather than a constraint violation.
 *
 * Deleting never changes money. A challenge only reaches a terminal status in
 * the transaction that decides its deposit, by releasing the hold or by
 * creating the capture, and nothing here touches either. A capture still being
 * retried when its challenge is deleted is retried exactly as before.
 *
 * Deleting twice succeeds and keeps the first instant, which the transition
 * trigger would refuse to rewrite anyway. A lost response retried under a new
 * idempotency key is then an answer rather than an error.
 */

import type { EmptyResponse } from "@betterwakeup/contract";
import { and, eq, isNull } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { challenges } from "../db/schema/challenges.ts";
import { AppError } from "../errors/app-error.ts";
import { runIdempotent, type Transaction } from "../idempotency/service.ts";

/** The statuses that still hold the account's slot, which cannot be deleted. */
const OPEN_CHALLENGE_STATUSES: readonly string[] = ["active", "recovery_pending"];

export interface DeleteChallengeDependencies {
  readonly db: Database;
  /** The clock the deletion is recorded at. A test states the moment. */
  readonly now?: (() => Date) | undefined;
}

export interface DeleteChallengeCommand {
  readonly accountId: string;
  readonly challengeId: string;
  readonly idempotencyKey: string;
}

export async function deleteChallenge(
  deps: DeleteChallengeDependencies,
  command: DeleteChallengeCommand,
): Promise<{ response: EmptyResponse; replayed: boolean }> {
  const at = (deps.now ?? (() => new Date()))();

  const outcome = await runIdempotent(
    deps.db,
    {
      accountId: command.accountId,
      key: command.idempotencyKey,
      commandType: "deleteChallenge",
      request: { challengeId: command.challengeId },
    },
    async (tx) => await markDeleted(tx, command, at),
  );
  return { response: outcome.result, replayed: outcome.replayed };
}

async function markDeleted(
  tx: Transaction,
  command: DeleteChallengeCommand,
  at: Date,
): Promise<EmptyResponse> {
  const [challenge] = await tx
    .select({ id: challenges.id, status: challenges.status })
    .from(challenges)
    .where(and(eq(challenges.id, command.challengeId), eq(challenges.accountId, command.accountId)))
    .for("update")
    .limit(1);

  // Another account's challenge is answered the same way an unknown one is.
  if (challenge === undefined) {
    throw new AppError("not_found", "No challenge with this identifier.");
  }
  if (OPEN_CHALLENGE_STATUSES.includes(challenge.status)) {
    throw new AppError(
      "challenge_not_ended",
      `This challenge is ${challenge.status}. Only a challenge that has ended can be deleted.`,
    );
  }

  await tx
    .update(challenges)
    .set({ deletedAt: at, updatedAt: at })
    .where(and(eq(challenges.id, challenge.id), isNull(challenges.deletedAt)));

  return {};
}
