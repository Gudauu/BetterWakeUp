/**
 * The pending completion store, run against a real SQLite engine.
 *
 * The statements under test are the ones the app ships: only the driver
 * differs, so a mistake in the schema or in a guarded update fails here.
 */

import type { MovementObservation } from "@betterwakeup/contract";
import type { SqliteDatabase } from "../src/completions/sqlite.ts";
import {
  openPendingCompletionStore,
  type PendingCompletionInput,
  type PendingCompletionStore,
} from "../src/completions/store.ts";
import { createMemoryDatabase, createTestDatabaseFile } from "./support/node-sqlite.ts";

const OBSERVATION: MovementObservation = {
  startedAt: "2026-03-01T14:00:00.000Z",
  endedAt: "2026-03-01T14:04:00.000Z",
  steps: 220,
  provenance: "live-foreground",
  source: "expo-pedometer-ios",
};

const INPUT: PendingCompletionInput = {
  challengeId: "11111111-1111-4111-8111-111111111111",
  taskId: "22222222-2222-4222-8222-222222222222",
  completedAt: "2026-03-01T14:04:00.000Z",
  observation: OBSERVATION,
  appVersion: "1.2.3",
  verificationPolicyVersion: "live-foreground-steps.1",
};

function ids(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `00000000-0000-4000-8000-00000000000${next}`;
  };
}

async function openStore(database: SqliteDatabase): Promise<PendingCompletionStore> {
  return openPendingCompletionStore({ owner: "account-1", database, newRecordId: ids() });
}

describe("pending completion store", () => {
  let database: SqliteDatabase;
  let store: PendingCompletionStore;

  beforeEach(async () => {
    database = createMemoryDatabase();
    store = await openStore(database);
  });

  afterEach(async () => {
    await store.close();
  });

  it("stores every field the architecture requires and starts pending", async () => {
    const record = await store.record(INPUT);

    expect(record).toMatchObject({
      challengeId: INPUT.challengeId,
      taskId: INPUT.taskId,
      completedAt: INPUT.completedAt,
      observation: OBSERVATION,
      appVersion: "1.2.3",
      verificationPolicyVersion: "live-foreground-steps.1",
      status: "pending",
      attempts: 0,
      lastErrorCode: null,
    });
    expect(record.id).toHaveLength(36);
    expect(await store.listPending()).toEqual([record]);
  });

  it("removes an acknowledged record", async () => {
    const record = await store.record(INPUT);

    await store.markAcknowledged(record.id);

    expect(await store.list()).toEqual([]);
  });

  it("throws everything away when the account the records belong to is deleted", async () => {
    const pending = await store.record(INPUT);
    const refused = await store.record(INPUT);
    await store.markRejected(refused.id, { code: "task_not_found", message: "No such task." });

    await store.discardAll();

    // The rejected one goes too: it is a refusal about a task that no longer
    // exists, and there is nobody left to act on it.
    expect(await store.list()).toEqual([]);
    expect(pending.id).not.toEqual(refused.id);
  });

  it("retains a rejected record, surfaces it, and stops offering it for retry", async () => {
    const record = await store.record(INPUT);

    await store.markRejected(record.id, {
      code: "task_already_resolved",
      message: "That task is already resolved.",
    });

    expect(await store.listPending()).toEqual([]);
    expect(await store.listRejected()).toMatchObject([
      { id: record.id, status: "rejected", attempts: 1, lastErrorCode: "task_already_resolved" },
    ]);
  });

  it("keeps a failed attempt pending and counts it", async () => {
    const record = await store.record(INPUT);

    await store.noteAttemptFailed(record.id, { code: "internal_error", message: "no network" });
    await store.noteAttemptFailed(record.id, { code: "internal_error", message: "no network" });

    expect(await store.listPending()).toMatchObject([
      { id: record.id, status: "pending", attempts: 2, lastErrorMessage: "no network" },
    ]);
  });

  it("does not return a rejected record to the retry set when a late attempt fails", async () => {
    const record = await store.record(INPUT);
    await store.markRejected(record.id, { code: "deadline_passed", message: "too late" });

    await store.noteAttemptFailed(record.id, { code: "internal_error", message: "no network" });

    expect(await store.listPending()).toEqual([]);
    expect(await store.listRejected()).toMatchObject([
      { id: record.id, attempts: 1, lastErrorCode: "deadline_passed" },
    ]);
  });

  it("reports a stored observation that no longer parses as absent rather than as itself", async () => {
    const record = await store.record(INPUT);
    await database.runAsync("UPDATE pending_completions SET observation = ? WHERE id = ?", [
      '{"steps":-1}',
      record.id,
    ]);

    // Still pending on disk: what to do about an unsendable record is the
    // sync pass's decision, and `null` is what tells it there is one.
    expect(await store.listPending()).toMatchObject([{ id: record.id, observation: null }]);
  });

  it("holds several records for one task independently", async () => {
    const first = await store.record(INPUT);
    const second = await store.record(INPUT);

    await store.markRejected(first.id, { code: "step_target_not_met", message: "not enough" });

    expect(await store.listPending()).toMatchObject([{ id: second.id }]);
    expect(await store.listRejected()).toMatchObject([{ id: first.id }]);
  });

  it("writes down whether the last failure was an answer from the server", async () => {
    const offline = await store.record(INPUT);
    const answered = await store.record(INPUT);

    await store.noteAttemptFailed(offline.id, {
      code: "internal_error",
      message: "no network",
      reachedServer: false,
    });
    await store.noteAttemptFailed(answered.id, {
      code: "internal_error",
      message: "server broke",
      reachedServer: true,
    });

    expect(await store.listPending()).toMatchObject([
      { id: offline.id, lastErrorReachedServer: false },
      { id: answered.id, lastErrorReachedServer: true },
    ]);
  });

  it("says nothing about a failure written down without it", async () => {
    const record = await store.record(INPUT);

    await store.noteAttemptFailed(record.id, { code: "internal_error", message: "no network" });

    expect(await store.listPending()).toMatchObject([
      { id: record.id, lastErrorReachedServer: null },
    ]);
  });

  it("opens over an existing database without disturbing what is stored", async () => {
    const record = await store.record(INPUT);

    const reopened = await openPendingCompletionStore({ owner: "account-1", database });

    expect(await reopened.list()).toMatchObject([{ id: record.id, status: "pending" }]);
  });
});

