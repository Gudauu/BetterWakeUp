/**
 * Ending a running challenge before it finishes.
 *
 * `POST /challenges/:challengeId/abandonment` is a failure its owner chose. It
 * is settled exactly the way a missed morning without a recovery is: the
 * challenge reaches a terminal status in this transaction, and a funded one
 * owes a capture of its whole deposit, due at once, which the sweep's
 * settlement pass executes. Nothing here calls the provider. The settlement
 * pass already owns retries, the uncollected record, and the reconciliation
 * that keeps a capture from happening twice, and a second caller would have to
 * copy all three.
 *
 * The status is `abandoned` rather than `failed`, so a challenge that was given
 * up stays distinguishable from one that missed a morning.
 *
 * Both statuses that hold the account's slot can be ended:
 *
 * - An `active` challenge, paused or not, gets a new capture keyed on the
 *   ending, so a capture an earlier accepted recovery cancelled does not
 *   swallow it.
 * - A `recovery_pending` challenge already owes a capture, the one the miss
 *   created and the offer is holding back until its window closes. Ending
 *   brings that capture forward to now instead of adding a second one: there is
 *   one forfeit, and the database allows one open capture per challenge.
 *
 * The Emergency Recovery is neither offered nor spent. The account row is not
 * read at all, so an allowance that was standing on this challenge's offer
 * stays with the account for a future challenge.
 *
 * Renewal needs nothing from here. It only renews the holds of challenges in a
 * status that holds the slot, so the hold stops being renewed in the same
 * transaction that ends the challenge.
 *
 * Only the challenge row is locked, and it is locked waiting rather than with
 * `skip locked`: this is one user's command, and it should queue behind a
 * completion or a recovery on the same challenge rather than give up. Every
 * other writer takes the challenge before anything this command would need, or
 * takes nothing this command holds, so waiting cannot deadlock. Whichever
 * commits first decides the outcome, and the other re-reads the status under
 * its own lock and is refused.
 */

import type { AbandonChallengeResponse } from "@betterwakeup/contract";
import { and, eq } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { challenges } from "../db/schema/challenges.ts";
import { paymentCommands } from "../db/schema/payments.ts";
import { AppError } from "../errors/app-error.ts";
import { runIdempotent, type Transaction } from "../idempotency/service.ts";
import { createSettlementCommand } from "../sweep/payment-commands.ts";
import { loadEndedSummary } from "./current-challenge.ts";

export interface AbandonChallengeDependencies {
  readonly db: Database;
  /** The clock the ending is recorded at. A test states the moment. */
  readonly now?: (() => Date) | undefined;
}

export interface AbandonChallengeCommand {
  readonly accountId: string;
  readonly challengeId: string;
  readonly idempotencyKey: string;
}

export async function abandonChallenge(
  deps: AbandonChallengeDependencies,
  command: AbandonChallengeCommand,
): Promise<{ response: AbandonChallengeResponse; replayed: boolean }> {
  const at = (deps.now ?? (() => new Date()))();

  const outcome = await runIdempotent(
    deps.db,
    {
      accountId: command.accountId,
      key: command.idempotencyKey,
      commandType: "abandonChallenge",
      request: { challengeId: command.challengeId },
    },
    async (tx) => await endChallenge(tx, command, at),
  );
  return { response: outcome.result, replayed: outcome.replayed };
}

async function endChallenge(
  tx: Transaction,
  command: AbandonChallengeCommand,
  at: Date,
): Promise<AbandonChallengeResponse> {
  const [challenge] = await tx
    .select({
      id: challenges.id,
      status: challenges.status,
      depositMinorUnits: challenges.depositMinorUnits,
    })
    .from(challenges)
    .where(and(eq(challenges.id, command.challengeId), eq(challenges.accountId, command.accountId)))
    .for("update")
    .limit(1);

  // Another account's challenge is answered the same way an unknown one is.
  if (challenge === undefined) {
    throw new AppError("not_found", "No challenge with this identifier.");
  }
  if (challenge.status !== "active" && challenge.status !== "recovery_pending") {
    throw new AppError(
      "challenge_not_active",
      `This challenge is ${challenge.status}, so it has already ended.`,
    );
  }

  await tx
    .update(challenges)
    .set({ status: "abandoned", terminalAt: at, updatedAt: at })
    .where(eq(challenges.id, challenge.id));

  // A zero deposit challenge has nothing to settle, so there is no command at
  // all rather than a command for zero.
  if (challenge.depositMinorUnits > 0) {
    if (challenge.status === "recovery_pending") {
      await bringCaptureForward(tx, challenge.id, at);
    } else {
      await createSettlementCommand(tx, {
        challengeId: challenge.id,
        kind: "capture",
        cause: { kind: "abandonment" },
        executeAfter: at,
      });
    }
  }

  return { ended: await loadEndedSummary(tx, challenge.id) };
}

/**
 * The capture the offer was holding back, now due.
 *
 * A funded challenge in `recovery_pending` always has exactly one pending
 * capture, created in the transaction that opened the offer. Once the window
 * has closed and the settlement pass has executed it, the challenge is no
 * longer `recovery_pending` and never reaches here, so finding none means the
 * two disagree, which is ours to fix and not the caller's.
 */
async function bringCaptureForward(tx: Transaction, challengeId: string, at: Date): Promise<void> {
  const moved = await tx
    .update(paymentCommands)
    .set({ executeAfter: at, updatedAt: at })
    .where(
      and(
        eq(paymentCommands.challengeId, challengeId),
        eq(paymentCommands.kind, "capture"),
        eq(paymentCommands.status, "pending"),
      ),
    )
    .returning({ id: paymentCommands.id });
  if (moved.length === 0) {
    throw new AppError("internal_error", "a recovery_pending challenge had no pending capture");
  }
}
