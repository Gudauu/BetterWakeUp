/**
 * Issue 8's acceptance boundary: the balance-to-zero trigger rejects an
 * unbalanced entry set.
 *
 * As in issue 7, every test writes through Drizzle with no service layer in
 * between, so a pass says the database carries the rule rather than that some
 * function remembered to check it. The ledger's append-only guarantee, the
 * payment command state machine, and both duplicate protections are here for
 * the same reason: nothing above them exists yet, and they have to hold for the
 * code paths that arrive in phases 3 and 4.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Database } from "../../src/db/index.ts";
import { executeRows } from "../../src/db/index.ts";
import {
  accounts,
  challenges,
  IDEMPOTENCY_LEASE_SECONDS,
  idempotencyKeys,
  ledgerEntries,
  ledgerTransactions,
  paymentCommands,
  paymentProviderEvents,
} from "../../src/db/schema.ts";
import { insertAccount, insertChallenge } from "../support/challenge-fixtures.ts";
import { useTestDatabase } from "../support/postgres.ts";
import {
  CHECK_VIOLATION,
  expectSqlState,
  INTEGRITY_CONSTRAINT_VIOLATION,
  RESTRICT_VIOLATION,
  UNIQUE_VIOLATION,
} from "../support/sql-errors.ts";

const testDatabase = useTestDatabase();

type EntrySide = {
  readonly ledgerAccount: (typeof ledgerEntries.$inferInsert)["ledgerAccount"];
  readonly amountMinorUnits: number;
  readonly currency?: string;
};

/**
 * Writes a transaction and its entries in one database transaction, which is
 * what the deferred balance trigger requires: the transaction row exists with
 * no entries under it for the length of one statement.
 */
async function insertLedgerTransaction(
  db: Database,
  where: { accountId: string; challengeId: string },
  sides: readonly EntrySide[],
  kind: (typeof ledgerTransactions.$inferInsert)["kind"] = "deposit_authorized",
): Promise<string> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(ledgerTransactions)
      .values({
        accountId: where.accountId,
        challengeId: where.challengeId,
        kind,
        providerReference: `pi_${kind}`,
      })
      .returning({ id: ledgerTransactions.id });
    if (row === undefined) {
      throw new Error("insert returned no ledger transaction");
    }
    if (sides.length > 0) {
      await tx
        .insert(ledgerEntries)
        .values(sides.map((side) => ({ transactionId: row.id, ...side })));
    }
    return row.id;
  });
}

