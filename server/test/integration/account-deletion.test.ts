/**
 * Issue 16 against real rows.
 *
 * Both branches, and the retention rule between them. The acceptance boundary
 * is the last section: an account with an unsettled funded challenge is refused
 * with a message that says why, and the same account is deleted once its money
 * has settled. The deletion assertions name the rows that must be gone and the
 * rows that must still be there, because "delete the account" is only a rule if
 * something says which is which.
 */

import { IDEMPOTENCY_HEADER } from "@betterwakeup/contract";
import { eq, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { deleteAccount } from "../../src/accounts/delete-account.ts";
import { createAccountHandlers } from "../../src/accounts/handlers.ts";
import { createSessionGate } from "../../src/auth/session-gate.ts";
import { hashSessionToken, mintSessionToken } from "../../src/auth/session-token.ts";
import type { Database } from "../../src/db/index.ts";
import {
  accounts,
  challenges,
  idempotencyKeys,
  ledgerEntries,
  ledgerTransactions,
  paymentCommands,
  providerIdentities,
  rateLimitCounters,
  scheduledTasks,
  sessions,
} from "../../src/db/schema.ts";
import { createApp } from "../../src/http/app.ts";
import { createLogger } from "../../src/observability/logger.ts";
import { insertAccount, insertChallengeForAccount } from "../support/challenge-fixtures.ts";
import { fakeRateLimiter } from "../support/fake-rate-limiter.ts";
import { useTestDatabase } from "../support/postgres.ts";

const testDatabase = useTestDatabase();

const SESSION_SECRET = "0123456789abcdef0123456789abcdef";
const KEY = "9d1d0f3e-3a1d-4a35-9d2a-9f6a1b2c3d40";

/** An account with a live session, the way sign-in leaves one. */
async function signIn(db: Database): Promise<{ accountId: string; token: string }> {
  const accountId = await insertAccount(db);
  const minted = await mintSessionToken({ secret: SESSION_SECRET, accountId, ttlSeconds: 3600 });
  await db.insert(sessions).values({
    id: minted.sessionId,
    accountId,
    tokenHash: hashSessionToken(minted.token),
    createdAt: minted.issuedAt,
    expiresAt: minted.expiresAt,
  });
  return { accountId, token: minted.token };
}

/** A balanced transaction, which is the only kind the ledger accepts. */
async function insertLedgerTransaction(
  db: Database,
  where: { accountId: string; challengeId: string },
): Promise<string> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(ledgerTransactions)
      .values({ ...where, kind: "deposit_authorized", providerReference: "pi_authorized" })
      .returning({ id: ledgerTransactions.id });
    if (row === undefined) throw new Error("insert returned no ledger transaction");
    await tx.insert(ledgerEntries).values([
      { transactionId: row.id, ledgerAccount: "user_commitment", amountMinorUnits: 2000 },
      { transactionId: row.id, ledgerAccount: "payment_processor", amountMinorUnits: -2000 },
    ]);
    return row.id;
  });
}

async function accountExists(db: Database, accountId: string): Promise<boolean> {
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  return rows.length === 1;
}

describe("refusing while the account's money is still committed", () => {
  it("refuses an active funded challenge and says why", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);
    await insertChallengeForAccount(db, accountId, { depositMinorUnits: 2000 });

    await expect(deleteAccount({ db }, accountId)).rejects.toMatchObject({
      code: "account_has_active_funded_challenge",
      status: 409,
      // The App Store requirement is that the flow says so, not merely that it
      // refuses, so the message is part of the behaviour under test.
      message: expect.stringContaining("funded challenge that has not finished"),
    });
    expect(await accountExists(db, accountId)).toBe(true);
  });

  it("refuses a challenge awaiting Emergency Recovery, which still holds a deposit", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);
    await insertChallengeForAccount(db, accountId, {
      status: "recovery_pending",
      depositMinorUnits: 2000,
    });

    await expect(deleteAccount({ db }, accountId)).rejects.toMatchObject({
      code: "account_has_active_funded_challenge",
    });
  });

  it("refuses a pending payment command even though its challenge already ended", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);
    const challengeId = await insertChallengeForAccount(db, accountId, {
      status: "failed",
      depositMinorUnits: 2000,
    });
    // The capture a failed challenge creates. The challenge is terminal and the
    // money has not moved yet, so challenge status alone would wave this
    // through and lose the link between the capture and the person it is from.
    await db
      .insert(paymentCommands)
      .values({ challengeId, kind: "capture", dedupeKey: `capture:${challengeId}` });

    await expect(deleteAccount({ db }, accountId)).rejects.toMatchObject({
      code: "account_has_active_funded_challenge",
      message: expect.stringContaining("payment still settling"),
    });
    expect(await accountExists(db, accountId)).toBe(true);
  });

  it("leaves the challenge intact when it refuses", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);
    const challengeId = await insertChallengeForAccount(db, accountId, { depositMinorUnits: 2000 });

    await expect(deleteAccount({ db }, accountId)).rejects.toThrow();

    const remaining = await db
      .select({ id: challenges.id })
      .from(challenges)
      .where(eq(challenges.id, challengeId));
    expect(remaining).toHaveLength(1);
  });
});

