/**
 * The invariant assault suite.
 *
 * One section per bullet under "Invariants the database must enforce" in the
 * architecture, each attempting the violation through raw SQL with no Drizzle,
 * no schema module, and no server code anywhere in the path. That restriction
 * is the whole value of the file: the schema suites prove the constraints exist
 * for writes shaped the way the application shapes them, and this one proves
 * they exist for writes nobody designed for.
 *
 * Three of the invariants turned out not to survive that. A `completed` task
 * could be updated to `skipped`, a `succeeded` challenge could go back to
 * `active`, and an account's lifetime Emergency Recovery could be spent twice
 * by overwriting the instant it was spent at. Migration 0005 closes all three,
 * and the tests that found them are the ones marked with `RESTRICT_VIOLATION`.
 */

import { describe, expect, it } from "vitest";

import { useTestDatabase } from "../support/postgres.ts";
import {
  insertAccount,
  insertChallenge,
  insertChallengeForAccount,
  insertTask,
  taskDeadline,
  tasksOf,
} from "../support/raw-challenge.ts";
import { type RawSql, useRawSql } from "../support/raw-sql.ts";
import {
  CHECK_VIOLATION,
  expectSqlState,
  INTEGRITY_CONSTRAINT_VIOLATION,
  RESTRICT_VIOLATION,
  UNIQUE_VIOLATION,
} from "../support/sql-errors.ts";

const testDatabase = useTestDatabase();
const rawSql = useRawSql(testDatabase);

describe("one active challenge per account", () => {
  it("rejects a second open challenge, whichever open status it claims", async () => {
    const sql = rawSql();
    const { accountId } = await insertChallenge(sql);

    await expectSqlState(UNIQUE_VIOLATION, () => insertChallengeForAccount(sql, accountId));
    // `recovery_pending` holds the slot too: that challenge is still running.
    await expectSqlState(UNIQUE_VIOLATION, () =>
      insertChallengeForAccount(sql, accountId, { status: "recovery_pending" }),
    );
  });

  it("rejects a terminal challenge reopened underneath a running one", async () => {
    const sql = rawSql();
    const { accountId } = await insertChallenge(sql, { status: "expired" });
    const running = await insertChallengeForAccount(sql, accountId);

    // Reopening is refused as a transition before the index is ever consulted,
    // so the second challenge is the one the slot rule has to answer for.
    await expectSqlState(RESTRICT_VIOLATION, () =>
      sql.query("update challenges set status = 'active', terminal_at = null where id <> $1", [
        running,
      ]),
    );
  });
});

describe("one completion result per scheduled task", () => {
  it("rejects a second completion for the same task", async () => {
    const sql = rawSql();
    const { challengeId } = await insertChallenge(sql);
    const [task] = await tasksOf(sql, challengeId);
    const taskId = String(task?.id);

    const insertCompletion = async () =>
      await sql.query(
        `insert into task_completions
           (task_id, completed_at, observation_started_at, observation_ended_at, steps,
            provenance, source, app_version, verification_policy_version)
         values ($1, $2, $2, $2, 900, 'live-foreground', 'CMPedometer', '1.0.0', '2026-01-01')`,
        [taskId, taskDeadline(1)],
      );

    await insertCompletion();
    await expectSqlState(UNIQUE_VIOLATION, insertCompletion);
  });
});

describe("one terminal outcome per scheduled task", () => {
  it("rejects a task carrying two outcome instants at once", async () => {
    const sql = rawSql();
    const { challengeId } = await insertChallenge(sql);

    await expectSqlState(CHECK_VIOLATION, () =>
      sql.query(
        `update scheduled_tasks set status = 'completed', acknowledged_at = $2, missed_at = $2
         where challenge_id = $1 and sequence = 1`,
        [challengeId, taskDeadline(1)],
      ),
    );
  });

  it("rejects a completed task being given a different outcome", async () => {
    const sql = rawSql();
    const { challengeId } = await insertChallenge(sql);
    await sql.query(
      `update scheduled_tasks set status = 'completed', acknowledged_at = $2
       where challenge_id = $1 and sequence = 1`,
      [challengeId, taskDeadline(1)],
    );

    await expectSqlState(RESTRICT_VIOLATION, () =>
      sql.query(
        `update scheduled_tasks set status = 'skipped', acknowledged_at = null, skipped_at = $2
         where challenge_id = $1 and sequence = 1`,
        [challengeId, taskDeadline(1)],
      ),
    );
  });

  it("rejects a second forgiveness, by either route", async () => {
    const sql = rawSql();
    const { challengeId } = await insertChallenge(sql, { status: "recovery_pending" });
    const missedAt = taskDeadline(1);
    await sql.query(
      `update scheduled_tasks set status = 'missed', missed_at = $2
       where challenge_id = $1 and sequence = 1`,
      [challengeId, missedAt],
    );
    await sql.transaction(async (tx) => {
      await tx.query(
        `update scheduled_tasks set status = 'forgiven', forgiven_at = $2
         where challenge_id = $1 and sequence = 1`,
        [challengeId, missedAt],
      );
      await tx.query("update challenges set status = 'active' where id = $1", [challengeId]);
      await insertTask(tx, challengeId, 4);
    });

    // Route one: forgive it again in place, which would be a second recovery
    // spent on the same task with only the instant to show for it.
    await expectSqlState(RESTRICT_VIOLATION, () =>
      sql.query(
        `update scheduled_tasks set forgiven_at = $2 where challenge_id = $1 and sequence = 1`,
        [challengeId, new Date(missedAt.getTime() + 1000)],
      ),
    );
    // Route two: put it back to `missed` so it becomes forgivable again.
    await expectSqlState(RESTRICT_VIOLATION, () =>
      sql.query(
        `update scheduled_tasks set status = 'missed', forgiven_at = null
         where challenge_id = $1 and sequence = 1`,
        [challengeId],
      ),
    );
  });
});

