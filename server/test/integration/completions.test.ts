/**
 * Issue 20 against real rows and through the mounted route.
 *
 * The acceptance boundary is the first section: both sides of the sixty-second
 * receipt grace, to the millisecond, and a duplicate key returning the stored
 * result rather than a second completion. The grace is why an injected clock is
 * the receipt instant: a boundary tested against the real one is a boundary
 * tested to within however long the suite takes to run.
 *
 * The fixtures place the only task of interest on 2026-01-05, deadline 08:00 in
 * `America/Los_Angeles`, which is 16:00 UTC that day, so the window is
 * 2026-01-05T08:00Z through 2026-01-05T16:00Z and every instant in this file is
 * written out rather than computed.
 */

import { IDEMPOTENCY_HEADER, type MovementObservation } from "@betterwakeup/contract";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createSessionGate } from "../../src/auth/session-gate.ts";
import { hashSessionToken, mintSessionToken } from "../../src/auth/session-token.ts";
import type { Database } from "../../src/db/index.ts";
import { taskCompletions } from "../../src/db/schema/challenges.ts";
import { challenges, idempotencyKeys, scheduledTasks, sessions } from "../../src/db/schema.ts";
import { createApp } from "../../src/http/app.ts";
import { createLogger } from "../../src/observability/logger.ts";
import { createTaskHandlers } from "../../src/tasks/handlers.ts";
import {
  insertAccount,
  insertChallengeForAccount,
  taskDeadline,
  taskValues,
} from "../support/challenge-fixtures.ts";
import { fakeRateLimiter } from "../support/fake-rate-limiter.ts";
import { useTestDatabase } from "../support/postgres.ts";

const testDatabase = useTestDatabase();

const SESSION_SECRET = "0123456789abcdef0123456789abcdef";
/** The deadline of the fixtures' first task: 08:00 in Los Angeles on 5 January. */
const DEADLINE = taskDeadline(1);
const GRACE_MS = 60_000;
/** Inside the task window and before the deadline, which is what the rule asks. */
const COMPLETED_AT = "2026-01-05T15:59:00.000Z";

function observation(overrides: Partial<MovementObservation> = {}): MovementObservation {
  return {
    startedAt: "2026-01-05T15:50:00.000Z",
    endedAt: COMPLETED_AT,
    steps: 640,
    provenance: "live-foreground",
    source: "expo-pedometer-ios",
    ...overrides,
  };
}

interface CompletionBody {
  clientRecordId: string;
  completedAt: string;
  observation: MovementObservation;
  appVersion: string;
  verificationPolicyVersion: string;
}

function completion(key: string, overrides: Partial<CompletionBody> = {}): CompletionBody {
  return {
    clientRecordId: key,
    completedAt: COMPLETED_AT,
    observation: observation(),
    appVersion: "1.0.0",
    verificationPolicyVersion: "steps-v1",
    ...overrides,
  };
}

