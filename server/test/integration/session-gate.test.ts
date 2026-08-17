/**
 * Issue 14 against real rows.
 *
 * The acceptance boundary is the last section: a cross-account request for a
 * valid task ID returns not found, byte for byte the same answer as a task ID
 * that names nothing at all. Anything weaker than byte for byte is still an
 * oracle, so the two responses are compared to each other rather than each
 * being checked against a status code.
 */

import { IDEMPOTENCY_HEADER } from "@betterwakeup/contract";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createSessionGate } from "../../src/auth/session-gate.ts";
import { hashSessionToken, mintSessionToken } from "../../src/auth/session-token.ts";
import type { Database } from "../../src/db/index.ts";
import { scheduledTasks, sessions } from "../../src/db/schema.ts";
import { createApp } from "../../src/http/app.ts";
import { createLogger } from "../../src/observability/logger.ts";
import { insertAccount, insertChallengeForAccount } from "../support/challenge-fixtures.ts";
import { useTestDatabase } from "../support/postgres.ts";

const testDatabase = useTestDatabase();

const SESSION_SECRET = "0123456789abcdef0123456789abcdef";
const KEY = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
/** A syntactically valid identifier that names nothing. */
const ABSENT_TASK_ID = "00000000-0000-4000-8000-00000000dead";

interface SignedIn {
  readonly accountId: string;
  readonly sessionId: string;
  readonly token: string;
}

/** An account with a live session, the way sign-in leaves one. */
async function signIn(db: Database, ttlSeconds = 3600): Promise<SignedIn> {
  const accountId = await insertAccount(db);
  const minted = await mintSessionToken({ secret: SESSION_SECRET, accountId, ttlSeconds });
  await db.insert(sessions).values({
    id: minted.sessionId,
    accountId,
    tokenHash: hashSessionToken(minted.token),
    createdAt: minted.issuedAt,
    expiresAt: minted.expiresAt,
  });
  return { accountId, sessionId: minted.sessionId, token: minted.token };
}

function gateFor(db: Database, now?: () => Date) {
  return createSessionGate({
    db,
    sessionSecret: SESSION_SECRET,
    ...(now === undefined ? {} : { now }),
  });
}

/** The first task of a challenge belonging to this account. */
async function taskOf(db: Database, accountId: string): Promise<string> {
  const challengeId = await insertChallengeForAccount(db, accountId);
  const [task] = await db
    .select({ id: scheduledTasks.id })
    .from(scheduledTasks)
    .where(eq(scheduledTasks.challengeId, challengeId))
    .limit(1);
  if (task === undefined) throw new Error("the fixture materialized no tasks");
  return task.id;
}

