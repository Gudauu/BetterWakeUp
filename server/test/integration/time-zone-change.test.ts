/**
 * Issue 22 against real rows and through the mounted route.
 *
 * The acceptance boundary is the first section: a task with a passed pause
 * cutoff and a deadline still ahead is untouched, while the tasks whose cutoffs
 * are still ahead move. Those two states differ by a single millisecond of
 * receipt instant and by nothing else, which is why the clock is injected.
 *
 * The fixtures place three tasks on 2026-01-05, -06, and -07, each with an
 * 08:00 deadline in `America/Los_Angeles` (16:00 UTC) and a No Regret duration
 * of one hour, so every stored cutoff is 15:00 UTC on the task's own date.
 *
 * The zone the tests move to is `America/Anchorage`, one hour behind Los
 * Angeles in January, so an unchanged 08:00 wall-clock deadline becomes 17:00
 * UTC and its cutoff 16:00 UTC. A moved task and an untouched one therefore
 * differ by an hour on every instant, and neither can pass for the other.
 */

import { type ChangeTimeZoneResponse, IDEMPOTENCY_HEADER } from "@betterwakeup/contract";
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
  taskValues,
} from "../support/challenge-fixtures.ts";
import { fakeRateLimiter } from "../support/fake-rate-limiter.ts";
import { useTestDatabase } from "../support/postgres.ts";

const testDatabase = useTestDatabase();

const SESSION_SECRET = "0123456789abcdef0123456789abcdef";
const HOUR_MS = 60 * 60 * 1000;

/** One hour behind the fixture's zone in January, so every instant moves. */
const ANCHORAGE = "America/Anchorage";

/** The stored pause cutoff of the task at `sequence`: one hour before its deadline. */
function cutoff(sequence: number): Date {
  return new Date(taskDeadline(sequence).getTime() - HOUR_MS);
}

/** An instant written as a UTC wall clock, which is how every expectation reads. */
function utc(date: string, time: string): Date {
  return new Date(`${date}T${time}:00.000Z`);
}

const KEY = {
  first: "7c1a0000-0000-4000-8000-000000000001",
  second: "7c1a0000-0000-4000-8000-000000000002",
  third: "7c1a0000-0000-4000-8000-000000000003",
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

function changeRequest(token: string, challengeId: string, key: string, timeZone: string) {
  return [
    `http://api.test/challenges/${challengeId}/time-zone`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        [IDEMPOTENCY_HEADER]: key,
      },
      body: JSON.stringify({ timeZone }),
    },
  ] as [string, RequestInit];
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

/** The response body, typed, for the assertions that read a field off it. */
async function bodyOf(response: Response): Promise<ChangeTimeZoneResponse> {
  return (await response.json()) as ChangeTimeZoneResponse;
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
      deadline: scheduledTasks.deadline,
      pauseCutoff: scheduledTasks.pauseCutoff,
    })
    .from(scheduledTasks)
    .where(eq(scheduledTasks.challengeId, challengeId))
    .orderBy(asc(scheduledTasks.sequence));
}

