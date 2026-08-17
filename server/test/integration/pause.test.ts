/**
 * Issue 21 against real rows and through the mounted routes.
 *
 * The acceptance boundary is the first section: entering and leaving pause both
 * bind at the pause cutoff boundary, to the millisecond, which is why the clock
 * is injected. The second is the invariant: a pause spanning several task
 * windows consumes every one of them and the active challenge still holds
 * exactly its required task count after each skip, checked against committed
 * rows rather than against what the command said it did.
 *
 * The fixtures place three tasks on 2026-01-05, -06, and -07, each with an
 * 08:00 deadline in `America/Los_Angeles` (16:00 UTC) and a No Regret duration
 * of one hour, so every cutoff is 15:00 UTC on the task's own date. Every
 * instant in this file is written against that.
 */

import { IDEMPOTENCY_HEADER } from "@betterwakeup/contract";
import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createSessionGate } from "../../src/auth/session-gate.ts";
import { hashSessionToken, mintSessionToken } from "../../src/auth/session-token.ts";
import { createChallengeHandlers } from "../../src/challenges/handlers.ts";
import type { Database } from "../../src/db/index.ts";
import { challenges, scheduledTasks, sessions } from "../../src/db/schema.ts";
import { createApp } from "../../src/http/app.ts";
import { createLogger } from "../../src/observability/logger.ts";
import {
  insertAccount,
  insertChallengeForAccount,
  taskDeadline,
} from "../support/challenge-fixtures.ts";
import { fakeRateLimiter } from "../support/fake-rate-limiter.ts";
import { useTestDatabase } from "../support/postgres.ts";

const testDatabase = useTestDatabase();

const SESSION_SECRET = "0123456789abcdef0123456789abcdef";
const HOUR_MS = 60 * 60 * 1000;

/** The pause cutoff of the task at `sequence`: one hour before its deadline. */
function cutoff(sequence: number): Date {
  return new Date(taskDeadline(sequence).getTime() - HOUR_MS);
}

const KEY = {
  first: "9a3f0000-0000-4000-8000-000000000001",
  second: "9a3f0000-0000-4000-8000-000000000002",
  third: "9a3f0000-0000-4000-8000-000000000003",
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

function pauseRequest(token: string, challengeId: string, key: string) {
  return [
    `http://api.test/challenges/${challengeId}/pause`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        [IDEMPOTENCY_HEADER]: key,
      },
      body: JSON.stringify({}),
    },
  ] as [string, RequestInit];
}

function resumeRequest(token: string, challengeId: string, key: string) {
  return [
    `http://api.test/challenges/${challengeId}/pause`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, [IDEMPOTENCY_HEADER]: key },
    },
  ] as [string, RequestInit];
}

/** An account with a session and an active three-task challenge. */
async function arrange(
  db: Database,
  overrides: Parameters<typeof insertChallengeForAccount>[2] = {},
): Promise<{ accountId: string; token: string; challengeId: string }> {
  const { accountId, token } = await signIn(db);
  const challengeId = await insertChallengeForAccount(db, accountId, overrides);
  return { accountId, token, challengeId };
}

/** The challenge's tasks in materialization order, which is also date order. */
async function tasksOf(db: Database, challengeId: string) {
  return await db
    .select({
      id: scheduledTasks.id,
      sequence: scheduledTasks.sequence,
      taskDate: scheduledTasks.taskDate,
      status: scheduledTasks.status,
      skippedAt: scheduledTasks.skippedAt,
    })
    .from(scheduledTasks)
    .where(eq(scheduledTasks.challengeId, challengeId))
    .orderBy(asc(scheduledTasks.sequence));
}

/** Puts the challenge into pause mode at `at`, the way a user would. */
async function pauseAt(db: Database, token: string, challengeId: string, at: Date, key: string) {
  const response = await app(db, at).request(...pauseRequest(token, challengeId, key));
  expect(response.status).toBe(200);
  return await response.json();
}