describe("deleting", () => {
  it("deletes an account that never ran a challenge", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);

    await expect(deleteAccount({ db }, accountId)).resolves.toEqual({});
    expect(await accountExists(db, accountId)).toBe(false);
  });

  it("deletes an account whose only challenge is a zero deposit one", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);
    const challengeId = await insertChallengeForAccount(db, accountId, { depositMinorUnits: 0 });

    await deleteAccount({ db }, accountId);

    expect(
      await db.select({ id: challenges.id }).from(challenges).where(eq(challenges.id, challengeId)),
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: scheduledTasks.id })
        .from(scheduledTasks)
        .where(eq(scheduledTasks.challengeId, challengeId)),
    ).toHaveLength(0);
  });

  it("deletes the provider identity, the sessions, and the idempotency keys", async () => {
    const { db } = testDatabase();
    const { accountId } = await signIn(db);
    await db.insert(providerIdentities).values({
      accountId,
      provider: "apple",
      issuer: "https://appleid.apple.com",
      subject: "000123.abc",
    });
    await db.insert(idempotencyKeys).values({
      accountId,
      key: KEY,
      commandType: "createCompletion",
      requestHash: "hash",
    });

    await deleteAccount({ db }, accountId);

    expect(
      await db
        .select({ id: providerIdentities.id })
        .from(providerIdentities)
        .where(eq(providerIdentities.accountId, accountId)),
    ).toHaveLength(0);
    expect(
      await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.accountId, accountId)),
    ).toHaveLength(0);
    expect(
      await db
        .select({ key: idempotencyKeys.key })
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.accountId, accountId)),
    ).toHaveLength(0);
  });

  it("deletes the rate limit counters, which no cascade reaches", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);
    await db.insert(rateLimitCounters).values({
      bucket: "completion",
      subject: accountId,
      windowStart: new Date("2026-01-05T00:00:00Z"),
    });

    await deleteAccount({ db }, accountId);

    expect(
      await db
        .select({ subject: rateLimitCounters.subject })
        .from(rateLimitCounters)
        .where(eq(rateLimitCounters.subject, accountId)),
    ).toHaveLength(0);
  });

  it("retains the ledger and unlinks it from the person", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);
    const challengeId = await insertChallengeForAccount(db, accountId, {
      status: "failed",
      depositMinorUnits: 2000,
    });
    const transactionId = await insertLedgerTransaction(db, { accountId, challengeId });
    await db.insert(paymentCommands).values({
      challengeId,
      kind: "capture",
      dedupeKey: `capture:${challengeId}`,
      status: "confirmed",
      settledAt: new Date("2026-01-06T00:00:00Z"),
      providerReference: "pi_captured",
    });

    await deleteAccount({ db }, accountId);

    const [retained] = await db
      .select({
        id: ledgerTransactions.id,
        accountId: ledgerTransactions.accountId,
        challengeId: ledgerTransactions.challengeId,
        providerReference: ledgerTransactions.providerReference,
      })
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.id, transactionId));
    // The financial record survives its person: the amounts and the provider
    // reference are still reconcilable, and nothing points back at anybody.
    expect(retained).toMatchObject({
      accountId: null,
      challengeId: null,
      providerReference: "pi_authorized",
    });
    expect(
      await db
        .select({ id: ledgerEntries.id })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.transactionId, transactionId)),
    ).toHaveLength(2);
    expect(
      await db
        .select({ id: ledgerTransactions.id })
        .from(ledgerTransactions)
        .where(isNull(ledgerTransactions.accountId)),
    ).toHaveLength(1);
  });

  it("answers a second deletion of the same account with not found", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);

    await deleteAccount({ db }, accountId);

    await expect(deleteAccount({ db }, accountId)).rejects.toMatchObject({ code: "not_found" });
  });

  it("serializes two simultaneous deletions on the account row", async () => {
    const test = testDatabase();
    const second = test.connect();

    const accountId = await insertAccount(test.db);
    const outcomes = await Promise.allSettled([
      deleteAccount({ db: test.db }, accountId),
      deleteAccount({ db: second.db }, accountId),
    ]);

    // Exactly one deletes. The other waits on the `for update` lock and finds
    // no row once the winner commits, which is the same answer any caller gets
    // for an account that is not there.
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const [rejected] = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "not_found" });
  });
});

describe("issue 16's acceptance boundary, through the mounted route", () => {
  function app(db: Database) {
    return createApp({
      logger: createLogger({ sink: () => {} }),
      sessionGate: createSessionGate({ db, sessionSecret: SESSION_SECRET }),
      rateLimiter: fakeRateLimiter(),
      handlers: createAccountHandlers({ db }),
    });
  }

  function request(token: string) {
    return {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, [IDEMPOTENCY_HEADER]: KEY },
    };
  }

  it("deletes the account and leaves its session unusable", async () => {
    const { db } = testDatabase();
    const { accountId, token } = await signIn(db);

    const response = await app(db).request("/accounts", request(token));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(await accountExists(db, accountId)).toBe(false);

    // The retry a client makes when it does not see the first response. The
    // session went with the account, so the gate answers before the handler.
    const again = await app(db).request("/accounts", request(token));
    expect(again.status).toBe(401);
  });

  it("refuses over HTTP with the contract's code while money is committed", async () => {
    const { db } = testDatabase();
    const { accountId, token } = await signIn(db);
    await insertChallengeForAccount(db, accountId, { depositMinorUnits: 2000 });

    const response = await app(db).request("/accounts", request(token));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "account_has_active_funded_challenge" });
    expect(await accountExists(db, accountId)).toBe(true);
  });
});
