/**
 * Issue 23 against real rows.
 *
 * The acceptance boundary is four claims, and each has its own section below:
 * running the sweep twice leaves the same state as running it once, two
 * invocations take disjoint work, a completion whose attempt crashed mid
 * transaction survives until its retry resolves, and a year-long pause expires
 * exactly once for a funded and a zero deposit challenge alike.
 *
 * The fixtures place three tasks on 2026-01-05, -06, and -07, each with an
 * 08:00 deadline in `America/Los_Angeles` (16:00 UTC) and a No Regret duration
 * of one hour, so every cutoff is 15:00 UTC on the task's own date. Every
 * instant here is written against that, and the sweep's clock is injected so a
 * boundary can be tested to the millisecond rather than to whenever the suite
 * happens to run.
 */

import { RECEIPT_GRACE_SECONDS, RECOVERY_WINDOW_HOURS } from "@betterwakeup/contract";
import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { Database } from "../../src/db/index.ts";
import { ledgerTransactions, paymentCommands } from "../../src/db/schema/payments.ts";
import { accounts, challenges, idempotencyKeys, scheduledTasks } from "../../src/db/schema.ts";
import type { ScheduledEvent } from "../../src/lambda/events.ts";
import { createLogger } from "../../src/observability/logger.ts";
import { createSweep, type SweepResult } from "../../src/sweep/run-sweep.ts";
import {
  insertChallenge,
  insertChallengeForAccount,
  taskDeadline,
} from "../support/challenge-fixtures.ts";
import { scheduledEvent } from "../support/lambda-events.ts";
import { useTestDatabase } from "../support/postgres.ts";

const testDatabase = useTestDatabase();

const SECOND_MS = 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The last instant a completion for the task at `sequence` may be received. */
function graceEnds(sequence: number): Date {
  return new Date(taskDeadline(sequence).getTime() + RECEIPT_GRACE_SECONDS * SECOND_MS);
}

/** The pause cutoff of the task at `sequence`: one hour before its deadline. */
function cutoff(sequence: number): Date {
  return new Date(taskDeadline(sequence).getTime() - HOUR_MS);
}

async function sweep(db: Database, at: Date): Promise<SweepResult> {
  const run = createSweep({ db, now: () => at });
  return await run(scheduledEvent() as ScheduledEvent, createLogger({ sink: () => {} }));
}

async function tasksOf(db: Database, challengeId: string) {
  return await db
    .select({
      id: scheduledTasks.id,
      sequence: scheduledTasks.sequence,
      status: scheduledTasks.status,
      missedAt: scheduledTasks.missedAt,
      skippedAt: scheduledTasks.skippedAt,
    })
    .from(scheduledTasks)
    .where(eq(scheduledTasks.challengeId, challengeId))
    .orderBy(asc(scheduledTasks.sequence));
}

async function challengeRow(db: Database, challengeId: string) {
  const [row] = await db
    .select({
      status: challenges.status,
      terminalAt: challenges.terminalAt,
      pausedAt: challenges.pausedAt,
    })
    .from(challenges)
    .where(eq(challenges.id, challengeId));
  if (row === undefined) throw new Error("the challenge disappeared");
  return row;
}

async function commandsOf(db: Database, challengeId: string) {
  return await db
    .select({
      kind: paymentCommands.kind,
      status: paymentCommands.status,
      executeAfter: paymentCommands.executeAfter,
      dedupeKey: paymentCommands.dedupeKey,
    })
    .from(paymentCommands)
    .where(eq(paymentCommands.challengeId, challengeId));
}

/**
 * An idempotency key claimed but never completed, as a crashed completion
 * attempt leaves one.
 */
async function claimCompletionKey(
  db: Database,
  options: {
    accountId: string;
    taskId: string;
    key: string;
    createdAt: Date;
    leaseExpiresAt: Date;
  },
): Promise<void> {
  await db.insert(idempotencyKeys).values({
    accountId: options.accountId,
    key: options.key,
    commandType: "createCompletion",
    requestHash: "not-read-by-the-sweep",
    subjectId: options.taskId,
    createdAt: options.createdAt,
    leaseExpiresAt: options.leaseExpiresAt,
  });
}