/** Version 1's table, before failures or records named their account. */
const VERSION_ONE = `
CREATE TABLE pending_completions (
  id TEXT PRIMARY KEY NOT NULL,
  challenge_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  observation TEXT NOT NULL,
  app_version TEXT NOT NULL,
  verification_policy_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'rejected')),
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error_message TEXT
);
`;

describe("a table an older version of the app created", () => {
  it("keeps the walk it was holding and takes the columns it was missing", async () => {
    const database = createMemoryDatabase();
    await database.execAsync(VERSION_ONE);
    await database.runAsync(
      `INSERT INTO pending_completions (
         id, challenge_id, task_id, completed_at, observation, app_version,
         verification_policy_version, status, created_at, attempts, last_error_code
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 3, 'internal_error')`,
      [
        "00000000-0000-4000-8000-00000000000a",
        INPUT.challengeId,
        INPUT.taskId,
        INPUT.completedAt,
        JSON.stringify(OBSERVATION),
        INPUT.appVersion,
        INPUT.verificationPolicyVersion,
        INPUT.completedAt,
      ],
    );

    const store = await openPendingCompletionStore({
      owner: "account-1",
      database,
      newRecordId: ids(),
    });

    // The walk survives, and the app does not invent an answer about a failure
    // that happened before it was recording one.
    expect(await store.listPending()).toMatchObject([
      { attempts: 3, observation: OBSERVATION, lastErrorReachedServer: null },
    ]);

    // Both columns are really there: a new record belongs to this account, and
    // its next failure can record whether the server answered.
    const record = await store.record(INPUT);
    await store.noteAttemptFailed(record.id, {
      code: "internal_error",
      message: "no network",
      reachedServer: false,
    });
    expect(await store.listPending()).toMatchObject([
      { lastErrorReachedServer: null },
      { id: record.id, lastErrorReachedServer: false },
    ]);
    await store.close();
  });

  it("keeps the stored owner when another account opens the upgraded table first", async () => {
    const database = createMemoryDatabase();
    await database.execAsync(`${VERSION_ONE}
      CREATE TABLE store_owner (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        account_id TEXT NOT NULL
      );
      INSERT INTO store_owner (id, account_id) VALUES (1, 'account-1');
    `);
    await database.runAsync(
      `INSERT INTO pending_completions (
         id, challenge_id, task_id, completed_at, observation, app_version,
         verification_policy_version, status, created_at, attempts
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0)`,
      [
        "00000000-0000-4000-8000-00000000000a",
        INPUT.challengeId,
        INPUT.taskId,
        INPUT.completedAt,
        JSON.stringify(OBSERVATION),
        INPUT.appVersion,
        INPUT.verificationPolicyVersion,
        INPUT.completedAt,
      ],
    );

    const second = await openPendingCompletionStore({ owner: "account-2", database });
    expect(await second.list()).toEqual([]);

    // The row belonged to the account stored by the previous version. The
    // account that happened to open the upgraded app first cannot adopt it.
    const first = await openPendingCompletionStore({ owner: "account-1", database });
    expect(await first.listPending()).toMatchObject([{ observation: OBSERVATION }]);
    await first.close();
  });
});