describe("issue 22's acceptance boundary", () => {
  it("leaves a task whose cutoff has passed and whose deadline is ahead untouched", async () => {
    const { db } = testDatabase();
    const { token, challengeId } = await arrange(db);

    // Exactly the first task's stored cutoff, so it is not strictly later than
    // the receipt instant. Its deadline is still an hour away.
    const response = await app(db, cutoff(1)).request(
      ...changeRequest(token, challengeId, KEY.first, ANCHORAGE),
    );

    expect(response.status).toBe(200);
    const tasks = await tasksOf(db, challengeId);
    expect(tasks[0]).toMatchObject({
      taskDate: "2026-01-05",
      deadline: utc("2026-01-05", "16:00"),
      pauseCutoff: utc("2026-01-05", "15:00"),
    });
    // The two tasks whose cutoffs were still ahead moved with the zone.
    expect(tasks.slice(1).map((task) => task.deadline)).toEqual([
      utc("2026-01-06", "17:00"),
      utc("2026-01-07", "17:00"),
    ]);
    expect(tasks.slice(1).map((task) => task.pauseCutoff)).toEqual([
      utc("2026-01-06", "16:00"),
      utc("2026-01-07", "16:00"),
    ]);
    expect(await response.json()).toMatchObject({
      challenge: { configuration: { timeZone: ANCHORAGE } },
      rematerializedTasks: [
        { id: tasks[1]?.id, deadline: utc("2026-01-06", "17:00").toISOString() },
        { id: tasks[2]?.id, deadline: utc("2026-01-07", "17:00").toISOString() },
      ],
    });
  });

  it("moves that same task when the change arrives a millisecond before its cutoff", async () => {
    const { db } = testDatabase();
    const { token, challengeId } = await arrange(db);

    const response = await app(db, new Date(cutoff(1).getTime() - 1)).request(
      ...changeRequest(token, challengeId, KEY.first, ANCHORAGE),
    );

    expect(response.status).toBe(200);
    const tasks = await tasksOf(db, challengeId);
    expect(tasks[0]).toMatchObject({
      deadline: utc("2026-01-05", "17:00"),
      pauseCutoff: utc("2026-01-05", "16:00"),
    });
    expect((await bodyOf(response)).rematerializedTasks).toHaveLength(3);
  });

  it("never rewrites a task with a resolved outcome, whatever its cutoff", async () => {
    const { db } = testDatabase();
    const { token, challengeId } = await arrange(db);
    const before = await tasksOf(db, challengeId);

    // One completed and one skipped task, with the skip's replacement appended
    // in the same transaction so the active challenge keeps its task count.
    await db.transaction(async (tx) => {
      await tx
        .update(scheduledTasks)
        .set({ status: "completed", acknowledgedAt: taskDeadline(1) })
        .where(eq(scheduledTasks.id, before[0]?.id ?? ""));
      await tx
        .update(scheduledTasks)
        .set({ status: "skipped", skippedAt: taskDeadline(2) })
        .where(eq(scheduledTasks.id, before[1]?.id ?? ""));
      await tx.insert(scheduledTasks).values(taskValues(challengeId, 4));
    });

    // Before every cutoff in the challenge, so only the status keeps the
    // resolved tasks out.
    const response = await app(db, utc("2026-01-04", "00:00")).request(
      ...changeRequest(token, challengeId, KEY.first, ANCHORAGE),
    );

    expect(response.status).toBe(200);
    const tasks = await tasksOf(db, challengeId);
    expect(tasks.slice(0, 2).map((task) => task.deadline)).toEqual([
      taskDeadline(1),
      taskDeadline(2),
    ]);
    expect(tasks.slice(2).map((task) => task.deadline)).toEqual([
      utc("2026-01-07", "17:00"),
      utc("2026-01-08", "17:00"),
    ]);
    expect((await bodyOf(response)).rematerializedTasks).toHaveLength(2);
  });
});

describe("what a change to the same zone does", () => {
  it("moves nothing and reports nothing re-materialized", async () => {
    const { db } = testDatabase();
    const { token, challengeId } = await arrange(db);

    const response = await app(db, utc("2026-01-04", "00:00")).request(
      ...changeRequest(token, challengeId, KEY.first, "America/Los_Angeles"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      challenge: { configuration: { timeZone: "America/Los_Angeles" } },
      rematerializedTasks: [],
    });
    const tasks = await tasksOf(db, challengeId);
    expect(tasks.map((task) => task.deadline)).toEqual([
      taskDeadline(1),
      taskDeadline(2),
      taskDeadline(3),
    ]);
  });
});

describe("moving eastward", () => {
  /**
   * Pinned rather than prevented. Nothing upstream states a policy for a move
   * that puts a task's deadline in the past, and the rule the architecture does
   * state binds on the stored cutoff alone, so the command applies it and this
   * test records what that means. If the product later decides such a change
   * should be refused or should spare that task, this is the test that changes.
   */
  it("can leave a task with a deadline already behind the receipt instant", async () => {
    const { db } = testDatabase();
    const { token, challengeId } = await arrange(db);
    const at = new Date(cutoff(1).getTime() - 1);

    const response = await app(db, at).request(
      // 08:00 in Berlin is 07:00 UTC in January, nine hours ahead of the same
      // wall clock in Los Angeles.
      ...changeRequest(token, challengeId, KEY.first, "Europe/Berlin"),
    );

    expect(response.status).toBe(200);
    const tasks = await tasksOf(db, challengeId);
    expect(tasks[0]?.deadline).toEqual(utc("2026-01-05", "07:00"));
    expect(tasks[0]?.deadline.getTime()).toBeLessThan(at.getTime());
  });
});

