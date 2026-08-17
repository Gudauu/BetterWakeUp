/**
 * Issue 28's server half: `DELETE /sessions` ends the session that made the
 * request, and nothing else.
 *
 * The claim worth testing is not that the endpoint answers 200; it is that the
 * token stops working afterwards. Every test here therefore signs out and then
 * makes a second request with the same token, which is exactly what a stolen
 * copy of the token would do.
 */

import { and, eq, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createAuthHandlers } from "../../src/auth/handlers.ts";
import type { ProviderTokenVerifier } from "../../src/auth/provider-tokens.ts";
import { createSessionGate } from "../../src/auth/session-gate.ts";
import { hashSessionToken, mintSessionToken } from "../../src/auth/session-token.ts";
import { signOut } from "../../src/auth/sign-out.ts";
import type { Database } from "../../src/db/index.ts";
import { sessions } from "../../src/db/schema.ts";
import { createApp } from "../../src/http/app.ts";
import { createLogger } from "../../src/observability/logger.ts";
import { insertAccount } from "../support/challenge-fixtures.ts";
import { fakeRateLimiter } from "../support/fake-rate-limiter.ts";
import { useTestDatabase } from "../support/postgres.ts";

const testDatabase = useTestDatabase();

const SESSION_SECRET = "0123456789abcdef0123456789abcdef";

interface SignedIn {
  readonly accountId: string;
  readonly sessionId: string;
  readonly token: string;
}

/** A live session for a fresh account, the way sign-in leaves one. */
async function signInFixture(db: Database, accountId?: string): Promise<SignedIn> {
  const owner = accountId ?? (await insertAccount(db));
  const minted = await mintSessionToken({
    secret: SESSION_SECRET,
    accountId: owner,
    ttlSeconds: 3600,
  });
  await db.insert(sessions).values({
    id: minted.sessionId,
    accountId: owner,
    tokenHash: hashSessionToken(minted.token),
    createdAt: minted.issuedAt,
    expiresAt: minted.expiresAt,
  });
  return { accountId: owner, sessionId: minted.sessionId, token: minted.token };
}

const unreachableVerifier: ProviderTokenVerifier = {
  verify: () => {
    throw new Error("Sign-out must not verify a provider token.");
  },
};

function app(db: Database) {
  return createApp({
    logger: createLogger({ sink: () => {} }),
    rateLimiter: fakeRateLimiter(),
    sessionGate: createSessionGate({ db, sessionSecret: SESSION_SECRET }),
    handlers: createAuthHandlers({
      db,
      // Sign-out never reaches the verifier; it is here because both session
      // endpoints are mounted from one handler set, and it throws rather than
      // returning an identity so a test that did reach it would fail loudly.
      verifier: unreachableVerifier,
      sessionSecret: SESSION_SECRET,
      sessionTtlSeconds: 3600,
    }),
  });
}

function deleteSession(db: Database, token: string) {
  return app(db).request("/sessions", {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("sign-out", () => {
  it("revokes the calling session and answers with an empty body", async () => {
    const { db } = testDatabase();
    const signedIn = await signInFixture(db);

    const response = await deleteSession(db, signedIn.token);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    const [row] = await db.select().from(sessions).where(eq(sessions.id, signedIn.sessionId));
    expect(row?.revokedAt).not.toBeNull();
  });

  it("makes the same token unusable on the next request", async () => {
    const { db } = testDatabase();
    const signedIn = await signInFixture(db);

    await deleteSession(db, signedIn.token);
    const again = await deleteSession(db, signedIn.token);

    // The token itself still verifies: its signature is intact and its expiry
    // is in the future. The row is what refuses, which is the whole point of
    // storing one.
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ code: "unauthenticated" });
  });

  it("leaves the account's other sessions alone", async () => {
    const { db } = testDatabase();
    const phone = await signInFixture(db);
    const tablet = await signInFixture(db, phone.accountId);

    await deleteSession(db, phone.token);

    const live = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.accountId, phone.accountId), isNull(sessions.revokedAt)));
    expect(live).toHaveLength(1);
    const [remaining] = await db.select().from(sessions).where(eq(sessions.id, tablet.sessionId));
    expect(remaining?.revokedAt).toBeNull();
  });

  it("keeps the instant the session actually ended when the command repeats", async () => {
    const { db } = testDatabase();
    const signedIn = await signInFixture(db);
    const first = new Date("2026-03-01T08:00:00.000Z");
    const later = new Date("2026-03-01T09:00:00.000Z");

    await signOut({ db, now: () => first }, signedIn);
    await signOut({ db, now: () => later }, signedIn);

    const [row] = await db.select().from(sessions).where(eq(sessions.id, signedIn.sessionId));
    expect(row?.revokedAt).toEqual(first);
  });

  it("refuses a request with no session at all", async () => {
    const { db } = testDatabase();

    const response = await app(db).request("/sessions", { method: "DELETE" });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthenticated" });
  });
});
