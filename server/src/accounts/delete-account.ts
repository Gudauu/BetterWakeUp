/**
 * Account deletion, which the App Store requires to be available in the app.
 *
 * Two branches, and the interesting one is the refusal. An account whose money
 * is still committed cannot be deleted: an authorization the user could still
 * forfeit, or a capture that has not settled, would otherwise be left pointing
 * at a person who no longer exists, and the user would have deleted their way
 * out of a commitment they made. The refusal carries
 * `account_has_active_funded_challenge` and a message that says which condition
 * holds, because "we cannot delete this" with no reason is what the App Store
 * review guideline exists to prevent.
 *
 * The other branch removes the person and keeps the money.
 *
 * **The retention rule.** Everything that identifies the user is deleted:
 * the account row, the provider identities behind it, every session, every
 * challenge with its schedule, tasks and completions, the idempotency keys
 * scoped to the account, and the rate limit counters keyed on it. The ledger is
 * retained and unlinked: `ledger_transactions.account_id` and `challenge_id`
 * are `ON DELETE SET NULL`, so the amounts, currencies, occurrence instants and
 * provider references survive with nothing pointing back at a person. That is
 * what a financial record has to be for tax and dispute purposes, and it is
 * also why the ledger's append-only trigger permits exactly one mutation: a
 * foreign key going to NULL.
 *
 * **Why this is not run under `runIdempotent`.** `idempotency_keys.account_id`
 * cascades from the account, so a key claimed for this command is deleted by
 * the command's own effect, and the completion step would then find no row to
 * complete and roll the deletion back. Deletion is instead idempotent by
 * nature: the session that authorized it is gone with the account, so a retry
 * is answered by the session gate rather than reaching here. The contract still
 * requires the key at the edge, which is what makes the first call's *arrival*
 * traceable; it is simply not the thing that makes the command safe to repeat.
 */

import { and, count, eq, gt, inArray } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { challenges } from "../db/schema/challenges.ts";
import { accounts } from "../db/schema/identity.ts";
import { paymentCommands } from "../db/schema/payments.ts";
import { rateLimitCounters } from "../db/schema/rate-limit.ts";
import { AppError } from "../errors/app-error.ts";

/** The challenge statuses that still hold an account's one challenge slot. */
const OPEN_CHALLENGE_STATUSES = ["active", "recovery_pending"] as const;

export interface DeleteAccountDependencies {
  readonly db: Database;
}

/**
 * Delete the account, or refuse and say why.
 *
 * The check and the deletion run in one transaction, and it opens by locking
 * the account row. That lock is the serialization point: a second deletion of
 * the same account waits for the first, and any command that funds a challenge
 * must take the same lock before it inserts, so a deposit cannot be authorized
 * against an account between this check and this delete.
 */
export async function deleteAccount(
  deps: DeleteAccountDependencies,
  accountId: string,
): Promise<Record<string, never>> {
  await deps.db.transaction(async (tx) => {
    const locked = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .for("update")
      .limit(1);
    // The session gate authenticated a session whose account row is gone. There
    // is nothing to delete and nothing the caller can do about it, so this is
    // the same answer as any other addressed thing that does not exist.
    if (locked.length === 0) {
      throw new AppError("not_found", "No account with this identifier.");
    }

    const blocker = await unsettledFunding(tx, accountId);
    if (blocker !== null) throw refusal(blocker);

    // Counters are keyed on the account identifier as a bare string with no
    // foreign key, so they are the one piece of account-identifying data that
    // no cascade reaches.
    await tx.delete(rateLimitCounters).where(eq(rateLimitCounters.subject, accountId));
    await tx.delete(accounts).where(eq(accounts.id, accountId));
  });

  return {};
}

/** Which condition blocks deletion, or null when none does. */
type FundingBlocker = "open_funded_challenge" | "pending_payment_command";

/**
 * Is any of this account's money still in play?
 *
 * Two conditions, and both are needed. An open funded challenge is money the
 * user could still forfeit. A pending payment command is money already on its
 * way somewhere: a capture created when a challenge failed is a `pending`
 * command against a challenge that is already terminal, so a check that looked
 * only at challenge status would let the user delete the account the capture
 * belongs to before the provider had acted on it.
 */
async function unsettledFunding(
  tx: Pick<Database, "select">,
  accountId: string,
): Promise<FundingBlocker | null> {
  const [funded] = await tx
    .select({ total: count() })
    .from(challenges)
    .where(
      and(
        eq(challenges.accountId, accountId),
        inArray(challenges.status, [...OPEN_CHALLENGE_STATUSES]),
        gt(challenges.depositMinorUnits, 0),
      ),
    );
  if ((funded?.total ?? 0) > 0) return "open_funded_challenge";

  const [pending] = await tx
    .select({ total: count() })
    .from(paymentCommands)
    .innerJoin(challenges, eq(challenges.id, paymentCommands.challengeId))
    .where(and(eq(challenges.accountId, accountId), eq(paymentCommands.status, "pending")));
  if ((pending?.total ?? 0) > 0) return "pending_payment_command";

  return null;
}

function refusal(blocker: FundingBlocker): AppError {
  return new AppError(
    "account_has_active_funded_challenge",
    blocker === "open_funded_challenge"
      ? "This account has a funded challenge that has not finished. Deletion is available once it succeeds, fails, or expires and its deposit is released or captured."
      : "This account has a payment still settling. Deletion is available once the payment provider has confirmed it, which is usually within a day.",
  );
}