describe("what the time zone change refuses", () => {
  it("refuses a challenge that has already ended", async () => {
    const { db } = testDatabase();
    const { token, challengeId } = await arrange(db, { status: "failed" });

    const response = await app(db, cutoff(1)).request(
      ...changeRequest(token, challengeId, KEY.first, ANCHORAGE),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "challenge_not_active" });
  });

  it("refuses a challenge awaiting Emergency Recovery", async () => {
    const { db } = testDatabase();
    const { token, challengeId } = await arrange(db, {
      status: "recovery_pending",
      taskStatus: "missed",
    });

    const response = await app(db, utc("2026-01-04", "00:00")).request(
      ...changeRequest(token, challengeId, KEY.first, ANCHORAGE),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "challenge_not_active" });
  });

  it("answers another account's challenge with not found and moves nothing", async () => {
    const { db } = testDatabase();
    const { token } = await arrange(db);
    const stranger = await arrange(db);

    const response = await app(db, utc("2026-01-04", "00:00")).request(
      ...changeRequest(token, stranger.challengeId, KEY.first, ANCHORAGE),
    );

    expect(response.status).toBe(404);
    const [challenge] = await db
      .select({ timeZone: challenges.timeZone })
      .from(challenges)
      .where(eq(challenges.id, stranger.challengeId));
    expect(challenge?.timeZone).toBe("America/Los_Angeles");
  });

  it("refuses a zone name that is not an IANA zone at the validation boundary", async () => {
    const { db } = testDatabase();
    const { token, challengeId } = await arrange(db);

    const response = await app(db, cutoff(1)).request(
      ...changeRequest(token, challengeId, KEY.first, "Mars/Olympus_Mons"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "validation_failed" });
  });
});

describe("a paused challenge", () => {
  it("accepts a zone change without leaving pause mode", async () => {
    const { db } = testDatabase();
    const { token, challengeId } = await arrange(db);
    const paused = await app(db, new Date(cutoff(1).getTime() - 1)).request(
      ...pauseRequest(token, challengeId, KEY.first),
    );
    expect(paused.status).toBe(200);

    const response = await app(db, new Date(cutoff(1).getTime() - 1)).request(
      ...changeRequest(token, challengeId, KEY.second, ANCHORAGE),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      challenge: {
        configuration: { timeZone: ANCHORAGE },
        pause: { pausedAt: new Date(cutoff(1).getTime() - 1).toISOString() },
      },
    });
  });
});

describe("repeating a time zone change", () => {
  it("replays the stored result for a repeated key", async () => {
    const { db } = testDatabase();
    const { token, challengeId } = await arrange(db);
    const server = app(db, cutoff(1));
    const send = () => server.request(...changeRequest(token, challengeId, KEY.first, ANCHORAGE));

    const first = await send();
    const second = await send();

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await second.json()).toEqual(await first.json());
  });

  it("moves nothing a second time when a new key repeats the same zone", async () => {
    const { db } = testDatabase();
    const { token, challengeId } = await arrange(db);
    const server = app(db, cutoff(1));

    await server.request(...changeRequest(token, challengeId, KEY.first, ANCHORAGE));
    const second = await server.request(
      ...changeRequest(token, challengeId, KEY.second, ANCHORAGE),
    );

    expect(second.status).toBe(200);
    expect((await bodyOf(second)).rematerializedTasks).toEqual([]);
    const tasks = await tasksOf(db, challengeId);
    expect(tasks.slice(1).map((task) => task.deadline)).toEqual([
      utc("2026-01-06", "17:00"),
      utc("2026-01-07", "17:00"),
    ]);
  });
});

describe("two writers over one challenge", () => {
  /**
   * The challenge row lock. Racing two requests from here would test whichever
   * connection warmed up first, so the other writer signals from inside its
   * transaction that it holds the lock before the change starts.
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
        .set({ status: "failed", terminalAt: cutoff(1) })
        .where(and(eq(challenges.id, challengeId)));
    });

    await locked;
    const changing = app(test.db, cutoff(1)).request(
      ...changeRequest(token, challengeId, KEY.third, ANCHORAGE),
    );
    // Long enough for the change to have reached the lock it is waiting on.
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await otherWriter;

    const response = await changing;
    // It read the row the other writer left rather than the one it started on.
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "challenge_not_active" });
  });
});
