/**
 * Issue 6's acceptance boundary: the identity schema's uniqueness rules hold in
 * the database, not in application code.
 *
 * Everything here writes through Drizzle directly with no service layer in
 * between, so a passing test says the constraint exists rather than that some
 * function remembered to check.
 */

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { Database } from "../../src/db/index.ts";
import { accounts, providerIdentities, sessions } from "../../src/db/schema.ts";
import { useTestDatabase } from "../support/postgres.ts";
import { CHECK_VIOLATION, expectSqlState, UNIQUE_VIOLATION } from "../support/sql-errors.ts";

const testDatabase = useTestDatabase();

const APPLE_ISSUER = "https://appleid.apple.com";
const GOOGLE_ISSUER = "https://accounts.google.com";

async function insertAccount(db: Database, displayName?: string): Promise<string> {
  const [row] = await db
    .insert(accounts)
    .values(displayName === undefined ? {} : { displayName })
    .returning({ id: accounts.id });
  if (row === undefined) {
    throw new Error("insert returned no account");
  }
  return row.id;
}

function hourFromNow(): Date {
  return new Date(Date.now() + 60 * 60 * 1000);
}

describe("identity schema", () => {
  it("maps two providers to distinct accounts", async () => {
    const { db } = testDatabase();
    const appleAccount = await insertAccount(db, "Apple person");
    const googleAccount = await insertAccount(db, "Google person");

    await db.insert(providerIdentities).values([
      {
        accountId: appleAccount,
        provider: "apple",
        issuer: APPLE_ISSUER,
        // Deliberately the same `sub` string under two issuers: a provider's
        // subject is only unique within the issuer that minted it.
        subject: "shared-subject",
      },
      {
        accountId: googleAccount,
        provider: "google",
        issuer: GOOGLE_ISSUER,
        subject: "shared-subject",
      },
    ]);

    const rows = await db
      .select({ accountId: providerIdentities.accountId, issuer: providerIdentities.issuer })
      .from(providerIdentities)
      .orderBy(providerIdentities.issuer);
    expect(rows).toEqual([
      { accountId: googleAccount, issuer: GOOGLE_ISSUER },
      { accountId: appleAccount, issuer: APPLE_ISSUER },
    ]);
  });

  it("rejects the same provider identity twice", async () => {
    const { db } = testDatabase();
    const first = await insertAccount(db);
    const second = await insertAccount(db);
    const identity = { provider: "google", issuer: GOOGLE_ISSUER, subject: "sub-1" } as const;

    await db.insert(providerIdentities).values({ accountId: first, ...identity });

    // A second account claiming the same external identity is exactly the
    // duplicate-account bug this key exists to prevent.
    await expectSqlState(UNIQUE_VIOLATION, () =>
      db.insert(providerIdentities).values({ accountId: second, ...identity }),
    );
    // And the same account re-inserting it is the same violation.
    await expectSqlState(UNIQUE_VIOLATION, () =>
      db.insert(providerIdentities).values({ accountId: first, ...identity }),
    );
  });

  it("rejects a second identity for one provider on one account", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);

    await db
      .insert(providerIdentities)
      .values({ accountId, provider: "apple", issuer: APPLE_ISSUER, subject: "sub-a" });

    await expectSqlState(UNIQUE_VIOLATION, () =>
      db
        .insert(providerIdentities)
        .values({ accountId, provider: "apple", issuer: APPLE_ISSUER, subject: "sub-b" }),
    );
  });

  it("treats email as a display attribute rather than a key", async () => {
    const { db } = testDatabase();
    const first = await insertAccount(db);
    const second = await insertAccount(db);
    // Apple's private relay can hand the same-looking address to code that
    // wrongly deduplicates on it, so the schema must not.
    const email = "relay@privaterelay.appleid.com";

    await db.insert(providerIdentities).values([
      { accountId: first, provider: "apple", issuer: APPLE_ISSUER, subject: "sub-1", email },
      { accountId: second, provider: "google", issuer: GOOGLE_ISSUER, subject: "sub-2", email },
    ]);

    const rows = await db.select({ email: providerIdentities.email }).from(providerIdentities);
    expect(rows).toEqual([{ email }, { email }]);
  });

  it("leaves Emergency Recovery unspent on a new account", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);

    const [row] = await db
      .select({ consumedAt: accounts.emergencyRecoveryConsumedAt })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    expect(row?.consumedAt).toBeNull();
  });

  describe("sessions", () => {
    it("rejects a duplicate token hash", async () => {
      const { db } = testDatabase();
      const first = await insertAccount(db);
      const second = await insertAccount(db);
      const tokenHash = "0f".repeat(32);

      await db.insert(sessions).values({ accountId: first, tokenHash, expiresAt: hourFromNow() });

      await expectSqlState(UNIQUE_VIOLATION, () =>
        db.insert(sessions).values({ accountId: second, tokenHash, expiresAt: hourFromNow() }),
      );
    });

    it("rejects a session that expires before it was created", async () => {
      const { db } = testDatabase();
      const accountId = await insertAccount(db);

      await expectSqlState(CHECK_VIOLATION, () =>
        db.insert(sessions).values({
          accountId,
          tokenHash: "already-expired",
          expiresAt: new Date(Date.now() - 1000),
        }),
      );
    });

    it("removes identities and sessions with the account", async () => {
      const { db } = testDatabase();
      const accountId = await insertAccount(db);
      await db
        .insert(providerIdentities)
        .values({ accountId, provider: "google", issuer: GOOGLE_ISSUER, subject: "sub-1" });
      await db
        .insert(sessions)
        .values({ accountId, tokenHash: "live-session", expiresAt: hourFromNow() });

      await db.delete(accounts).where(eq(accounts.id, accountId));

      expect(await db.select().from(providerIdentities)).toEqual([]);
      expect(await db.select().from(sessions)).toEqual([]);
    });
  });
});