describe("the sweep marks overdue tasks missed", () => {
  it("leaves a task alone until its receipt grace has passed", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);

    const early = await sweep(db, graceEnds(1));
    expect(early.tasksMissed).toBe(0);
    expect((await challengeRow(db, challengeId)).status).toBe("active");

    const late = await sweep(db, new Date(graceEnds(1).getTime() + 1));
    expect(late.tasksMissed).toBe(1);
    expect((await tasksOf(db, challengeId))[0]).toMatchObject({ status: "missed" });
  });

  it("moves a funded challenge whose account still holds recovery to recovery_pending", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db, { depositMinorUnits: 2000 });
    const at = new Date(graceEnds(1).getTime() + SECOND_MS);

    const result = await sweep(db, at);

    expect(result).toMatchObject({
      tasksMissed: 1,
      challengesInRecovery: 1,
      challengesFailed: 0,
      settlementsCreated: 1,
    });
    const challenge = await challengeRow(db, challengeId);
    // `recovery_pending` is not terminal: the challenge can still come back.
    expect(challenge).toMatchObject({ status: "recovery_pending", terminalAt: null });
    const [command] = await commandsOf(db, challengeId);
    expect(command).toMatchObject({ kind: "capture", status: "pending" });
    // The recovery window is the command's eligibility instant, not a timer.
    expect(command?.executeAfter.toISOString()).toBe(
      new Date(at.getTime() + RECOVERY_WINDOW_HOURS * HOUR_MS).toISOString(),
    );
  });

  it("fails a funded challenge whose account has already spent its recovery", async () => {
    const { db } = testDatabase();
    const { accountId, challengeId } = await insertChallenge(db, { depositMinorUnits: 2000 });
    await db
      .update(accounts)
      .set({ emergencyRecoveryConsumedAt: new Date(Date.UTC(2025, 5, 1)) })
      .where(eq(accounts.id, accountId));
    const at = new Date(graceEnds(1).getTime() + SECOND_MS);

    const result = await sweep(db, at);

    expect(result).toMatchObject({ challengesFailed: 1, challengesInRecovery: 0 });
    expect(await challengeRow(db, challengeId)).toMatchObject({
      status: "failed",
      terminalAt: at,
    });
    const [command] = await commandsOf(db, challengeId);
    // Immediate, because there is no recovery left to wait for.
    expect(command?.executeAfter.toISOString()).toBe(at.toISOString());
  });

  it("fails a zero deposit challenge outright and creates no settlement command", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db, { depositMinorUnits: 0 });

    const result = await sweep(db, new Date(graceEnds(1).getTime() + SECOND_MS));

    expect(result).toMatchObject({ challengesFailed: 1, settlementsCreated: 0 });
    expect((await challengeRow(db, challengeId)).status).toBe("failed");
    expect(await commandsOf(db, challengeId)).toEqual([]);
  });

  it("moves no money: it writes a command and no ledger entry", async () => {
    const { db } = testDatabase();
    await insertChallenge(db, { depositMinorUnits: 2000 });

    await sweep(db, new Date(graceEnds(1).getTime() + SECOND_MS));

    expect(await db.select().from(ledgerTransactions)).toEqual([]);
  });

  it("resolves one task per challenge, because the first miss ends it", async () => {
    const { db } = testDatabase();
    // Every task of this challenge is overdue at once, which is what a sweep
    // that had not run for days would find.
    const { challengeId } = await insertChallenge(db);

    const result = await sweep(db, new Date(taskDeadline(3).getTime() + DAY_MS));

    expect(result.tasksMissed).toBe(1);
    const statuses = (await tasksOf(db, challengeId)).map((task) => task.status);
    expect(statuses).toEqual(["missed", "scheduled", "scheduled"]);
  });
});