describe("one terminal outcome per challenge", () => {
  it("rejects a terminal status with no instant, and an instant with no terminal status", async () => {
    const sql = rawSql();
    const { challengeId } = await insertChallenge(sql);

    await expectSqlState(CHECK_VIOLATION, () =>
      sql.query("update challenges set status = 'failed' where id = $1", [challengeId]),
    );
    await expectSqlState(CHECK_VIOLATION, () =>
      sql.query("update challenges set terminal_at = now() where id = $1", [challengeId]),
    );
  });

  it("rejects a second outcome on a challenge that already reached one", async () => {
    const sql = rawSql();
    const { challengeId } = await insertChallenge(sql, { status: "failed" });

    await expectSqlState(RESTRICT_VIOLATION, () =>
      sql.query("update challenges set status = 'expired' where id = $1", [challengeId]),
    );
    await expectSqlState(RESTRICT_VIOLATION, () =>
      sql.query("update challenges set terminal_at = now() where id = $1", [challengeId]),
    );
  });

  it("rejects a recovery_pending challenge jumping to an outcome recovery cannot reach", async () => {
    const sql = rawSql();
    const { challengeId } = await insertChallenge(sql, { status: "recovery_pending" });

    // The diagram leaves `recovery_pending` for `active` or `failed` only.
    await expectSqlState(RESTRICT_VIOLATION, () =>
      sql.query("update challenges set status = 'succeeded', terminal_at = now() where id = $1", [
        challengeId,
      ]),
    );
  });
});

describe("task rows equal the required count while the challenge is active", () => {
  it("rejects a task deleted out from under an active challenge", async () => {
    const sql = rawSql();
    const { challengeId } = await insertChallenge(sql);

    await expectSqlState(INTEGRITY_CONSTRAINT_VIOLATION, () =>
      sql.transaction(async (tx) => {
        await tx.query("delete from scheduled_tasks where challenge_id = $1 and sequence = 1", [
          challengeId,
        ]);
      }),
    );
  });

  it("rejects an extra task appended with nothing consumed", async () => {
    const sql = rawSql();
    const { challengeId } = await insertChallenge(sql);

    await expectSqlState(INTEGRITY_CONSTRAINT_VIOLATION, () =>
      sql.transaction(async (tx) => {
        await insertTask(tx, challengeId, 4);
      }),
    );
  });

  it("rejects a task consumed with no replacement, and accepts the pair", async () => {
    const sql = rawSql();
    const { challengeId } = await insertChallenge(sql);
    const skip = async (tx: RawSql): Promise<void> => {
      await tx.query(
        `update scheduled_tasks set status = 'skipped', skipped_at = $2
         where challenge_id = $1 and sequence = 1`,
        [challengeId, taskDeadline(1)],
      );
    };

    await expectSqlState(INTEGRITY_CONSTRAINT_VIOLATION, () => sql.transaction(skip));

    // The same transition with its replacement is the shape the sweep writes,
    // and it is only ever balanced at commit, which is why the trigger defers.
    await sql.transaction(async (tx) => {
      await skip(tx);
      await insertTask(tx, challengeId, 4);
    });
    expect(await tasksOf(sql, challengeId)).toHaveLength(4);
  });
});

describe("Emergency Recovery is consumed at most once per account", () => {
  it("accepts the first consumption and refuses to spend it again", async () => {
    const raw = rawSql();
    const accountId = await insertAccount(raw);
    const consumedAt = taskDeadline(1);

    await raw.query("update accounts set emergency_recovery_consumed_at = $2 where id = $1", [
      accountId,
      consumedAt,
    ]);

    // Overwriting the instant is a second lifetime allowance, spent with no
    // record that the first one ever was.
    await expectSqlState(RESTRICT_VIOLATION, () =>
      raw.query("update accounts set emergency_recovery_consumed_at = $2 where id = $1", [
        accountId,
        new Date(consumedAt.getTime() + 86_400_000),
      ]),
    );
    // Clearing it is the same move with an extra step.
    await expectSqlState(RESTRICT_VIOLATION, () =>
      raw.query("update accounts set emergency_recovery_consumed_at = null where id = $1", [
        accountId,
      ]),
    );

    const [row] = await raw.query(
      "select emergency_recovery_consumed_at from accounts where id = $1",
      [accountId],
    );
    expect(row?.emergency_recovery_consumed_at).toEqual(consumedAt);
  });
});

