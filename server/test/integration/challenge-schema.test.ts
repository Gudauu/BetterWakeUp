/**
 * Issue 7's acceptance boundary: the database rejects a direct violating write.
 *
 * Every test here writes through Drizzle with no service layer in between, so
 * a pass says the constraint exists rather than that some function remembered
 * to check. The invariants under "Challenge state" in the architecture are the
 * list this suite works through; issue 9 extends it with raw SQL attempts on
 * the rest.
 */

import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { executeRows } from "../../src/db/index.ts";
import {
  challengeScheduleDays,
  challenges,
  scheduledTasks,
  taskCompletions,
} from "../../src/db/schema.ts";
import {
  insertAccount,
  insertChallenge,
  insertChallengeForAccount,
  taskDeadline,
  taskValues,
} from "../support/challenge-fixtures.ts";
import { useTestDatabase } from "../support/postgres.ts";
import {
  CHECK_VIOLATION,
  expectSqlState,
  INTEGRITY_CONSTRAINT_VIOLATION,
  UNIQUE_VIOLATION,
} from "../support/sql-errors.ts";

const testDatabase = useTestDatabase();

describe("one active challenge per account", () => {
  it("rejects a second open challenge, whatever its status", async () => {
    const { db } = testDatabase();
    const { accountId } = await insertChallenge(db);

    await expectSqlState(UNIQUE_VIOLATION, () => insertChallengeForAccount(db, accountId));
    // `recovery_pending` still holds the slot: that challenge is running and
    // may come back to `active`.
    await expectSqlState(UNIQUE_VIOLATION, () =>
      insertChallengeForAccount(db, accountId, { status: "recovery_pending", taskCount: 2 }),
    );
  });

  it("gives the slot back when the challenge reaches a terminal status", async () => {
    const { db } = testDatabase();
    const { accountId, challengeId } = await insertChallenge(db);

    await db
      .update(challenges)
      .set({ status: "expired", terminalAt: new Date() })
      .where(eq(challenges.id, challengeId));

    // Every terminal status drops out of the partial index, which is what
    // guarantees a forgotten paused challenge cannot lock an account out.
    const second = await insertChallengeForAccount(db, accountId);
    expect(second).not.toBe(challengeId);
  });
});

describe("challenge terminal outcomes", () => {
  it("rejects a terminal status with no instant, and an instant with no terminal status", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);

    await expectSqlState(CHECK_VIOLATION, () =>
      db.update(challenges).set({ status: "failed" }).where(eq(challenges.id, challengeId)),
    );
    await expectSqlState(CHECK_VIOLATION, () =>
      db.update(challenges).set({ terminalAt: new Date() }).where(eq(challenges.id, challengeId)),
    );
  });

  it("rejects recovery on a zero deposit challenge", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);

    // A lifetime allowance must not be consumable on a challenge that costs
    // nothing to fail, so `recovery_pending` is unreachable without a deposit.
    await expectSqlState(CHECK_VIOLATION, () =>
      insertChallengeForAccount(db, accountId, {
        depositMinorUnits: 0,
        status: "recovery_pending",
      }),
    );
  });

  it("rejects a deposit below the funded minimum", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);

    await expectSqlState(CHECK_VIOLATION, () =>
      insertChallengeForAccount(db, accountId, { depositMinorUnits: 99 }),
    );
  });
});

describe("weekly schedule", () => {
  it("rejects the same weekday twice in one schedule", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);

    await expectSqlState(UNIQUE_VIOLATION, () =>
      db
        .insert(challengeScheduleDays)
        .values({ challengeId, weekday: "monday", deadlineLocal: "09:00:00" }),
    );
  });
});