describe("the sweep is idempotent", () => {
  it("running it twice leaves the same state as running it once", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db, { depositMinorUnits: 2000 });
    const at = new Date(graceEnds(1).getTime() + SECOND_MS);

    const first = await sweep(db, at);
    const afterFirst = {
      tasks: await tasksOf(db, challengeId),
      challenge: await challengeRow(db, challengeId),
      commands: await commandsOf(db, challengeId),
    };

    const second = await sweep(db, new Date(at.getTime() + HOUR_MS));

    expect(first).toMatchObject({ tasksMissed: 1, settlementsCreated: 1 });
    expect(second).toMatchObject({ tasksMissed: 0, settlementsCreated: 0, tasksResolved: 0 });
    expect({
      tasks: await tasksOf(db, challengeId),
      challenge: await challengeRow(db, challengeId),
      commands: await commandsOf(db, challengeId),
    }).toEqual(afterFirst);
  });
});

describe("the sweep leaves a completion that is still in flight", () => {
  it("survives a task whose completion attempt crashed, until its retry resolves", async () => {
    const { db } = testDatabase();
    const { accountId, challengeId } = await insertChallenge(db);
    const [task] = await tasksOf(db, challengeId);
    if (task === undefined) throw new Error("the fixture wrote no task");
    const at = new Date(graceEnds(1).getTime() + SECOND_MS);
    // Claimed one second before the deadline and never completed: the command
    // arrived in time and the attempt died before it could commit.
    await claimCompletionKey(db, {
      accountId,
      taskId: task.id,
      key: "3b9a0000-0000-4000-8000-000000000001",
      createdAt: new Date(taskDeadline(1).getTime() - SECOND_MS),
      leaseExpiresAt: new Date(at.getTime() + 120 * SECOND_MS),
    });

    const held = await sweep(db, at);

    expect(held.tasksMissed).toBe(0);
    expect((await tasksOf(db, challengeId))[0]?.status).toBe("scheduled");

    // The retry lands: the key completes and the task with it. Nothing the
    // sweep does afterwards may take that away.
    await db.transaction(async (tx) => {
      await tx
        .update(scheduledTasks)
        .set({ status: "completed", acknowledgedAt: at, updatedAt: at })
        .where(eq(scheduledTasks.id, task.id));
      await tx
        .update(idempotencyKeys)
        .set({ status: "completed", completedAt: at, result: { ok: true } })
        .where(eq(idempotencyKeys.accountId, accountId));
    });

    const after = await sweep(db, new Date(at.getTime() + HOUR_MS));

    expect(after.tasksMissed).toBe(0);
    expect((await tasksOf(db, challengeId))[0]?.status).toBe("completed");
  });

  it("misses the task once the crashed attempt's lease has run out", async () => {
    const { db } = testDatabase();
    const { accountId, challengeId } = await insertChallenge(db);
    const [task] = await tasksOf(db, challengeId);
    if (task === undefined) throw new Error("the fixture wrote no task");
    const at = new Date(graceEnds(1).getTime() + SECOND_MS);
    await claimCompletionKey(db, {
      accountId,
      taskId: task.id,
      key: "3b9a0000-0000-4000-8000-000000000002",
      createdAt: new Date(taskDeadline(1).getTime() - SECOND_MS),
      // Expired by the instant the sweep runs.
      leaseExpiresAt: new Date(at.getTime() - SECOND_MS),
    });

    const result = await sweep(db, at);

    expect(result.tasksMissed).toBe(1);
    expect((await tasksOf(db, challengeId))[0]?.status).toBe("missed");
  });

  it("ignores a key claimed after the receipt window, however live its lease", async () => {
    const { db } = testDatabase();
    const { accountId, challengeId } = await insertChallenge(db);
    const [task] = await tasksOf(db, challengeId);
    if (task === undefined) throw new Error("the fixture wrote no task");
    const at = new Date(graceEnds(1).getTime() + 30 * SECOND_MS);
    await claimCompletionKey(db, {
      accountId,
      taskId: task.id,
      key: "3b9a0000-0000-4000-8000-000000000003",
      // One millisecond past the grace: the completion path would refuse this
      // request too, so it is not evidence of anything in flight.
      createdAt: new Date(graceEnds(1).getTime() + 1),
      leaseExpiresAt: new Date(at.getTime() + HOUR_MS),
    });

    const result = await sweep(db, at);

    expect(result.tasksMissed).toBe(1);
  });
});

