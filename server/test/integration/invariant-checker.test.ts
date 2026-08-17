/**
 * The checker that issue 26's concurrency suite asserts with, checked itself.
 *
 * A whole-database invariant check is only worth having if it fires, and
 * nothing in a passing concurrency run distinguishes a working check from one
 * whose query can never return a row. So each rule is broken here on purpose
 * and the checker is asked whether it noticed.
 *
 * Breaking them means getting past the schema, which refuses every one of these
 * writes: `session_replication_role = replica` suspends the triggers, and the
 * four rules carried by a unique index or a check constraint have that object
 * dropped. Both happen inside a transaction that is rolled back, so the
 * suspension never outlives the test and the database is never left broken.
 */

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { Database } from "../../src/db/index.ts";
import { scheduledTasks } from "../../src/db/schema.ts";
import { insertChallenge } from "../support/challenge-fixtures.ts";
import { checkInvariants, invariantNames } from "../support/invariants.ts";
import { useTestDatabase } from "../support/postgres.ts";

const testDatabase = useTestDatabase();

interface Arranged {
  readonly accountId: string;
  readonly challengeId: string;
  readonly taskIds: readonly string[];
}

async function arrange(db: Database): Promise<Arranged> {
  const { accountId, challengeId } = await insertChallenge(db, { depositMinorUnits: 2000 });
  const tasks = await db
    .select({ id: scheduledTasks.id })
    .from(scheduledTasks)
    .orderBy(scheduledTasks.sequence);
  return { accountId, challengeId, taskIds: tasks.map((task) => task.id) };
}

/**
 * Runs `break` with the schema's enforcement suspended and reports which
 * invariants the checker then finds broken, rolling everything back.
 */
async function violationsAfter(
  db: Database,
  breakIt: (tx: Parameters<Parameters<Database["transaction"]>[0]>[0]) => Promise<void>,
): Promise<readonly string[]> {
  const found: string[] = [];
  const rollback = new Error("rolled back on purpose");
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await breakIt(tx);
      for (const violation of await checkInvariants(tx)) {
        found.push(violation.invariant);
      }
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  return found;
}

describe("a database nothing has broken", () => {
  it("satisfies every invariant, and the fixtures are a state the checker accepts", async () => {
    const { db } = testDatabase();
    await arrange(db);
    expect(await checkInvariants(db)).toEqual([]);
  });

  it("checks every invariant the architecture lists", () => {
    // The list is the architecture's own, so a rule added there without a check
    // here is a visible omission rather than a silent one.
    expect(invariantNames()).toEqual([
      "one active challenge per account",
      "one completion result per scheduled task",
      "one terminal outcome per scheduled task, missed supersedable by forgiven once",
      "one terminal outcome per challenge",
      "task rows in scheduled or completed status equal the required count while active",
      "Emergency Recovery is consumed at most once per account",
      "a challenge succeeds only after its required completion count is reached",
      "ledger entries balance to zero, per transaction",
      "ledger entries for a challenge balance to zero",
    ]);
  });
});