describe("task outcomes", () => {
  it("rejects a status whose outcome instant is missing", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);
    const target = eq(scheduledTasks.challengeId, challengeId);

    for (const status of ["completed", "skipped", "missed", "forgiven"] as const) {
      await expectSqlState(CHECK_VIOLATION, () =>
        db.update(scheduledTasks).set({ status }).where(target),
      );
    }
  });

  it("keeps the miss a forgiven task supersedes", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);
    const missedAt = taskDeadline(1);

    // Recovery preserves the history rather than deleting it, so `forgiven`
    // without a miss underneath it is not a state the database will hold.
    await expectSqlState(CHECK_VIOLATION, () =>
      db
        .update(scheduledTasks)
        .set({ status: "forgiven", forgivenAt: missedAt })
        .where(eq(scheduledTasks.sequence, 1)),
    );
    await expectSqlState(CHECK_VIOLATION, () =>
      db
        .update(scheduledTasks)
        .set({
          status: "forgiven",
          missedAt,
          forgivenAt: new Date(missedAt.getTime() - 1000),
        })
        .where(eq(scheduledTasks.sequence, 1)),
    );

    // The whole transition, with its replacement task, is accepted.
    await db.transaction(async (tx) => {
      await tx
        .update(scheduledTasks)
        .set({ status: "forgiven", missedAt, forgivenAt: missedAt })
        .where(eq(scheduledTasks.sequence, 1));
      await tx.insert(scheduledTasks).values(taskValues(challengeId, 4));
    });
  });

  it("rejects a pause cutoff after its deadline", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);

    await expectSqlState(CHECK_VIOLATION, () =>
      db
        .update(scheduledTasks)
        .set({ pauseCutoff: new Date(taskDeadline(1).getTime() + 1000) })
        .where(eq(scheduledTasks.challengeId, challengeId)),
    );
  });

  it("rejects two tasks on one date, and two tasks at one ordinal", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);

    await expectSqlState(UNIQUE_VIOLATION, () =>
      db.insert(scheduledTasks).values({ ...taskValues(challengeId, 1), sequence: 9 }),
    );
    await expectSqlState(UNIQUE_VIOLATION, () =>
      db
        .insert(scheduledTasks)
        .values({ ...taskValues(challengeId, 9), sequence: 1, taskDate: "2027-03-01" }),
    );
  });
});

describe("one completion result per scheduled task", () => {
  it("rejects a second completion for the same task", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);
    const [task] = await db
      .select({ id: scheduledTasks.id })
      .from(scheduledTasks)
      .where(eq(scheduledTasks.challengeId, challengeId))
      .limit(1);
    if (task === undefined) {
      throw new Error("the fixture materialized no tasks");
    }

    const completion = {
      taskId: task.id,
      completedAt: taskDeadline(1),
      observationStartedAt: new Date(taskDeadline(1).getTime() - 60_000),
      observationEndedAt: taskDeadline(1),
      steps: 812,
      provenance: "live-foreground",
      source: "expo-pedometer-ios",
      appVersion: "1.0.0",
      verificationPolicyVersion: "2026-01-01",
    } as const;

    await db.insert(taskCompletions).values(completion);
    // A duplicate delivery of the same completion is a database error, not a
    // second row nobody notices.
    await expectSqlState(UNIQUE_VIOLATION, () => db.insert(taskCompletions).values(completion));
  });

  it("rejects an observation that ends before it started", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);
    const [task] = await db
      .select({ id: scheduledTasks.id })
      .from(scheduledTasks)
      .where(eq(scheduledTasks.challengeId, challengeId))
      .limit(1);
    if (task === undefined) {
      throw new Error("the fixture materialized no tasks");
    }

    await expectSqlState(CHECK_VIOLATION, () =>
      db.insert(taskCompletions).values({
        taskId: task.id,
        completedAt: taskDeadline(1),
        observationStartedAt: taskDeadline(1),
        observationEndedAt: new Date(taskDeadline(1).getTime() - 60_000),
        steps: 812,
        provenance: "live-foreground",
        source: "expo-pedometer-ios",
        appVersion: "1.0.0",
        verificationPolicyVersion: "2026-01-01",
      }),
    );
  });
});