describe("the sweep processes pause cutoffs before it judges anything overdue", () => {
  it("skips a task the pause consumed rather than missing it", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);
    // Paused one millisecond before the first task's cutoff, so the pause took
    // that task, and long enough ago that its deadline has since passed too.
    await db
      .update(challenges)
      .set({ pausedAt: new Date(cutoff(1).getTime() - 1) })
      .where(eq(challenges.id, challengeId));

    const result = await sweep(db, new Date(graceEnds(1).getTime() + SECOND_MS));

    expect(result).toMatchObject({ tasksSkipped: 1, tasksMissed: 0, tasksResolved: 1 });
    const tasks = await tasksOf(db, challengeId);
    expect(tasks.map((task) => task.status)).toEqual([
      "skipped",
      "scheduled",
      "scheduled",
      "scheduled",
    ]);
    // The challenge is still running, and still holds its required task count.
    expect((await challengeRow(db, challengeId)).status).toBe("active");
  });

  it("misses a task whose cutoff had already passed when the pause was set", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db, { depositMinorUnits: 2000 });
    // One millisecond the other side of the cutoff: the user never got their
    // No Regret notice, so the pause leaves this task live.
    await db
      .update(challenges)
      .set({ pausedAt: new Date(cutoff(1).getTime() + 1) })
      .where(eq(challenges.id, challengeId));

    const result = await sweep(db, new Date(graceEnds(1).getTime() + SECOND_MS));

    expect(result).toMatchObject({ tasksSkipped: 0, tasksMissed: 1 });
    expect((await challengeRow(db, challengeId)).status).toBe("recovery_pending");
  });
});

describe("the sweep expires a year-long pause", () => {
  it("expires a funded challenge exactly once and releases its authorization", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db, { depositMinorUnits: 2000 });
    const at = new Date(graceEnds(1).getTime() + SECOND_MS);
    await db
      .update(challenges)
      .set({ pausedAt: new Date(at.getTime() - 365 * DAY_MS) })
      .where(eq(challenges.id, challengeId));

    const first = await sweep(db, at);
    const second = await sweep(db, new Date(at.getTime() + DAY_MS));

    expect(first).toMatchObject({ challengesExpired: 1, settlementsCreated: 1 });
    expect(second).toMatchObject({ challengesExpired: 0, settlementsCreated: 0 });
    expect(await challengeRow(db, challengeId)).toMatchObject({
      status: "expired",
      terminalAt: at,
    });
    expect(await commandsOf(db, challengeId)).toEqual([
      {
        kind: "release_authorization",
        status: "pending",
        executeAfter: at,
        dedupeKey: `release_authorization:${challengeId}`,
      },
    ]);
    // Expiry is not a miss: no task is resolved and no capture is created.
    expect(first.tasksResolved).toBe(0);
  });

  it("expires a zero deposit challenge the same way, with nothing to release", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db, { depositMinorUnits: 0 });
    const at = new Date(graceEnds(1).getTime() + SECOND_MS);
    await db
      .update(challenges)
      .set({ pausedAt: new Date(at.getTime() - 365 * DAY_MS) })
      .where(eq(challenges.id, challengeId));

    const first = await sweep(db, at);
    const second = await sweep(db, new Date(at.getTime() + DAY_MS));

    expect(first).toMatchObject({ challengesExpired: 1, settlementsCreated: 0 });
    expect(second.challengesExpired).toBe(0);
    expect((await challengeRow(db, challengeId)).status).toBe("expired");
    expect(await commandsOf(db, challengeId)).toEqual([]);
  });

  it("leaves a pause one day short of the year alone", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);
    const at = new Date(graceEnds(1).getTime() + SECOND_MS);
    await db
      .update(challenges)
      .set({ pausedAt: new Date(at.getTime() - 364 * DAY_MS) })
      .where(eq(challenges.id, challengeId));

    const result = await sweep(db, at);

    expect(result.challengesExpired).toBe(0);
    expect((await challengeRow(db, challengeId)).status).toBe("active");
  });
});