describe("issue 21's acceptance boundary", () => {
  it("leaves a task live when the pause is set at its cutoff, and names the next one", async () => {
    const { db } = testDatabase();
    const { token, challengeId } = await arrange(db);

    const body = await pauseAt(db, token, challengeId, cutoff(1), KEY.first);

    const tasks = await tasksOf(db, challengeId);
    expect(body).toMatchObject({
      challenge: { pause: { pausedAt: cutoff(1).toISOString() } },
      // The first task's cutoff has passed, so this pause never takes it. The
      // second is the first one it can.
      nextSkippedTask: { id: tasks[1]?.id, date: "2026-01-06" },
    });
    // Pausing consumes nothing by itself: the mode decides later cutoffs.
    expect(tasks.map((task) => task.status)).toEqual(["scheduled", "scheduled", "scheduled"]);
  });

  it("takes the task when the pause is set a millisecond before its cutoff", async () => {
    const { db } = testDatabase();
    const { token, challengeId } = await arrange(db);

    const body = await pauseAt(
      db,
      token,
      challengeId,
      new Date(cutoff(1).getTime() - 1),
      KEY.first,
    );

    const tasks = await tasksOf(db, challengeId);
    expect(body).toMatchObject({ nextSkippedTask: { id: tasks[0]?.id, date: "2026-01-05" } });
  });

  it("consumes a task whose cutoff passed during the pause when the resume lands on it", async () => {
    const { db } = testDatabase();
    const { token, challengeId } = await arrange(db);
    await pauseAt(db, token, challengeId, new Date(cutoff(1).getTime() - 1), KEY.first);

    // Exactly at the first task's cutoff: the pause was in force when it passed,
    // so the resume takes effect on the following task.
    const response = await app(db, cutoff(1)).request(
      ...resumeRequest(token, challengeId, KEY.second),
    );

    expect(response.status).toBe(200);
    const tasks = await tasksOf(db, challengeId);
    expect(await response.json()).toMatchObject({
      challenge: { pause: { pausedAt: null, expiresAt: null } },
      nextLiveTask: { id: tasks[1]?.id, date: "2026-01-06" },
    });
    expect(tasks.map((task) => task.status)).toEqual([
      "skipped",
      "scheduled",
      "scheduled",
      "scheduled",
    ]);
    expect(tasks[0]?.skippedAt).toEqual(cutoff(1));
    // The skip appended its replacement in the same transaction, one scheduled
    // date past the last one the challenge held.
    expect(tasks[3]).toMatchObject({ sequence: 4, taskDate: "2026-01-08" });
  });

  it("hands back a task whose cutoff has not passed when the resume lands a millisecond early", async () => {
    const { db } = testDatabase();
    const { token, challengeId } = await arrange(db);
    await pauseAt(db, token, challengeId, new Date(cutoff(1).getTime() - 2), KEY.first);

    const response = await app(db, new Date(cutoff(1).getTime() - 1)).request(
      ...resumeRequest(token, challengeId, KEY.second),
    );

    expect(response.status).toBe(200);
    const tasks = await tasksOf(db, challengeId);
    expect(await response.json()).toMatchObject({ nextLiveTask: { id: tasks[0]?.id } });
    expect(tasks.map((task) => task.status)).toEqual(["scheduled", "scheduled", "scheduled"]);
  });
});

describe("a pause spanning many task windows", () => {
  it("consumes every task the pause outlasted and keeps the task count intact", async () => {
    const { db } = testDatabase();
    const { token, challengeId } = await arrange(db);
    await pauseAt(db, token, challengeId, new Date(cutoff(1).getTime() - 1), KEY.first);

    // Past the third task's cutoff, so all three windows were spent paused.
    const response = await app(db, cutoff(3)).request(
      ...resumeRequest(token, challengeId, KEY.second),
    );

    expect(response.status).toBe(200);
    const tasks = await tasksOf(db, challengeId);
    expect(tasks.map((task) => task.status)).toEqual([
      "skipped",
      "skipped",
      "skipped",
      "scheduled",
      "scheduled",
      "scheduled",
    ]);
    expect(tasks.slice(3).map((task) => task.taskDate)).toEqual([
      "2026-01-08",
      "2026-01-09",
      "2026-01-10",
    ]);
    // The rows committed, so the deferred task count trigger accepted them: an
    // active challenge holding exactly its three scheduled or completed tasks.
    const open = tasks.filter((task) => task.status === "scheduled");
    expect(open).toHaveLength(3);
    expect(await response.json()).toMatchObject({
      challenge: { status: "active", projectedEndDate: "2026-01-10" },
      nextLiveTask: { id: tasks[3]?.id, date: "2026-01-08" },
    });
  });

  it("carries the challenge past its original projected end date", async () => {
    const { db } = testDatabase();
    const { token, challengeId } = await arrange(db);
    await pauseAt(db, token, challengeId, new Date(cutoff(1).getTime() - 1), KEY.first);

    await app(db, cutoff(3)).request(...resumeRequest(token, challengeId, KEY.second));

    const [challenge] = await db
      .select({ projectedEndDate: challenges.projectedEndDate, pausedAt: challenges.pausedAt })
      .from(challenges)
      .where(eq(challenges.id, challengeId));
    // Three task dates later than the 2026-01-07 the fixture started with.
    expect(challenge).toMatchObject({ projectedEndDate: "2026-01-10", pausedAt: null });
  });

  it("skips nothing whose cutoff passed before the pause was set", async () => {
    const { db } = testDatabase();
    const { token, challengeId } = await arrange(db);
    // Set after the first task's cutoff and before the second's.
    await pauseAt(db, token, challengeId, cutoff(1), KEY.first);

    await app(db, cutoff(3)).request(...resumeRequest(token, challengeId, KEY.second));

    const tasks = await tasksOf(db, challengeId);
    // The first task is still the user's: they were inside its window when they
    // paused, so the pause never took it.
    expect(tasks.map((task) => task.status)).toEqual([
      "scheduled",
      "skipped",
      "skipped",
      "scheduled",
      "scheduled",
    ]);
  });
});