describe("ledger balance", () => {
  it("rejects an unbalanced entry set", async () => {
    const { db } = testDatabase();
    const { accountId, challengeId } = await insertChallenge(db);

    await expectSqlState(INTEGRITY_CONSTRAINT_VIOLATION, () =>
      insertLedgerTransaction(db, { accountId, challengeId }, [
        { ledgerAccount: "user_commitment", amountMinorUnits: 2000 },
        { ledgerAccount: "payment_processor", amountMinorUnits: -1500 },
      ]),
    );
  });

  it("accepts a transaction whose debits equal its credits", async () => {
    const { db } = testDatabase();
    const { accountId, challengeId } = await insertChallenge(db);

    const transactionId = await insertLedgerTransaction(db, { accountId, challengeId }, [
      { ledgerAccount: "user_commitment", amountMinorUnits: 2000 },
      { ledgerAccount: "payment_processor", amountMinorUnits: -2000 },
    ]);

    const rows = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, transactionId));
    expect(rows).toHaveLength(2);
  });

  it("rejects a transaction with no entries", async () => {
    const { db } = testDatabase();
    const { accountId, challengeId } = await insertChallenge(db);

    // A provider reference with no movement behind it is not a record of
    // anything, and the entry-side trigger can never see it.
    await expectSqlState(INTEGRITY_CONSTRAINT_VIOLATION, () =>
      insertLedgerTransaction(db, { accountId, challengeId }, []),
    );
  });

  it("rejects two sides in different currencies", async () => {
    const { db } = testDatabase();
    const { accountId, challengeId } = await insertChallenge(db);

    // The amounts cancel if currency is ignored, which is exactly the mistake
    // grouping by currency exists to catch.
    await expectSqlState(INTEGRITY_CONSTRAINT_VIOLATION, () =>
      insertLedgerTransaction(db, { accountId, challengeId }, [
        { ledgerAccount: "user_commitment", amountMinorUnits: 2000, currency: "USD" },
        { ledgerAccount: "payment_processor", amountMinorUnits: -2000, currency: "EUR" },
      ]),
    );
  });

  it("rejects a zero entry", async () => {
    const { db } = testDatabase();
    const { accountId, challengeId } = await insertChallenge(db);

    // Without this a third zero row could stand in for a missing second side.
    await expectSqlState(CHECK_VIOLATION, () =>
      insertLedgerTransaction(db, { accountId, challengeId }, [
        { ledgerAccount: "user_commitment", amountMinorUnits: 0 },
      ]),
    );
  });

  it("holds the architecture's per-challenge balance across a full forfeit", async () => {
    const { db } = testDatabase();
    const { accountId, challengeId } = await insertChallenge(db);
    const where = { accountId, challengeId };

    await insertLedgerTransaction(
      db,
      where,
      [
        { ledgerAccount: "user_commitment", amountMinorUnits: 2000 },
        { ledgerAccount: "payment_processor", amountMinorUnits: -2000 },
      ],
      "deposit_authorized",
    );
    await insertLedgerTransaction(
      db,
      where,
      [
        { ledgerAccount: "payment_processor", amountMinorUnits: 2000 },
        { ledgerAccount: "user_commitment", amountMinorUnits: -2000 },
      ],
      "forfeit_captured",
    );
    await insertLedgerTransaction(
      db,
      where,
      [
        { ledgerAccount: "processor_fees", amountMinorUnits: 88 },
        { ledgerAccount: "platform_revenue", amountMinorUnits: -88 },
      ],
      "processor_fee_charged",
    );

    const [balance] = await db
      .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountMinorUnits}), 0)` })
      .from(ledgerEntries)
      .innerJoin(ledgerTransactions, eq(ledgerEntries.transactionId, ledgerTransactions.id))
      .where(eq(ledgerTransactions.challengeId, challengeId));

    expect(Number(balance?.total)).toBe(0);
  });
});

describe("ledger immutability", () => {
  it("refuses to update or delete an entry", async () => {
    const { db } = testDatabase();
    const { accountId, challengeId } = await insertChallenge(db);
    const transactionId = await insertLedgerTransaction(db, { accountId, challengeId }, [
      { ledgerAccount: "user_commitment", amountMinorUnits: 2000 },
      { ledgerAccount: "payment_processor", amountMinorUnits: -2000 },
    ]);

    await expectSqlState(RESTRICT_VIOLATION, () =>
      db
        .update(ledgerEntries)
        .set({ amountMinorUnits: 1 })
        .where(eq(ledgerEntries.transactionId, transactionId)),
    );
    await expectSqlState(RESTRICT_VIOLATION, () =>
      db.delete(ledgerEntries).where(eq(ledgerEntries.transactionId, transactionId)),
    );
  });

  it("refuses to change what a transaction says or to delete it", async () => {
    const { db } = testDatabase();
    const { accountId, challengeId } = await insertChallenge(db);
    const transactionId = await insertLedgerTransaction(db, { accountId, challengeId }, [
      { ledgerAccount: "user_commitment", amountMinorUnits: 2000 },
      { ledgerAccount: "payment_processor", amountMinorUnits: -2000 },
    ]);

    await expectSqlState(RESTRICT_VIOLATION, () =>
      db
        .update(ledgerTransactions)
        .set({ providerReference: "pi_rewritten" })
        .where(eq(ledgerTransactions.id, transactionId)),
    );
    await expectSqlState(RESTRICT_VIOLATION, () =>
      db.delete(ledgerTransactions).where(eq(ledgerTransactions.id, transactionId)),
    );
  });

  it("refuses to relink a transaction to a different account", async () => {
    const { db } = testDatabase();
    const { accountId, challengeId } = await insertChallenge(db);
    const otherAccountId = await insertAccount(db);
    const transactionId = await insertLedgerTransaction(db, { accountId, challengeId }, [
      { ledgerAccount: "user_commitment", amountMinorUnits: 2000 },
      { ledgerAccount: "payment_processor", amountMinorUnits: -2000 },
    ]);

    // Unlinking is permitted; moving the record onto someone else is not.
    await expectSqlState(RESTRICT_VIOLATION, () =>
      db
        .update(ledgerTransactions)
        .set({ accountId: otherAccountId })
        .where(eq(ledgerTransactions.id, transactionId)),
    );
  });

  it("keeps the financial record when the account is deleted, unlinked from the person", async () => {
    const { db } = testDatabase();
    const { accountId, challengeId } = await insertChallenge(db);
    const transactionId = await insertLedgerTransaction(db, { accountId, challengeId }, [
      { ledgerAccount: "user_commitment", amountMinorUnits: 2000 },
      { ledgerAccount: "payment_processor", amountMinorUnits: -2000 },
    ]);

    await db.delete(accounts).where(eq(accounts.id, accountId));

    const [surviving] = await db
      .select()
      .from(ledgerTransactions)
      .where(
        and(
          eq(ledgerTransactions.id, transactionId),
          isNull(ledgerTransactions.accountId),
          isNull(ledgerTransactions.challengeId),
        ),
      );
    expect(surviving?.providerReference).toBe("pi_deposit_authorized");

    const entries = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, transactionId));
    expect(entries).toHaveLength(2);
  });
});

describe("payment commands", () => {
  const command = (challengeId: string, overrides: Partial<typeof paymentCommands.$inferInsert>) =>
    ({
      challengeId,
      kind: "capture" as const,
      dedupeKey: `${challengeId}:capture`,
      ...overrides,
    }) satisfies typeof paymentCommands.$inferInsert;

  it("rejects a second command with the same dedupe key", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);

    await db.insert(paymentCommands).values(command(challengeId, {}));
    // A sweep that runs twice derives the same key and writes one command.
    await expectSqlState(UNIQUE_VIOLATION, () =>
      db.insert(paymentCommands).values(command(challengeId, { kind: "release_authorization" })),
    );
  });

  it("allows one pending command of a kind per challenge, and frees the slot when it settles", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);

    await db.insert(paymentCommands).values(command(challengeId, {}));
    await expectSqlState(UNIQUE_VIOLATION, () =>
      db.insert(paymentCommands).values(command(challengeId, { dedupeKey: `${challengeId}:2` })),
    );

    await db
      .update(paymentCommands)
      .set({ status: "failed", settledAt: new Date() })
      .where(eq(paymentCommands.challengeId, challengeId));

    // A retry is a new row with its own key, not a mutation of the attempt
    // that did not work, so the failed attempt stays readable.
    await db
      .insert(paymentCommands)
      .values(command(challengeId, { dedupeKey: `${challengeId}:2` }));
    const rows = await db
      .select()
      .from(paymentCommands)
      .where(eq(paymentCommands.challengeId, challengeId));
    expect(rows).toHaveLength(2);
  });

  it("ties every settled status to the settled instant", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);

    await expectSqlState(CHECK_VIOLATION, () =>
      db.insert(paymentCommands).values(command(challengeId, { status: "cancelled" })),
    );
    await expectSqlState(CHECK_VIOLATION, () =>
      db.insert(paymentCommands).values(command(challengeId, { settledAt: new Date() })),
    );
  });

  it("refuses to confirm a command with nothing to reconcile against", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);

    await expectSqlState(CHECK_VIOLATION, () =>
      db
        .insert(paymentCommands)
        .values(command(challengeId, { status: "confirmed", settledAt: new Date() })),
    );

    await db.insert(paymentCommands).values(
      command(challengeId, {
        status: "confirmed",
        settledAt: new Date(),
        providerReference: "pi_captured",
      }),
    );
  });

  it("rejects a negative attempt count", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);

    await expectSqlState(CHECK_VIOLATION, () =>
      db.insert(paymentCommands).values(command(challengeId, { attempts: -1 })),
    );
  });
});

describe("payment provider events", () => {
  it("rejects a redelivery of the same event", async () => {
    const { db } = testDatabase();

    const event = { provider: "fake" as const, eventId: "evt_1", type: "authorization.succeeded" };
    await db.insert(paymentProviderEvents).values({ ...event, payload: { id: "evt_1" } });

    // A provider retrying a delivery must not produce a second effect.
    await expectSqlState(UNIQUE_VIOLATION, () =>
      db.insert(paymentProviderEvents).values({ ...event, payload: { id: "evt_1" } }),
    );

    await db.insert(paymentProviderEvents).values({
      ...event,
      eventId: "evt_2",
      payload: { id: "evt_2" },
    });
  });
});

describe("idempotency keys", () => {
  const KEY = "11111111-1111-4111-8111-111111111111";

  const key = (accountId: string, overrides: Partial<typeof idempotencyKeys.$inferInsert> = {}) =>
    ({
      accountId,
      key: KEY,
      commandType: "tasks.complete",
      requestHash: "sha256:abc",
      ...overrides,
    }) satisfies typeof idempotencyKeys.$inferInsert;

  it("lets exactly one insert of a key win, which is the concurrency control", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);

    await db.insert(idempotencyKeys).values(key(accountId));
    // The loser of this insert reads the winner's row and replays or retries.
    await expectSqlState(UNIQUE_VIOLATION, () =>
      db.insert(idempotencyKeys).values(key(accountId, { requestHash: "sha256:def" })),
    );
  });

  it("scopes the key to the account, so one account cannot probe another's", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);
    const otherAccountId = await insertAccount(db);

    await db.insert(idempotencyKeys).values(key(accountId));
    await db.insert(idempotencyKeys).values(key(otherAccountId));

    const rows = await db.select().from(idempotencyKeys);
    expect(rows).toHaveLength(2);
  });

  it("leases an in_progress key for the architecture's 180 seconds", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);

    await db.insert(idempotencyKeys).values(key(accountId));

    const rows = await executeRows<{ lease_seconds: string }>(
      db,
      sql`select extract(epoch from lease_expires_at - created_at) as lease_seconds
          from idempotency_keys`,
    );
    expect(Number(rows[0]?.lease_seconds)).toBe(IDEMPOTENCY_LEASE_SECONDS);
  });

  it("refuses a completed key without both its instant and its result", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);

    await expectSqlState(CHECK_VIOLATION, () =>
      db.insert(idempotencyKeys).values(key(accountId, { status: "completed" })),
    );
    await expectSqlState(CHECK_VIOLATION, () =>
      db
        .insert(idempotencyKeys)
        .values(key(accountId, { status: "completed", completedAt: new Date() })),
    );
    // A result stored on a key that never completed would be replayed by a
    // reader that trusts the status, so the rule runs both ways.
    await expectSqlState(CHECK_VIOLATION, () =>
      db.insert(idempotencyKeys).values(key(accountId, { result: { ok: true } })),
    );

    await db.insert(idempotencyKeys).values(
      key(accountId, {
        status: "completed",
        completedAt: new Date(),
        result: { ok: true },
      }),
    );
  });

  it("goes away with the account, unlike the ledger", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);
    await db.insert(idempotencyKeys).values(key(accountId));

    await db.delete(accounts).where(eq(accounts.id, accountId));

    expect(await db.select().from(idempotencyKeys)).toHaveLength(0);
  });
});

describe("payment commands follow their challenge", () => {
  it("is removed when the challenge is deleted", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);
    await db
      .insert(paymentCommands)
      .values({ challengeId, kind: "authorize", dedupeKey: `${challengeId}:authorize` });

    await db.delete(challenges).where(eq(challenges.id, challengeId));

    expect(await db.select().from(paymentCommands)).toHaveLength(0);
  });
});
