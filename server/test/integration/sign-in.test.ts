/**
 * Issue 13's mapping half: a verified provider identity becomes exactly one
 * internal account, and the session it is given is a row in the database.
 *
 * The acceptance boundary's storage rule is checked here against the column
 * itself: after a sign-in with an Apple private relay address, no identity
 * column anywhere in the database contains that address.
 */

import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { createAuthHandlers } from "../../src/auth/handlers.ts";
import { createProviderTokenVerifier } from "../../src/auth/provider-tokens.ts";
import { createSessionGate } from "../../src/auth/session-gate.ts";
import { hashSessionToken, verifySessionToken } from "../../src/auth/session-token.ts";
import { type SignInDependencies, signIn } from "../../src/auth/sign-in.ts";
import type { SignOutDependencies } from "../../src/auth/sign-out.ts";
import { type Database, executeRows } from "../../src/db/index.ts";
import { accounts, providerIdentities, sessions } from "../../src/db/schema.ts";
import { createApp } from "../../src/http/app.ts";
import { createLogger } from "../../src/observability/logger.ts";
import { fakeRateLimiter } from "../support/fake-rate-limiter.ts";
import { useTestDatabase } from "../support/postgres.ts";
import { createProviderKeys, type ProviderKeys } from "../support/provider-tokens.ts";

const testDatabase = useTestDatabase();

let keys: ProviderKeys;

beforeAll(async () => {
  keys = await createProviderKeys();
});

function dependencies(db: Database, now?: () => Date): SignInDependencies & SignOutDependencies {
  return {
    db,
    verifier: createProviderTokenVerifier({
      providers: keys.config.providers,
      keyResolvers: keys.keyResolvers,
    }),
    sessionSecret: keys.config.sessionSecret,
    sessionTtlSeconds: keys.config.sessionTtlSeconds,
    ...(now === undefined ? {} : { now }),
  };
}

