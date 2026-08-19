/**
 * Proves the harness itself: migrations reach a container database, a
 * transaction rolls back, `FOR UPDATE SKIP LOCKED` hands two sessions disjoint
 * work, and one test's writes are invisible to the next.
 *
 * The sweep in issue 23 rests on exactly this locking behaviour, so it is worth
 * knowing the harness can observe it before anything depends on it.
 */

import { sql, TransactionRollbackError } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { type Database, executeRows } from "../../src/db/index.ts";
import { useTestDatabase } from "../support/postgres.ts";

const testDatabase = useTestDatabase();

/**
 * Stands in for a table of claimable work. Issue 7 brings the real one; the
 * harness must be demonstrable before any schema exists.
 */
async function createJobsTable(db: Database): Promise<void> {
  await db.execute(sql`create table jobs (id integer primary key, claimed_by text)`);
  await db.execute(sql`insert into jobs (id) values (1), (2)`);
}

/** Claims the first unlocked job, leaving the transaction holding the lock. */
function claimOneJob(executor: Database): Promise<{ id: number }[]> {
  return executeRows<{ id: number }>(
    executor,
    sql`select id from jobs order by id for update skip locked limit 1`,
  );
}

/** Runs `use` inside a transaction that is always rolled back. */
async function inRolledBackTransaction<T>(db: Database, use: (tx: Database) => Promise<T>) {
  let result: T | undefined;
  let ran = false;
  try {
    await db.transaction(async (tx) => {
      result = await use(tx as unknown as Database);
      ran = true;
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
  expect(ran).toBe(true);
  return result as T;
}

describe("database harness", () => {
  it("applies migrations to every test database", async () => {
    const rows = await executeRows<{ exists: boolean }>(
      testDatabase().db,
      sql`select exists (
        select 1 from information_schema.tables
        where table_schema = 'drizzle' and table_name = '__drizzle_migrations'
      ) as exists`,
    );
    expect(rows[0]?.exists).toBe(true);
  });

  it("rolls a transaction back", async () => {
    const { db } = testDatabase();
    await createJobsTable(db);

    await inRolledBackTransaction(db, async (tx) => {
      await tx.execute(sql`insert into jobs (id) values (3)`);
      const inside = await executeRows<{ count: string }>(tx, sql`select count(*) from jobs`);
      expect(inside[0]?.count).toBe("3");
    });

    const after = await executeRows<{ count: string }>(db, sql`select count(*) from jobs`);
    expect(after[0]?.count).toBe("2");
  });

  it("hands two concurrent sessions disjoint rows with FOR UPDATE SKIP LOCKED", async () => {
    const fixture = testDatabase();
    await createJobsTable(fixture.db);
    const second = fixture.connect();

    const claims = await inRolledBackTransaction(fixture.db, async (first) => {
      const firstClaim = await claimOneJob(first);
      const secondClaim = await inRolledBackTransaction(second.db, (other) => claimOneJob(other));
      return { firstClaim, secondClaim };
    });

    expect(claims.firstClaim.map((row) => row.id)).toEqual([1]);
    // The second session skips the row the first holds rather than blocking on it.
    expect(claims.secondClaim.map((row) => row.id)).toEqual([2]);

    const remaining = await executeRows<{ id: number; claimed_by: string | null }>(
      fixture.db,
      sql`select id, claimed_by from jobs order by id`,
    );
    expect(remaining).toEqual([
      { id: 1, claimed_by: null },
      { id: 2, claimed_by: null },
    ]);
  });

  describe("per-test isolation", () => {
    beforeEach(async () => {
      await createJobsTable(testDatabase().db);
    });

    it("creates the fixture table", async () => {
      const rows = await executeRows<{ count: string }>(
        testDatabase().db,
        sql`select count(*) from jobs`,
      );
      expect(rows[0]?.count).toBe("2");
    });

    it("does not see the previous test's rows", async () => {
      await testDatabase().db.execute(sql`insert into jobs (id) values (99)`);
      const rows = await executeRows<{ count: string }>(
        testDatabase().db,
        sql`select count(*) from jobs`,
      );
      // Three, not four: the previous test's insert went to a database that no
      // longer exists.
      expect(rows[0]?.count).toBe("3");
    });
  });
});

/**
 * A connection nobody is using can still fail: the database restarts, an
 * administrator terminates the backend, a proxy drops the socket. Node's
 * EventEmitter throws when an `error` arrives with nobody listening, so a pool
 * with no handler takes the whole process down for a socket no request was
 * holding - on Lambda, the container serving the next request.
 */
describe("a pooled connection that dies while idle", () => {
  it("is survived, and the next query opens a new one", async () => {
    const test = testDatabase();
    // Opens the pooled connection and then leaves it idle.
    await test.db.execute(sql`select 1`);

    // A second session plays the administrator, so the kill arrives from
    // outside the pool exactly as a restart would.
    const killer = test.connect();
    await killer.db.execute(
      sql`select pg_terminate_backend(pid) from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid()`,
    );
    // The socket error reaches the pool on a later tick than the kill.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const rows = await executeRows<{ ok: number }>(test.db, sql`select 1 as ok`);
    // The harness closes what `connect()` handed out, so this one is not
    // closed here: ending a pool twice is an error in its own right.
    expect(rows[0]?.ok).toBe(1);
  });
});