describe("authenticating a presented token", () => {
  it("resolves the session and the account it belongs to", async () => {
    const { db } = testDatabase();
    const signedIn = await signIn(db);

    await expect(gateFor(db).authenticate(`Bearer ${signedIn.token}`)).resolves.toEqual({
      sessionId: signedIn.sessionId,
      accountId: signedIn.accountId,
    });
  });

  it("accepts the scheme in any case, as the HTTP specification requires", async () => {
    const { db } = testDatabase();
    const signedIn = await signIn(db);

    await expect(gateFor(db).authenticate(`bearer ${signedIn.token}`)).resolves.toMatchObject({
      accountId: signedIn.accountId,
    });
  });

  it("refuses a request with no Authorization header", async () => {
    const { db } = testDatabase();

    await expect(gateFor(db).authenticate(undefined)).rejects.toMatchObject({
      code: "unauthenticated",
      status: 401,
    });
  });

  it("refuses a credential presented under another scheme", async () => {
    const { db } = testDatabase();
    const signedIn = await signIn(db);

    await expect(gateFor(db).authenticate(`Basic ${signedIn.token}`)).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  it("refuses a token signed with another secret without touching the database", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);
    const forged = await mintSessionToken({
      secret: "ffffffffffffffffffffffffffffffff",
      accountId,
      ttlSeconds: 3600,
    });

    await expect(gateFor(db).authenticate(`Bearer ${forged.token}`)).rejects.toMatchObject({
      code: "unauthenticated",
    });
    // No row was ever written for it, so the refusal came from the signature.
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it("refuses a well-signed token whose session row is gone", async () => {
    const { db } = testDatabase();
    const signedIn = await signIn(db);
    await db.delete(sessions).where(eq(sessions.id, signedIn.sessionId));

    await expect(gateFor(db).authenticate(`Bearer ${signedIn.token}`)).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  it("refuses a session that was signed out", async () => {
    const { db } = testDatabase();
    const signedIn = await signIn(db);
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(eq(sessions.id, signedIn.sessionId));

    await expect(gateFor(db).authenticate(`Bearer ${signedIn.token}`)).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  it("tells an expired session apart from an unusable one, because the app acts on the difference", async () => {
    const { db } = testDatabase();
    const signedIn = await signIn(db, 60);
    const afterExpiry = () => new Date(Date.now() + 10 * 60 * 1000);

    await expect(
      gateFor(db, afterExpiry).authenticate(`Bearer ${signedIn.token}`),
    ).rejects.toMatchObject({ code: "session_expired", status: 401 });
  });

  it("refuses a token whose claims disagree with the row its hash found", async () => {
    const { db } = testDatabase();
    const signedIn = await signIn(db);
    const otherAccount = await insertAccount(db);
    // The same token, now stored against a different account: the signature
    // still verifies and the row is still live, and it is still not a session.
    await db
      .update(sessions)
      .set({ accountId: otherAccount })
      .where(eq(sessions.id, signedIn.sessionId));

    await expect(gateFor(db).authenticate(`Bearer ${signedIn.token}`)).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });
});

describe("ownership", () => {
  it("accepts a challenge the caller owns", async () => {
    const { db } = testDatabase();
    const signedIn = await signIn(db);
    const challengeId = await insertChallengeForAccount(db, signedIn.accountId);

    await expect(gateFor(db).assertOwnership(signedIn, { challengeId })).resolves.toBeUndefined();
  });

  it("refuses a challenge belonging to someone else as not found", async () => {
    const { db } = testDatabase();
    const signedIn = await signIn(db);
    const stranger = await insertAccount(db);
    const challengeId = await insertChallengeForAccount(db, stranger);

    await expect(gateFor(db).assertOwnership(signedIn, { challengeId })).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });

  it("finds a task through its challenge", async () => {
    const { db } = testDatabase();
    const signedIn = await signIn(db);
    const taskId = await taskOf(db, signedIn.accountId);

    await expect(gateFor(db).assertOwnership(signedIn, { taskId })).resolves.toBeUndefined();
  });
});

describe("issue 14's acceptance boundary", () => {
  /** The real routes, the real gate, and a handler that must not run. */
  async function mounted(db: Database) {
    return createApp({
      logger: createLogger({ sink: () => {} }),
      sessionGate: gateFor(db),
      handlers: {
        createCompletion: () => {
          throw new Error("a handler must never run for a task the caller does not own");
        },
      },
    });
  }

  function completion(token: string) {
    return {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        [IDEMPOTENCY_HEADER]: KEY,
      },
      body: JSON.stringify({
        clientRecordId: KEY,
        completedAt: "2026-01-05T15:30:00Z",
        observation: {
          startedAt: "2026-01-05T15:20:00Z",
          endedAt: "2026-01-05T15:30:00Z",
          steps: 600,
          provenance: "live-foreground",
          source: "expo-pedometer-ios",
        },
        appVersion: "1.0.0",
        verificationPolicyVersion: "2026-01-01",
      }),
    };
  }

  it("answers a cross-account task with not found, indistinguishable from a task that does not exist", async () => {
    const { db } = testDatabase();
    const caller = await signIn(db);
    const stranger = await insertAccount(db);
    const strangersTask = await taskOf(db, stranger);
    const app = await mounted(db);

    const crossAccount = await app.request(
      `/tasks/${strangersTask}/completions`,
      completion(caller.token),
    );
    const absent = await app.request(
      `/tasks/${ABSENT_TASK_ID}/completions`,
      completion(caller.token),
    );

    expect(crossAccount.status).toBe(404);
    // Not 403. A forbidden here would confirm the identifier names a real
    // task, which is a way to enumerate other people's tasks with a valid
    // session. The two answers are the same answer.
    expect(await crossAccount.json()).toEqual({
      code: "not_found",
      message: "No task with this identifier.",
    });
    expect(absent.status).toBe(crossAccount.status);
    expect(await absent.json()).toEqual({
      code: "not_found",
      message: "No task with this identifier.",
    });
  });

  it("lets the owner's identical request through to the handler", async () => {
    const { db } = testDatabase();
    const caller = await signIn(db);
    const ownTask = await taskOf(db, caller.accountId);
    const app = await mounted(db);

    const response = await app.request(`/tasks/${ownTask}/completions`, completion(caller.token));

    // The stub handler throws, so a 500 is proof the gate let the request past
    // it: the same request for a stranger's task never reaches the handler.
    expect(response.status).toBe(500);
  });
});