describe("the task count trigger", () => {
  it("rejects an active challenge materialized short of its required count", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);

    await expectSqlState(INTEGRITY_CONSTRAINT_VIOLATION, () =>
      insertChallengeForAccount(db, accountId, { requiredTaskCount: 3, taskCount: 2 }),
    );
  });

  it("rejects a consumed task with no replacement, and accepts one with", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);

    // A skip without its replacement leaves the challenge one task short of
    // ever reaching its required count.
    await expectSqlState(INTEGRITY_CONSTRAINT_VIOLATION, () =>
      db
        .update(scheduledTasks)
        .set({ status: "skipped", skippedAt: taskDeadline(1) })
        .where(eq(scheduledTasks.sequence, 1)),
    );

    await db.transaction(async (tx) => {
      await tx
        .update(scheduledTasks)
        .set({ status: "skipped", skippedAt: taskDeadline(1) })
        .where(eq(scheduledTasks.sequence, 1));
      await tx.insert(scheduledTasks).values(taskValues(challengeId, 4));
    });

    const live = await db
      .select({ status: scheduledTasks.status })
      .from(scheduledTasks)
      .where(eq(scheduledTasks.challengeId, challengeId));
    expect(live.filter((task) => task.status === "scheduled")).toHaveLength(3);
  });

  it("is deferred, so the count may be wrong between two statements", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);

    // The replacement is inserted before the skip that calls for it. An
    // immediate trigger would reject the first statement; a deferred one only
    // asks whether the transaction as a whole left the count right.
    await db.transaction(async (tx) => {
      await tx.insert(scheduledTasks).values(taskValues(challengeId, 4));
      await tx
        .update(scheduledTasks)
        .set({ status: "skipped", skippedAt: taskDeadline(1) })
        .where(eq(scheduledTasks.sequence, 1));
    });
  });

  it("is scoped to active challenges, so a miss awaiting recovery is allowed", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);

    // A missed task drops the count below the required total by design, and it
    // stays below until the task is forgiven or the challenge fails. The
    // challenge has to leave `active` in the same transaction, which is what
    // the sweep does.
    await db.transaction(async (tx) => {
      await tx
        .update(scheduledTasks)
        .set({ status: "missed", missedAt: taskDeadline(1) })
        .where(eq(scheduledTasks.sequence, 1));
      await tx
        .update(challenges)
        .set({ status: "recovery_pending" })
        .where(eq(challenges.id, challengeId));
    });

    const [challenge] = await db
      .select({ status: challenges.status })
      .from(challenges)
      .where(eq(challenges.id, challengeId));
    expect(challenge?.status).toBe("recovery_pending");
  });

  it("rejects a challenge returning to active while a task is still missed", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);
    await db.transaction(async (tx) => {
      await tx
        .update(scheduledTasks)
        .set({ status: "missed", missedAt: taskDeadline(1) })
        .where(eq(scheduledTasks.sequence, 1));
      await tx
        .update(challenges)
        .set({ status: "recovery_pending" })
        .where(eq(challenges.id, challengeId));
    });

    // Recovery has to forgive the task and append its replacement in the same
    // commit that returns the challenge to `active`; the status change alone is
    // rejected even though no task row moved.
    await expectSqlState(INTEGRITY_CONSTRAINT_VIOLATION, () =>
      db.update(challenges).set({ status: "active" }).where(eq(challenges.id, challengeId)),
    );
  });

  it("rejects a challenge claiming success short of its required completions", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);

    await expectSqlState(INTEGRITY_CONSTRAINT_VIOLATION, () =>
      db.transaction(async (tx) => {
        await tx
          .update(scheduledTasks)
          .set({ status: "completed", acknowledgedAt: taskDeadline(1) })
          .where(eq(scheduledTasks.sequence, 1));
        await tx
          .update(challenges)
          .set({ status: "succeeded", terminalAt: taskDeadline(1) })
          .where(eq(challenges.id, challengeId));
      }),
    );
  });

  it("accepts a challenge that succeeds with every task completed", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);

    await db.transaction(async (tx) => {
      await tx
        .update(scheduledTasks)
        .set({ status: "completed", acknowledgedAt: taskDeadline(1) })
        .where(eq(scheduledTasks.challengeId, challengeId));
      await tx
        .update(challenges)
        .set({ status: "succeeded", terminalAt: taskDeadline(1) })
        .where(eq(challenges.id, challengeId));
    });

    const [challenge] = await db
      .select({ status: challenges.status })
      .from(challenges)
      .where(eq(challenges.id, challengeId));
    expect(challenge?.status).toBe("succeeded");
  });

  it("lets a challenge and its tasks be deleted together", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);

    // The trigger fires at commit with a challenge that no longer exists, so
    // it has to treat a missing challenge as nothing to check rather than as a
    // count of zero against a required count of three.
    await db.delete(challenges).where(eq(challenges.id, challengeId));

    const remaining = await db.select({ id: scheduledTasks.id }).from(scheduledTasks);
    expect(remaining).toEqual([]);
  });
});

describe("the trigger is a deferred constraint trigger", () => {
  it("is declared DEFERRABLE INITIALLY DEFERRED on both tables", async () => {
    const rows = await executeRows<{
      tgname: string;
      tgdeferrable: boolean;
      tginitdeferred: boolean;
    }>(
      testDatabase().db,
      sql`select tgname, tgdeferrable, tginitdeferred
          from pg_trigger
          where tgname like '%challenge_task_counts%'
          order by tgname`,
    );

    expect(rows).toEqual([
      { tgname: "challenges_challenge_task_counts", tgdeferrable: true, tginitdeferred: true },
      { tgname: "scheduled_tasks_challenge_task_counts", tgdeferrable: true, tginitdeferred: true },
    ]);
  });
});