/** The server, with the receipt instant it will judge the deadline against. */
function app(db: Database, receivedAt: Date) {
  return createApp({
    logger: createLogger({ sink: () => {} }),
    sessionGate: createSessionGate({ db, sessionSecret: SESSION_SECRET }),
    rateLimiter: fakeRateLimiter(),
    handlers: createTaskHandlers({ db, now: () => receivedAt }),
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

function post(token: string, taskId: string, body: CompletionBody, key: string) {
  return [
    `http://api.test/tasks/${taskId}/completions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        [IDEMPOTENCY_HEADER]: key,
      },
      body: JSON.stringify(body),
    },
  ] as [string, RequestInit];
}

/** An account with a session, an active challenge, and its first open task. */
async function arrange(
  db: Database,
  overrides: Parameters<typeof insertChallengeForAccount>[2] = {},
): Promise<{ accountId: string; token: string; challengeId: string; taskId: string }> {
  const { accountId, token } = await signIn(db);
  const challengeId = await insertChallengeForAccount(db, accountId, overrides);
  const [task] = await db
    .select({ id: scheduledTasks.id })
    .from(scheduledTasks)
    .where(eq(scheduledTasks.challengeId, challengeId))
    .orderBy(asc(scheduledTasks.sequence))
    .limit(1);
  if (task === undefined) throw new Error("the fixture materialized no task");
  return { accountId, token, challengeId, taskId: task.id };
}

const KEY = {
  first: "c0f1e100-0000-4000-8000-000000000001",
  second: "c0f1e100-0000-4000-8000-000000000002",
};

describe("issue 20's acceptance boundary", () => {
  it("accepts a completion received at the last instant of the receipt grace", async () => {
    const { db } = testDatabase();
    const { token, taskId } = await arrange(db);
    const receivedAt = new Date(DEADLINE.getTime() + GRACE_MS);

    const response = await app(db, receivedAt).request(
      ...post(token, taskId, completion(KEY.first), KEY.first),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      task: { id: taskId, status: "completed", acknowledgedAt: receivedAt.toISOString() },
      replayed: false,
      challengeStatus: "active",
    });
  });

  it("refuses one received a millisecond after it", async () => {
    const { db } = testDatabase();
    const { token, taskId } = await arrange(db);
    const receivedAt = new Date(DEADLINE.getTime() + GRACE_MS + 1);

    const response = await app(db, receivedAt).request(
      ...post(token, taskId, completion(KEY.first), KEY.first),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "deadline_passed" });
    // The task keeps its own outcome, no evidence was stored, and the refused
    // key was released rather than left holding a lease for nothing.
    const [task] = await db
      .select({ status: scheduledTasks.status, acknowledgedAt: scheduledTasks.acknowledgedAt })
      .from(scheduledTasks)
      .where(eq(scheduledTasks.id, taskId));
    expect(task).toMatchObject({ status: "scheduled", acknowledgedAt: null });
    expect(await db.select().from(taskCompletions)).toHaveLength(0);
    expect(await db.select().from(idempotencyKeys)).toHaveLength(0);
  });

  it("replays the stored result for a repeated key rather than recording a second completion", async () => {
    const { db } = testDatabase();
    const { token, taskId } = await arrange(db);
    const server = app(db, new Date(DEADLINE.getTime() - 1000));
    const send = () => server.request(...post(token, taskId, completion(KEY.first), KEY.first));

    const first = (await (await send()).json()) as Record<string, unknown>;
    const repeated = await send();

    expect(repeated.status).toBe(200);
    // The same acknowledgment, and the only difference is the one field that
    // describes this request rather than the completion: the app is told the
    // record landed, and that it landed the first time.
    expect(first).toMatchObject({ replayed: false });
    expect(await repeated.json()).toEqual({ ...first, replayed: true });
    expect(await db.select().from(taskCompletions)).toHaveLength(1);
  });
});

describe("what a completion has to carry", () => {
  it("rejects an observation read out of the operating system's history", async () => {
    const { db } = testDatabase();
    const { token, taskId } = await arrange(db);

    const response = await app(db, DEADLINE).request(
      ...post(
        token,
        taskId,
        completion(KEY.first, { observation: observation({ provenance: "historical-query" }) }),
        KEY.first,
      ),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "movement_provenance_rejected" });
    // Refused before a key was claimed: the client's fix is a different
    // request, which it should not have to send under a fresh key.
    expect(await db.select().from(idempotencyKeys)).toHaveLength(0);
  });

  it("rejects a record whose identifier is not the key it was sent under", async () => {
    const { db } = testDatabase();
    const { token, taskId } = await arrange(db);

    const response = await app(db, DEADLINE).request(
      ...post(token, taskId, completion(KEY.second), KEY.first),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "validation_failed",
      details: [{ path: ["clientRecordId"] }],
    });
    expect(await db.select().from(idempotencyKeys)).toHaveLength(0);
  });

  it("rejects a reported instant before the task's window opens", async () => {
    const { db } = testDatabase();
    const { token, taskId } = await arrange(db);

    const response = await app(db, DEADLINE).request(
      ...post(
        token,
        taskId,
        completion(KEY.first, {
          // One minute before midnight local, which is the previous day's task.
          completedAt: "2026-01-05T07:59:00.000Z",
          observation: observation({
            startedAt: "2026-01-05T07:50:00.000Z",
            endedAt: "2026-01-05T07:59:00.000Z",
          }),
        }),
        KEY.first,
      ),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "completion_outside_task_window" });
  });

  it("rejects a reported instant past the deadline even inside the grace", async () => {
    const { db } = testDatabase();
    const { token, taskId } = await arrange(db);
    const receivedAt = new Date(DEADLINE.getTime() + 30_000);

    const response = await app(db, receivedAt).request(
      ...post(
        token,
        taskId,
        completion(KEY.first, {
          completedAt: new Date(DEADLINE.getTime() + 1).toISOString(),
          observation: observation({
            endedAt: new Date(DEADLINE.getTime() + 1).toISOString(),
          }),
        }),
        KEY.first,
      ),
    );

    // The grace forgives a late arrival, never a late completion: the request
    // was received in time and reports movement that was not.
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "completion_outside_task_window" });
  });

  it("rejects an observation below the challenge's step target", async () => {
    const { db } = testDatabase();
    const { token, taskId } = await arrange(db);

    const response = await app(db, DEADLINE).request(
      ...post(
        token,
        taskId,
        completion(KEY.first, { observation: observation({ steps: 499 }) }),
        KEY.first,
      ),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "step_target_not_met" });
  });

  it("stores the evidence the completion carried", async () => {
    const { db } = testDatabase();
    const { token, taskId } = await arrange(db);
    const receivedAt = new Date(DEADLINE.getTime() - 5000);

    await app(db, receivedAt).request(...post(token, taskId, completion(KEY.first), KEY.first));

    const [stored] = await db
      .select()
      .from(taskCompletions)
      .where(eq(taskCompletions.taskId, taskId));
    expect(stored).toMatchObject({
      steps: 640,
      provenance: "live-foreground",
      source: "expo-pedometer-ios",
      appVersion: "1.0.0",
      verificationPolicyVersion: "steps-v1",
    });
    expect(stored?.completedAt.toISOString()).toBe(COMPLETED_AT);
    // The acknowledgment instant is the server's, not the device's.
    expect(stored?.acknowledgedAt.toISOString()).toBe(receivedAt.toISOString());
  });
});

describe("what a completion changes", () => {
  it("ends the challenge on the completion that reaches its required count", async () => {
    const { db } = testDatabase();
    const { token, taskId, challengeId } = await arrange(db, {
      requiredTaskCount: 1,
      taskCount: 1,
    });
    const receivedAt = new Date(DEADLINE.getTime() - 1000);

    const response = await app(db, receivedAt).request(
      ...post(token, taskId, completion(KEY.first), KEY.first),
    );

    expect(await response.json()).toMatchObject({ challengeStatus: "succeeded" });
    const [challenge] = await db
      .select({ status: challenges.status, terminalAt: challenges.terminalAt })
      .from(challenges)
      .where(eq(challenges.id, challengeId));
    expect(challenge?.status).toBe("succeeded");
    expect(challenge?.terminalAt?.toISOString()).toBe(receivedAt.toISOString());
  });

  it("leaves the challenge active while tasks remain", async () => {
    const { db } = testDatabase();
    const { token, taskId, challengeId } = await arrange(db);

    const response = await app(db, DEADLINE).request(
      ...post(token, taskId, completion(KEY.first), KEY.first),
    );

    expect(await response.json()).toMatchObject({ challengeStatus: "active" });
    const [challenge] = await db
      .select({ status: challenges.status })
      .from(challenges)
      .where(eq(challenges.id, challengeId));
    expect(challenge?.status).toBe("active");
  });

  it("refuses a second completion of the same task under a new key", async () => {
    const { db } = testDatabase();
    const { token, taskId } = await arrange(db);
    const server = app(db, DEADLINE);

    await server.request(...post(token, taskId, completion(KEY.first), KEY.first));
    const second = await server.request(...post(token, taskId, completion(KEY.second), KEY.second));

    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: "task_already_resolved" });
    expect(await db.select().from(taskCompletions)).toHaveLength(1);
  });

  it("refuses a completion against a challenge that has ended", async () => {
    const { db } = testDatabase();
    const { token, taskId } = await arrange(db, { status: "failed" });

    const response = await app(db, DEADLINE).request(
      ...post(token, taskId, completion(KEY.first), KEY.first),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "challenge_not_active" });
  });

  it("is another account's task to nobody", async () => {
    const { db } = testDatabase();
    const { token } = await signIn(db);
    const stranger = await arrange(db);

    const response = await app(db, DEADLINE).request(
      ...post(token, stranger.taskId, completion(KEY.first), KEY.first),
    );

    // Not forbidden: a distinguishable answer would confirm the task exists.
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
    expect(await db.select().from(taskCompletions)).toHaveLength(0);
  });

  it("serializes two simultaneous completions of one task", async () => {
    const test = testDatabase();
    const second = test.connect();
    const { token, taskId } = await arrange(test.db);

    const responses = await Promise.all([
      app(test.db, DEADLINE).request(...post(token, taskId, completion(KEY.first), KEY.first)),
      app(second.db, DEADLINE).request(...post(token, taskId, completion(KEY.second), KEY.second)),
    ]);

    // Two different keys, so idempotency has nothing to say. Only one of them
    // records a completion, and the loser is told the task is resolved rather
    // than shown a duplicate-key failure.
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await test.db.select().from(taskCompletions)).toHaveLength(1);
  });

  /**
   * The race the row lock exists for, which issue 23's sweep is the other half
   * of: a writer that consumes the same task while a completion is in flight.
   *
   * The other writer here is the pause skip, because it is the one that keeps
   * the task count intact on its own (it appends the replacement its skip
   * consumed) and so can be written before the sweep exists. What is being
   * proved is the completion path's behavior, not the skip's: taking the task
   * row `for update` before deciding anything is what turns this into a
   * conflict the caller is told about instead of a duplicate-key failure
   * discovered two statements later.
   */
  it("waits for a concurrent writer to finish with the task rather than racing it", async () => {
    const test = testDatabase();
    const other = test.connect();
    const { token, taskId, challengeId } = await arrange(test.db);

    let release = (): void => {};
    let lockTaken = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });
    // Holds the task row locked, then consumes it and appends its replacement,
    // which is what a pause cutoff passing does.
    const skipping = other.db.transaction(async (tx) => {
      await tx
        .select({ id: scheduledTasks.id })
        .from(scheduledTasks)
        .where(eq(scheduledTasks.id, taskId))
        .for("update");
      lockTaken();
      await held;
      await tx
        .update(scheduledTasks)
        .set({ status: "skipped", skippedAt: DEADLINE })
        .where(eq(scheduledTasks.id, taskId));
      await tx.insert(scheduledTasks).values(taskValues(challengeId, 4));
    });

    // The completion starts only once the other writer holds the lock. Racing
    // the two from here would test whichever connection warmed up first.
    await locked;
    const completing = app(test.db, DEADLINE).request(
      ...post(token, taskId, completion(KEY.first), KEY.first),
    );
    // Long enough for the completion to have reached the lock it is waiting on.
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await skipping;

    const response = await completing;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "task_already_resolved" });
    expect(await test.db.select().from(taskCompletions)).toHaveLength(0);
  });
});