describe("what pause and resume refuse", () => {
  it("refuses a second pause of an already paused challenge", async () => {
    const { db } = testDatabase();
    const { token, challengeId } = await arrange(db);
    await pauseAt(db, token, challengeId, cutoff(1), KEY.first);

    const response = await app(db, cutoff(1)).request(
      ...pauseRequest(token, challengeId, KEY.second),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "challenge_already_paused" });
  });

  it("refuses a resume of a challenge that is not paused", async () => {
    const { db } = testDatabase();
    const { token, challengeId } = await arrange(db);

    const response = await app(db, cutoff(1)).request(
      ...resumeRequest(token, challengeId, KEY.first),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "challenge_not_paused" });
  });

  it("refuses to pause a challenge that has already ended", async () => {
    const { db } = testDatabase();
    const { token, challengeId } = await arrange(db, { status: "failed" });

    const response = await app(db, cutoff(1)).request(
      ...pauseRequest(token, challengeId, KEY.first),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "challenge_not_active" });
  });

  it("answers another account's challenge with not found", async () => {
    const { db } = testDatabase();
    const { token } = await arrange(db);
    const stranger = await arrange(db);

    const response = await app(db, cutoff(1)).request(
      ...pauseRequest(token, stranger.challengeId, KEY.first),
    );

    expect(response.status).toBe(404);
    const [challenge] = await db
      .select({ pausedAt: challenges.pausedAt })
      .from(challenges)
      .where(eq(challenges.id, stranger.challengeId));
    expect(challenge?.pausedAt).toBeNull();
  });
});

describe("repeating a pause command", () => {
  it("replays the stored result for a repeated key rather than pausing twice", async () => {
    const { db } = testDatabase();
    const { token, challengeId } = await arrange(db);
    const server = app(db, cutoff(1));
    const send = () => server.request(...pauseRequest(token, challengeId, KEY.first));

    const first = await send();
    const second = await send();

    expect([first.status, second.status]).toEqual([200, 200]);
    const [firstBody, secondBody] = [await first.json(), await second.json()];
    expect(secondBody).toEqual(firstBody);
    // And the pause instant is the first attempt's, not the second's.
    const [challenge] = await db
      .select({ pausedAt: challenges.pausedAt })
      .from(challenges)
      .where(eq(challenges.id, challengeId));
    expect(challenge?.pausedAt).toEqual(cutoff(1));
  });

  it("replays a resume rather than consuming a second set of tasks", async () => {
    const { db } = testDatabase();
    const { token, challengeId } = await arrange(db);
    await pauseAt(db, token, challengeId, new Date(cutoff(1).getTime() - 1), KEY.first);
    const server = app(db, cutoff(1));
    const send = () => server.request(...resumeRequest(token, challengeId, KEY.second));

    await send();
    const second = await send();

    expect(second.status).toBe(200);
    const tasks = await tasksOf(db, challengeId);
    expect(tasks.filter((task) => task.status === "skipped")).toHaveLength(1);
    expect(tasks).toHaveLength(4);
  });
});

describe("two writers over one challenge", () => {
  /**
   * The challenge row lock, which is what makes the pause decision and any
   * other writer over the same challenge mutually exclusive rather than each
   * correct alone. Racing two requests from here would test whichever
   * connection warmed up first, so the other writer signals from inside its
   * transaction that it holds the lock before the pause starts.
   */
  it("waits for a concurrent writer rather than deciding on a stale read", async () => {
    const test = testDatabase();
    const other = test.connect();
    const { token, challengeId } = await arrange(test.db);

    let release = (): void => {};
    let lockTaken = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });
    const otherWriter = other.db.transaction(async (tx) => {
      await tx
        .select({ id: challenges.id })
        .from(challenges)
        .where(eq(challenges.id, challengeId))
        .for("update");
      lockTaken();
      await held;
      await tx
        .update(challenges)
        .set({ pausedAt: cutoff(1) })
        .where(and(eq(challenges.id, challengeId)));
    });

    await locked;
    const pausing = app(test.db, cutoff(1)).request(...pauseRequest(token, challengeId, KEY.third));
    // Long enough for the pause to have reached the lock it is waiting on.
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await otherWriter;

    const response = await pausing;
    // It read the row the other writer left rather than the one it started on.
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "challenge_already_paused" });
  });
});