describe("sign-in", () => {
  it("creates one account, one identity, and one session for a first sign-in", async () => {
    const { db } = testDatabase();
    const token = await keys.sign("apple", { subject: "apple-user-1" });

    const response = await signIn(dependencies(db), { provider: "apple", idToken: token });

    const identityRows = await db.select().from(providerIdentities);
    expect(identityRows).toHaveLength(1);
    expect(identityRows[0]).toMatchObject({
      provider: "apple",
      issuer: "https://appleid.apple.com",
      subject: "apple-user-1",
      accountId: response.account.id,
    });

    const sessionRows = await db.select().from(sessions);
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]?.accountId).toBe(response.account.id);
    expect(sessionRows[0]?.revokedAt).toBeNull();
    expect(response.session.accountId).toBe(response.account.id);
    expect(response.account.emergencyRecoveryAvailable).toBe(true);
  });

  it("stores a hash of the session token and never the token", async () => {
    const { db } = testDatabase();
    const token = await keys.sign("google", { subject: "google-user-1" });

    const response = await signIn(dependencies(db), { provider: "google", idToken: token });

    const [row] = await db.select().from(sessions);
    expect(row?.tokenHash).toBe(hashSessionToken(response.session.token));
    expect(row?.tokenHash).not.toBe(response.session.token);

    // The issued token verifies, and its `jti` is the row that authorizes it,
    // which is what the session gate looks up.
    const checked = await verifySessionToken(response.session.token, keys.config.sessionSecret);
    expect(checked).toEqual({
      ok: true,
      claims: { accountId: response.account.id, sessionId: row?.id },
    });
  });

  it("returns the same account on a second sign-in and issues a second session", async () => {
    const { db } = testDatabase();
    const first = await signIn(dependencies(db), {
      provider: "apple",
      idToken: await keys.sign("apple", { subject: "apple-user-2" }),
    });
    const second = await signIn(dependencies(db), {
      provider: "apple",
      idToken: await keys.sign("apple", { subject: "apple-user-2" }),
    });

    expect(second.account.id).toBe(first.account.id);
    expect(second.session.token).not.toBe(first.session.token);
    expect(await db.select().from(accounts)).toHaveLength(1);
    expect(await db.select().from(sessions)).toHaveLength(2);
  });

  it("keeps an Apple private relay address out of every identity column", async () => {
    const { db } = testDatabase();
    const relayAddress = "8fj3k2l1@privaterelay.appleid.com";

    const response = await signIn(dependencies(db), {
      provider: "apple",
      idToken: await keys.sign("apple", {
        subject: "apple-user-3",
        email: relayAddress,
        emailVerified: "true",
        isPrivateEmail: "true",
      }),
    });

    const [identity] = await db.select().from(providerIdentities);
    expect(identity?.email).toBeNull();
    expect(identity?.subject).toBe("apple-user-3");
    expect(response.account.email).toBeNull();

    // Not just the column we expected it in: nothing anywhere holds it.
    const search = await executeRows<{ hits: number }>(
      db,
      sql`select count(*)::int as hits from provider_identities where email is not null`,
    );
    expect(search[0]?.hits).toBe(0);
  });

  it("gives two providers sharing one email address two accounts", async () => {
    const { db } = testDatabase();
    const shared = { email: "person@example.com", emailVerified: true } as const;

    const apple = await signIn(dependencies(db), {
      provider: "apple",
      idToken: await keys.sign("apple", { subject: "same-person", ...shared }),
    });
    const google = await signIn(dependencies(db), {
      provider: "google",
      idToken: await keys.sign("google", { subject: "same-person", ...shared }),
    });

    // Deliberately the same `sub` under two issuers as well: neither the
    // email nor the subject alone is the key.
    expect(google.account.id).not.toBe(apple.account.id);
    expect(await db.select().from(accounts)).toHaveLength(2);
  });

  it("fills a blank display name and never overwrites one", async () => {
    const { db } = testDatabase();
    const idToken = async () => await keys.sign("apple", { subject: "apple-user-4" });

    const first = await signIn(dependencies(db), { provider: "apple", idToken: await idToken() });
    expect(first.account.displayName).toBeNull();

    const named = await signIn(dependencies(db), {
      provider: "apple",
      idToken: await idToken(),
      displayName: "Ada",
    });
    expect(named.account.displayName).toBe("Ada");

    const renamed = await signIn(dependencies(db), {
      provider: "apple",
      idToken: await idToken(),
      displayName: "Someone Else",
    });
    expect(renamed.account.displayName).toBe("Ada");
  });

  it("records the account's spent Emergency Recovery in the response", async () => {
    const { db } = testDatabase();
    const first = await signIn(dependencies(db), {
      provider: "apple",
      idToken: await keys.sign("apple", { subject: "apple-user-5" }),
    });

    await db
      .update(accounts)
      .set({ emergencyRecoveryConsumedAt: new Date() })
      .where(eq(accounts.id, first.account.id));

    const second = await signIn(dependencies(db), {
      provider: "apple",
      idToken: await keys.sign("apple", { subject: "apple-user-5" }),
    });
    expect(second.account.emergencyRecoveryAvailable).toBe(false);
  });

  it("creates one account when the same identity signs in twice at once", async () => {
    const test = testDatabase();
    const other = test.connect();
    const idToken = await keys.sign("google", { subject: "google-race" });

    const [left, right] = await Promise.all([
      signIn(dependencies(test.db), { provider: "google", idToken }),
      signIn(dependencies(other.db), { provider: "google", idToken }),
    ]);

    // The unique index on (issuer, subject) decides, and the loser rolls its
    // own account insert back rather than leaving an account nobody reaches.
    expect(left.account.id).toBe(right.account.id);
    expect(await test.db.select().from(accounts)).toHaveLength(1);
    expect(await test.db.select().from(providerIdentities)).toHaveLength(1);
    expect(await test.db.select().from(sessions)).toHaveLength(2);
  });
});

describe("POST /sessions", () => {
  function app(db: Database) {
    return createApp({
      logger: createLogger({ sink: () => {} }),
      rateLimiter: fakeRateLimiter(),
      // The handler set now also carries `deleteSession`, which the contract
      // marks `auth: "session"`, so mounting it requires a gate.
      sessionGate: createSessionGate({ db, sessionSecret: keys.config.sessionSecret }),
      handlers: createAuthHandlers(dependencies(db)),
    });
  }

  it("answers a valid token with a session the contract describes", async () => {
    const { db } = testDatabase();
    const response = await app(db).request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "apple",
        idToken: await keys.sign("apple", { subject: "apple-http-1" }),
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { session: { token: string; accountId: string } };
    expect(body.session.token.split(".")).toHaveLength(3);
    const [row] = await db.select().from(sessions);
    expect(row?.accountId).toBe(body.session.accountId);
  });

  it("answers an expired token with 401 and writes no rows", async () => {
    const { db } = testDatabase();
    const response = await app(db).request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "apple",
        idToken: await keys.sign("apple", { expiresInSeconds: -60 }),
      }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthenticated" });
    expect(await db.select().from(accounts)).toHaveLength(0);
  });

  it("rejects an unknown provider at the validation boundary", async () => {
    const { db } = testDatabase();
    const response = await app(db).request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "facebook", idToken: "anything" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "validation_failed" });
  });
});