describe("a challenge succeeds only after its required completion count", () => {
  it("rejects success with fewer completions than required", async () => {
    const sql = rawSql();
    const { challengeId } = await insertChallenge(sql, { requiredTaskCount: 3 });

    await expectSqlState(INTEGRITY_CONSTRAINT_VIOLATION, () =>
      sql.transaction(async (tx) => {
        await tx.query(
          `update scheduled_tasks set status = 'completed', acknowledged_at = $2
           where challenge_id = $1 and sequence <= 2`,
          [challengeId, taskDeadline(1)],
        );
        await tx.query(
          "update challenges set status = 'succeeded', terminal_at = $2 where id = $1",
          [challengeId, taskDeadline(3)],
        );
      }),
    );
  });

  it("accepts success once every required task is completed", async () => {
    const sql = rawSql();
    const { challengeId } = await insertChallenge(sql, { requiredTaskCount: 3 });

    await sql.transaction(async (tx) => {
      await tx.query(
        `update scheduled_tasks set status = 'completed', acknowledged_at = $2
         where challenge_id = $1`,
        [challengeId, taskDeadline(1)],
      );
      await tx.query("update challenges set status = 'succeeded', terminal_at = $2 where id = $1", [
        challengeId,
        taskDeadline(3),
      ]);
    });
  });
});

describe("ledger entries balance to zero", () => {
  it("rejects a transaction whose entries do not sum to zero", async () => {
    const sql = rawSql();
    const { accountId, challengeId } = await insertChallenge(sql);

    await expectSqlState(INTEGRITY_CONSTRAINT_VIOLATION, () =>
      sql.transaction(async (tx) => {
        const transactionId = await insertLedgerTransaction(tx, accountId, challengeId);
        await insertLedgerEntry(tx, transactionId, "user_commitment", 2000, "USD");
        await insertLedgerEntry(tx, transactionId, "payment_processor", -1500, "USD");
      }),
    );
  });

  it("rejects a transaction with no entries under it", async () => {
    const sql = rawSql();
    const { accountId, challengeId } = await insertChallenge(sql);

    await expectSqlState(INTEGRITY_CONSTRAINT_VIOLATION, () =>
      sql.transaction(async (tx) => {
        await insertLedgerTransaction(tx, accountId, challengeId);
      }),
    );
  });

  it("rejects two sides that balance only across currencies", async () => {
    const sql = rawSql();
    const { accountId, challengeId } = await insertChallenge(sql);

    await expectSqlState(INTEGRITY_CONSTRAINT_VIOLATION, () =>
      sql.transaction(async (tx) => {
        const transactionId = await insertLedgerTransaction(tx, accountId, challengeId);
        await insertLedgerEntry(tx, transactionId, "user_commitment", 2000, "USD");
        await insertLedgerEntry(tx, transactionId, "payment_processor", -2000, "EUR");
      }),
    );
  });

  it("rejects an entry rewritten to unbalance a settled transaction", async () => {
    const sql = rawSql();
    const { accountId, challengeId } = await insertChallenge(sql);
    let entryId = "";
    await sql.transaction(async (tx) => {
      const transactionId = await insertLedgerTransaction(tx, accountId, challengeId);
      entryId = await insertLedgerEntry(tx, transactionId, "user_commitment", 2000, "USD");
      await insertLedgerEntry(tx, transactionId, "payment_processor", -2000, "USD");
    });

    // Append only: the answer to a wrong entry is another entry.
    await expectSqlState(RESTRICT_VIOLATION, () =>
      sql.query("update ledger_entries set amount_minor_units = 1 where id = $1", [entryId]),
    );
    await expectSqlState(RESTRICT_VIOLATION, () =>
      sql.query("delete from ledger_entries where id = $1", [entryId]),
    );
  });
});

async function insertLedgerTransaction(
  tx: RawSql,
  accountId: string,
  challengeId: string,
): Promise<string> {
  const rows = await tx.query(
    `insert into ledger_transactions (account_id, challenge_id, kind)
     values ($1, $2, 'deposit_authorized') returning id`,
    [accountId, challengeId],
  );
  return String(rows[0]?.id);
}

async function insertLedgerEntry(
  tx: RawSql,
  transactionId: string,
  ledgerAccount: string,
  amountMinorUnits: number,
  currency: string,
): Promise<string> {
  const rows = await tx.query(
    `insert into ledger_entries (transaction_id, ledger_account, amount_minor_units, currency)
     values ($1, $2, $3, $4) returning id`,
    [transactionId, ledgerAccount, amountMinorUnits, currency],
  );
  return String(rows[0]?.id);
}