describe("two invocations take disjoint work", () => {
  it("passes over a challenge another writer holds and takes the rest", async () => {
    const { db } = testDatabase();
    const held = await insertChallenge(db, { depositMinorUnits: 2000 });
    const free = await insertChallenge(db, { depositMinorUnits: 2000 });
    const at = new Date(graceEnds(1).getTime() + SECOND_MS);
    const other = testDatabase().connect();

    // A second session holds the first challenge's row, as a pause or a
    // recovery arriving at the same instant would. The two sides hand off
    // through promises rather than through sleeps: a sleep long enough to be
    // reliable under load is a sleep this suite pays on every run, and one
    // short enough not to be makes the test a load meter.
    let lockTaken = (): void => {};
    let releaseLock = (): void => {};
    const taken = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const holder = other.db.transaction(async (tx) => {
      await tx
        .select({ id: challenges.id })
        .from(challenges)
        .where(eq(challenges.id, held.challengeId))
        .for("update");
      lockTaken();
      await released;
    });
    await taken;

    const result = await sweep(db, at);
    releaseLock();
    // Awaiting the transaction rather than a signal inside it, so the lock is
    // gone by the time the second invocation runs.
    await holder;

    // The sweep did not wait for the lock, and it did not skip the work it
    // could reach.
    expect(result.tasksMissed).toBe(1);
    expect((await tasksOf(db, free.challengeId))[0]?.status).toBe("missed");
    expect((await tasksOf(db, held.challengeId))[0]?.status).toBe("scheduled");

    // And the next invocation, with the lock gone, takes what was left.
    const next = await sweep(db, new Date(at.getTime() + SECOND_MS));
    expect(next.tasksMissed).toBe(1);
    expect((await tasksOf(db, held.challengeId))[0]?.status).toBe("missed");
  });

  it("resolves each task exactly once when two invocations run at the same time", async () => {
    const { db } = testDatabase();
    const other = testDatabase().connect();
    const accountsWithWork = await Promise.all([
      insertChallenge(db, { depositMinorUnits: 2000 }),
      insertChallenge(db, { depositMinorUnits: 2000 }),
      insertChallenge(db, { depositMinorUnits: 0 }),
    ]);
    const at = new Date(graceEnds(1).getTime() + SECOND_MS);

    const [left, right] = await Promise.all([sweep(db, at), sweep(other.db, at)]);

    // Between them they resolved each challenge's first task exactly once: the
    // total is the count, and no challenge shows two resolutions.
    expect(left.tasksMissed + right.tasksMissed).toBe(3);
    for (const { challengeId } of accountsWithWork) {
      expect((await tasksOf(db, challengeId)).map((task) => task.status)).toEqual([
        "missed",
        "scheduled",
        "scheduled",
      ]);
    }
    // One capture per funded challenge, and none for the zero deposit one.
    expect(await db.select({ id: paymentCommands.id }).from(paymentCommands)).toHaveLength(2);
  });
});

describe("the sweep leaves everything else alone", () => {
  it("ignores tasks of a challenge that is not active", async () => {
    const { db } = testDatabase();
    const { accountId } = await insertChallenge(db, { status: "failed" });
    // A second challenge on the same account, also terminal, so the slot rules
    // are not what the assertion turns on.
    const other = await insertChallengeForAccount(db, accountId, { status: "expired" });

    const result = await sweep(db, new Date(taskDeadline(3).getTime() + DAY_MS));

    expect(result.tasksResolved).toBe(0);
    expect((await tasksOf(db, other)).every((task) => task.status === "scheduled")).toBe(true);
  });

  it("leaves a completed task and its succeeded challenge untouched", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db, { status: "succeeded" });

    const result = await sweep(db, new Date(taskDeadline(3).getTime() + DAY_MS));

    expect(result.tasksResolved).toBe(0);
    expect((await challengeRow(db, challengeId)).status).toBe("succeeded");
  });
});

describe("the settlement command's dedupe key", () => {
  it("is one key per kind per challenge, so a second pass writes nothing", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db, { depositMinorUnits: 2000 });
    const at = new Date(graceEnds(1).getTime() + SECOND_MS);

    await sweep(db, at);

    const [command] = await db
      .select({ dedupeKey: paymentCommands.dedupeKey })
      .from(paymentCommands)
      .where(
        and(eq(paymentCommands.challengeId, challengeId), eq(paymentCommands.kind, "capture")),
      );
    expect(command?.dedupeKey).toBe(`capture:${challengeId}`);
  });
});
