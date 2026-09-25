/**
 * Deleting an ended challenge, against real rows and through the mounted route.
 *
 * Deleting hides a challenge from its owner and removes nothing, so most of
 * these assert on what did not change as much as on what did: the rows, the
 * money, and the Emergency Recovery.
 */

import { IDEMPOTENCY_HEADER } from "@betterwakeup/contract";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { deleteAccount } from "../../src/accounts/delete-account.ts";
import { createSessionGate } from "../../src/auth/session-gate.ts";
import { hashSessionToken, mintSessionToken } from "../../src/auth/session-token.ts";
import { createChallengeHandlers } from "../../src/challenges/handlers.ts";
import type { Database } from "../../src/db/index.ts";
import {
  accounts,
  challenges,
  paymentCommands,
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
const DELETED_AT = new Date("2026-02-01T00:00:00Z");

const KEY = {
  first: "de1e0000-0000-4000-8000-000000000001",
  second: "de1e0000-0000-4000-8000-000000000002",
};

function app(db: Database, at: Date) {
  return createApp({
    logger: createLogger({ sink: () => {} }),
    sessionGate: createSessionGate({ db, sessionSecret: SESSION_SECRET }),
    rateLimiter: fakeRateLimiter(),
    handlers: createChallengeHandlers({ db, now: () => at }),
  });
}

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

async function remove(
  db: Database,
  token: string,
  challengeId: string,
  at = DELETED_AT,
  key = KEY.first,
) {
  const response = await app(db, at).request(`http://api.test/challenges/${challengeId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}`, [IDEMPOTENCY_HEADER]: key },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function current(db: Database, token: string) {
  const response = await app(db, DELETED_AT).request("http://api.test/challenges/current", {
    headers: { authorization: `Bearer ${token}` },
  });
  return (await response.json()) as { challenge: unknown; lastEnded: { id: string } | null };
}

async function challengeRow(db: Database, challengeId: string) {
  const [row] = await db.select().from(challenges).where(eq(challenges.id, challengeId));
  return row;
}

describe("deleting an ended challenge", () => {
  it("marks each ended status deleted and keeps every row", async () => {
    const { db } = testDatabase();
    for (const status of ["failed", "succeeded", "expired", "abandoned"] as const) {
      const { accountId, token } = await signIn(db);
      const challengeId = await insertChallengeForAccount(db, accountId, { status });

      const response = await remove(db, token, challengeId);

      expect(response).toEqual({ status: 200, body: {} });
      expect(await challengeRow(db, challengeId)).toMatchObject({ status, deletedAt: DELETED_AT });
      const tasks = await db
        .select({ id: scheduledTasks.id })
        .from(scheduledTasks)
        .where(eq(scheduledTasks.challengeId, challengeId));
      expect(tasks).toHaveLength(3);
    }
  });

  it("succeeds again under a fresh key and keeps the first deletion instant", async () => {
    const { db } = testDatabase();
    const { accountId, token } = await signIn(db);
    const challengeId = await insertChallengeForAccount(db, accountId, { status: "failed" });
    await remove(db, token, challengeId);

    const again = await remove(
      db,
      token,
      challengeId,
      new Date("2026-03-01T00:00:00Z"),
      KEY.second,
    );

    expect(again.status).toBe(200);
    expect((await challengeRow(db, challengeId))?.deletedAt).toEqual(DELETED_AT);
  });

  it("replays the first answer under the same key", async () => {
    const { db } = testDatabase();
    const { accountId, token } = await signIn(db);
    const challengeId = await insertChallengeForAccount(db, accountId, { status: "failed" });

    const first = await remove(db, token, challengeId);
    const replay = await remove(db, token, challengeId, new Date("2026-03-01T00:00:00Z"));

    expect(replay).toEqual(first);
    expect((await challengeRow(db, challengeId))?.deletedAt).toEqual(DELETED_AT);
  });
});

describe("what deleting refuses", () => {
  it("refuses a challenge that still holds the account's slot, and changes nothing", async () => {
    const { db } = testDatabase();
    for (const status of ["active", "recovery_pending"] as const) {
      const { accountId, token } = await signIn(db);
      const challengeId = await insertChallengeForAccount(db, accountId, { status });

      const response = await remove(db, token, challengeId);

      expect(response).toMatchObject({ status: 409, body: { code: "challenge_not_ended" } });
      expect(await challengeRow(db, challengeId)).toMatchObject({ status, deletedAt: null });
    }
  });

  it("answers another account's challenge with not found", async () => {
    const { db } = testDatabase();
    const owner = await signIn(db);
    const challengeId = await insertChallengeForAccount(db, owner.accountId, { status: "failed" });
    const stranger = await signIn(db);

    const response = await remove(db, stranger.token, challengeId);

    expect(response).toMatchObject({ status: 404, body: { code: "not_found" } });
    expect((await challengeRow(db, challengeId))?.deletedAt).toBeNull();
  });
});

describe("what deleting leaves alone", () => {
  it("leaves a capture still being collected pending", async () => {
    const { db } = testDatabase();
    const { accountId, token } = await signIn(db);
    const challengeId = await insertChallengeForAccount(db, accountId, { status: "failed" });
    await db.insert(paymentCommands).values({
      challengeId,
      kind: "capture",
      dedupeKey: `capture:abandon:${challengeId}`,
      executeAfter: DELETED_AT,
      attempts: 2,
    });

    await remove(db, token, challengeId);

    const [capture] = await db
      .select({ status: paymentCommands.status, attempts: paymentCommands.attempts })
      .from(paymentCommands)
      .where(
        and(eq(paymentCommands.challengeId, challengeId), eq(paymentCommands.kind, "capture")),
      );
    expect(capture).toEqual({ status: "pending", attempts: 2 });
  });

  it("leaves the Emergency Recovery as it was", async () => {
    const { db } = testDatabase();
    const { accountId, token } = await signIn(db);
    const challengeId = await insertChallengeForAccount(db, accountId, { status: "failed" });

    await remove(db, token, challengeId);

    const [account] = await db
      .select({ consumedAt: accounts.emergencyRecoveryConsumedAt })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    expect(account?.consumedAt).toBeNull();
  });
});

describe("the last ended challenge", () => {
  it("is no longer reported once deleted, and an older one is not brought back", async () => {
    const { db } = testDatabase();
    const { accountId, token } = await signIn(db);
    await insertChallengeForAccount(db, accountId, {
      status: "succeeded",
      terminalAt: new Date("2026-01-05T16:00:00Z"),
    });
    const latest = await insertChallengeForAccount(db, accountId, {
      status: "failed",
      terminalAt: new Date("2026-01-20T16:00:00Z"),
    });
    expect((await current(db, token)).lastEnded?.id).toBe(latest);

    await remove(db, token, latest);

    expect(await current(db, token)).toEqual({ challenge: null, lastEnded: null });
  });

  it("reports a challenge that ends after the deletion", async () => {
    const { db } = testDatabase();
    const { accountId, token } = await signIn(db);
    const deleted = await insertChallengeForAccount(db, accountId, {
      status: "failed",
      terminalAt: new Date("2026-01-05T16:00:00Z"),
    });
    await remove(db, token, deleted);
    const later = await insertChallengeForAccount(db, accountId, {
      status: "abandoned",
      terminalAt: new Date("2026-02-10T16:00:00Z"),
    });

    expect((await current(db, token)).lastEnded).toMatchObject({
      id: later,
      status: "abandoned",
      depositOutcome: "charged",
    });
  });
});

describe("deleting the account", () => {
  it("removes a deleted challenge with everything else", async () => {
    const { db } = testDatabase();
    const { accountId, token } = await signIn(db);
    const challengeId = await insertChallengeForAccount(db, accountId, {
      status: "succeeded",
      depositMinorUnits: 0,
    });
    await remove(db, token, challengeId);

    await deleteAccount({ db }, accountId);

    expect(await challengeRow(db, challengeId)).toBeUndefined();
  });
});
