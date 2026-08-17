/**
 * The one writer of the ledger.
 *
 * Every movement of value in the product is a `ledger_transactions` row with
 * the entries that balance against it, and this is the only function that
 * writes either. Having one writer is what makes the sign convention checkable
 * by reading a single file rather than by auditing every caller: the deferred
 * balance trigger catches an unbalanced set at commit, but it cannot catch a
 * caller that balances a transaction the wrong way round.
 *
 * The convention, stated once:
 *
 * - **A positive amount is a debit and a negative amount is a credit**, which is
 *   the schema's rule, and the entries of one transaction sum to zero.
 * - **`user_commitment` carries what the user currently stands to forfeit.** It
 *   is opened by a debit when the deposit is authorized and closed by a credit
 *   by whichever outcome ends the challenge, so its running sum over a settled
 *   challenge is zero and over a running one is the deposit.
 * - **`payment_processor` carries value sitting at the provider.** A hold
 *   credits it; releasing that hold debits it back to zero. A capture leaves it
 *   where it is, because the money really is still at the provider until a
 *   payout that this system does not model.
 * - **`platform_revenue` carries collected forfeits** and `uncollected_forfeit`
 *   carries the ones that could not be collected, so the two together are every
 *   forfeit the product ever recorded and the second is the part it never got.
 *
 * There is deliberately no `processor_fee_charged` movement anywhere. The
 * provider interface reports a settlement's reference and amount and says
 * nothing about a fee, so writing one would mean inventing the number: the
 * account and the transaction kind exist for the processor that reports it, and
 * until one does, a fee entry would be a guess in a ledger whose whole value is
 * that it is not.
 */

import { ledgerEntries, ledgerTransactions } from "../db/schema/payments.ts";
import { AppError } from "../errors/app-error.ts";
import type { Transaction } from "../idempotency/service.ts";

type TransactionKind = (typeof ledgerTransactions.$inferInsert)["kind"];
type LedgerAccount = (typeof ledgerEntries.$inferInsert)["ledgerAccount"];

export interface LedgerEntryInput {
  readonly ledgerAccount: LedgerAccount;
  /** Minor units. Positive is a debit, negative is a credit; never zero. */
  readonly amountMinorUnits: number;
}

export interface LedgerMovement {
  readonly challengeId: string;
  readonly accountId: string | null;
  readonly kind: TransactionKind;
  readonly occurredAt: Date;
  /** The provider's own identifier for whatever it did, when it did something. */
  readonly providerReference?: string | null | undefined;
  readonly currency: string;
  readonly entries: readonly LedgerEntryInput[];
}

/** Writes the transaction and its entries. Returns the transaction's identifier. */
export async function recordLedgerMovement(
  tx: Transaction,
  movement: LedgerMovement,
): Promise<string> {
  // The database checks this at commit, one transaction at a time. Checking it
  // here as well is what names the caller that got it wrong, rather than
  // failing the whole commit with a trigger's message.
  const total = movement.entries.reduce((sum, entry) => sum + entry.amountMinorUnits, 0);
  if (movement.entries.length < 2 || total !== 0) {
    throw new AppError(
      "internal_error",
      `a ${movement.kind} ledger movement does not balance: ${total} across ${movement.entries.length} entries`,
    );
  }

  const [transaction] = await tx
    .insert(ledgerTransactions)
    .values({
      challengeId: movement.challengeId,
      accountId: movement.accountId,
      kind: movement.kind,
      occurredAt: movement.occurredAt,
      providerReference: movement.providerReference ?? null,
    })
    .returning({ id: ledgerTransactions.id });
  if (transaction === undefined) {
    throw new AppError("internal_error", "the ledger transaction insert returned no row");
  }

  await tx.insert(ledgerEntries).values(
    movement.entries.map((entry) => ({
      transactionId: transaction.id,
      ledgerAccount: entry.ledgerAccount,
      amountMinorUnits: entry.amountMinorUnits,
      currency: movement.currency,
    })),
  );
  return transaction.id;
}