describe("a phone signed into a second account", () => {
  async function heldByFirstAccount(database: SqliteDatabase): Promise<void> {
    const first = await openPendingCompletionStore({
      owner: "account-1",
      database,
      newRecordId: ids(),
    });
    const walked = await first.record(INPUT);
    const refused = await first.record({
      ...INPUT,
      taskId: "33333333-3333-4333-8333-333333333333",
    });
    await first.markRejected(refused.id, { code: "not_found", message: "no such task" });
    expect(await first.list()).toHaveLength(2);
    expect(walked.status).toBe("pending");
    // Not closed: one in-memory database stands in for the file the app
    // reopens, and closing the handle would take the data with it.
  }

  it("starts empty rather than sending one person's walks with another's session", async () => {
    const database = createMemoryDatabase();
    await heldByFirstAccount(database);

    const second = await openPendingCompletionStore({ owner: "account-2", database });

    // The refusal goes with the walk: it is an answer about a task the new
    // account cannot see, and reporting it would tell them they were turned
    // away from a morning they never walked.
    expect(await second.list()).toEqual([]);
    await second.close();
  });

  it("keeps the first account's walks aside when that account returns", async () => {
    const database = createMemoryDatabase();
    await heldByFirstAccount(database);

    const second = await openPendingCompletionStore({ owner: "account-2", database });
    expect(await second.list()).toEqual([]);

    const again = await openPendingCompletionStore({ owner: "account-1", database });

    // Signing into another account must isolate these records, not destroy
    // them. The first account may return while its saved walk can still count.
    expect(await again.list()).toHaveLength(2);
    await again.close();
  });

  it("keeps both accounts isolated until each one returns", async () => {
    const database = createMemoryDatabase();
    await heldByFirstAccount(database);

    const second = await openPendingCompletionStore({
      owner: "account-2",
      database,
      newRecordId: () => "00000000-0000-4000-8000-00000000000b",
    });
    const secondWalk = await second.record({
      ...INPUT,
      taskId: "44444444-4444-4444-8444-444444444444",
    });
    expect(await second.list()).toMatchObject([{ id: secondWalk.id }]);

    const first = await openPendingCompletionStore({ owner: "account-1", database });
    expect(await first.list()).toHaveLength(2);
    await first.discardAll();
    expect(await first.list()).toEqual([]);

    // Deleting the first account clears only its walks. The second account's
    // record still waits for that account's session.
    expect(await second.list()).toMatchObject([{ id: secondWalk.id }]);
    await second.close();
  });

  it("adopts a database whose owner was never written down", async () => {
    const database = createMemoryDatabase();
    await database.execAsync(VERSION_ONE);
    await database.runAsync(
      `INSERT INTO pending_completions (
         id, challenge_id, task_id, completed_at, observation, app_version,
         verification_policy_version, status, created_at, attempts
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0)`,
      [
        "00000000-0000-4000-8000-00000000000a",
        INPUT.challengeId,
        INPUT.taskId,
        INPUT.completedAt,
        JSON.stringify(OBSERVATION),
        INPUT.appVersion,
        INPUT.verificationPolicyVersion,
        INPUT.completedAt,
      ],
    );

    const updated = await openPendingCompletionStore({ owner: "account-1", database });
    expect(await updated.list()).toHaveLength(1);

    const other = await openPendingCompletionStore({ owner: "account-2", database });
    expect(await other.list()).toEqual([]);

    // Account changes isolate adopted records too. They do not erase them.
    const returned = await openPendingCompletionStore({ owner: "account-1", database });
    expect(await returned.list()).toHaveLength(1);
    await returned.close();
  });
});

describe("pending completion store on disk", () => {
  it("keeps a record across a process that never came back", async () => {
    const file = createTestDatabaseFile();
    try {
      const first = await openPendingCompletionStore({
        owner: "account-1",
        database: file.open(),
        newRecordId: ids(),
      });
      const record = await first.record(INPUT);
      // No acknowledgment, no clean shutdown: the app was killed here.
      await first.close();

      const relaunched = await openPendingCompletionStore({
        owner: "account-1",
        database: file.open(),
      });

      expect(await relaunched.listPending()).toMatchObject([
        { id: record.id, taskId: INPUT.taskId, observation: OBSERVATION, status: "pending" },
      ]);
      await relaunched.close();
    } finally {
      file.remove();
    }
  });
});