describe("each invariant, broken on purpose", () => {
  it("finds a second open challenge under one account", async () => {
    const { db } = testDatabase();
    const arranged = await arrange(db);

    const found = await violationsAfter(db, async (tx) => {
      await tx.execute(sql`drop index challenges_open_per_account_key`);
      await tx.execute(sql`
        insert into challenges (
          account_id, status, required_task_count, step_target, no_regret_minutes,
          time_zone, deposit_minor_units, policy_version, projected_end_date, activated_at
        )
        select account_id, 'active', required_task_count, step_target, no_regret_minutes,
          time_zone, deposit_minor_units, policy_version, projected_end_date, activated_at
        from challenges where id = ${arranged.challengeId}
      `);
    });

    expect(found).toContain("one active challenge per account");
  });

  it("finds a second completion result under one task", async () => {
    const { db } = testDatabase();
    const arranged = await arrange(db);

    const found = await violationsAfter(db, async (tx) => {
      await tx.execute(sql`drop index task_completions_task_key`);
      for (let index = 0; index < 2; index += 1) {
        await tx.execute(sql`
          insert into task_completions (
            task_id, completed_at, observation_started_at, observation_ended_at,
            steps, provenance, source, app_version, verification_policy_version
          ) values (
            ${arranged.taskIds[0]}, now(), now(), now(),
            600, 'live-foreground', 'expo-pedometer-ios', '1.0.0', 'steps-v1'
          )
        `);
      }
    });

    expect(found).toContain("one completion result per scheduled task");
  });

  it("finds a task carrying the instants of two outcomes", async () => {
    const { db } = testDatabase();
    const arranged = await arrange(db);

    const found = await violationsAfter(db, async (tx) => {
      await tx.execute(
        sql`alter table scheduled_tasks drop constraint scheduled_tasks_missed_status_has_instant`,
      );
      await tx.execute(sql`
        update scheduled_tasks
        set status = 'completed', acknowledged_at = now(), missed_at = now()
        where id = ${arranged.taskIds[0]}
      `);
    });

    expect(found).toContain(
      "one terminal outcome per scheduled task, missed supersedable by forgiven once",
    );
  });

  it("finds a challenge with an outcome instant and no outcome", async () => {
    const { db } = testDatabase();
    const arranged = await arrange(db);

    const found = await violationsAfter(db, async (tx) => {
      await tx.execute(
        sql`alter table challenges drop constraint challenges_terminal_status_has_instant`,
      );
      await tx.execute(
        sql`update challenges set terminal_at = now() where id = ${arranged.challengeId}`,
      );
    });

    expect(found).toContain("one terminal outcome per challenge");
  });

  it("finds an active challenge short of its required task count", async () => {
    const { db } = testDatabase();
    const arranged = await arrange(db);

    const found = await violationsAfter(db, async (tx) => {
      await tx.execute(sql`delete from scheduled_tasks where id = ${arranged.taskIds[0]}`);
    });

    expect(found).toContain(
      "task rows in scheduled or completed status equal the required count while active",
    );
  });

  it("finds an account that forgave two tasks on one lifetime allowance", async () => {
    const { db } = testDatabase();
    const arranged = await arrange(db);

    const found = await violationsAfter(db, async (tx) => {
      await tx.execute(sql`
        update accounts set emergency_recovery_consumed_at = now() where id = ${arranged.accountId}
      `);
      await tx.execute(sql`
        update scheduled_tasks
        set status = 'forgiven', missed_at = now(), forgiven_at = now()
        where id in (${arranged.taskIds[0]}, ${arranged.taskIds[1]})
      `);
    });

    expect(found).toContain("Emergency Recovery is consumed at most once per account");
  });

  it("finds a forgiven task on an account that never spent its allowance", async () => {
    const { db } = testDatabase();
    const arranged = await arrange(db);

    const found = await violationsAfter(db, async (tx) => {
      await tx.execute(sql`
        update scheduled_tasks
        set status = 'forgiven', missed_at = now(), forgiven_at = now()
        where id = ${arranged.taskIds[0]}
      `);
    });

    expect(found).toContain("Emergency Recovery is consumed at most once per account");
  });

  it("finds a challenge that succeeded without its required completions", async () => {
    const { db } = testDatabase();
    const arranged = await arrange(db);

    const found = await violationsAfter(db, async (tx) => {
      await tx.execute(sql`
        update challenges set status = 'succeeded', terminal_at = now()
        where id = ${arranged.challengeId}
      `);
    });

    expect(found).toContain(
      "a challenge succeeds only after its required completion count is reached",
    );
  });

  it("finds a ledger movement whose entries do not balance", async () => {
    const { db } = testDatabase();
    const arranged = await arrange(db);

    const found = await violationsAfter(db, async (tx) => {
      await tx.execute(sql`
        with movement as (
          insert into ledger_transactions (challenge_id, account_id, kind, occurred_at)
          values (${arranged.challengeId}, ${arranged.accountId}, 'deposit_authorized', now())
          returning id
        )
        insert into ledger_entries (transaction_id, ledger_account, amount_minor_units)
        select id, 'user_commitment', 2000 from movement
      `);
    });

    expect(found).toContain("ledger entries balance to zero, per transaction");
    expect(found).toContain("ledger entries for a challenge balance to zero");
  });

  it("finds a ledger movement with no entries under it at all", async () => {
    const { db } = testDatabase();
    const arranged = await arrange(db);

    const found = await violationsAfter(db, async (tx) => {
      await tx.execute(sql`
        insert into ledger_transactions (challenge_id, account_id, kind, occurred_at)
        values (${arranged.challengeId}, ${arranged.accountId}, 'deposit_authorized', now())
      `);
    });

    expect(found).toContain("ledger entries balance to zero, per transaction");
  });
});
