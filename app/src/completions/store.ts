/**
 * The pending completion store.
 *
 * A completion is written here before the local check is shown, so the record
 * exists on disk before the user is told anything, and an app killed between
 * the local check and the server's acknowledgment still has the completion on
 * the next launch. The record's own ID is the idempotency key every attempt
 * carries, which is what makes a retry after a crash the same command rather
 * than a second one.
 *
 * Records are independent. There is no queue and no ordering: at most a few
 * records can be pending inside one task window, and a strict queue would let
 * one undeliverable record block every later completion from ever syncing.
 *
 * A record leaves the store by being acknowledged, or with the account it
 * belongs to. A rejected record stays, marked, so the interface can surface it;
 * nothing else deletes anything.
 */

import { type MovementObservation, movementObservation } from "@betterwakeup/contract";
import { randomUUID } from "expo-crypto";
import type { SqliteDatabase, SqliteValue } from "./sqlite.ts";

/**
 * Where a record stands.
 *
 * `pending` is retried on every trigger. `rejected` is never retried silently:
 * the server refused the command in a way a repeat would not change, so the
 * record is kept for the user to see and act on.
 */
export type PendingCompletionStatus = "pending" | "rejected";

export interface PendingCompletionInput {
  readonly challengeId: string;
  readonly taskId: string;
  /** When the device evaluated the step target, by the device's clock. */
  readonly completedAt: string;
  readonly observation: MovementObservation;
  readonly appVersion: string;
  readonly verificationPolicyVersion: string;
}

export interface PendingCompletionRecord {
  /** The record ID, which is also the idempotency key of every attempt. */
  readonly id: string;
  readonly challengeId: string;
  readonly taskId: string;
  readonly completedAt: string;
  /**
   * The stored observation, or `null` when the stored row no longer parses as
   * one. Such a record can never be sent, so the first sync pass that picks it
   * up rejects it: it is surfaced rather than retried or quietly dropped.
   */
  readonly observation: MovementObservation | null;
  readonly appVersion: string;
  readonly verificationPolicyVersion: string;
  readonly status: PendingCompletionStatus;
  readonly createdAt: string;
  /** How many times the app has sent this record and not been acknowledged. */
  readonly attempts: number;
  /** The contract error code of the last failure, for display and for Sentry. */
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  /**
   * Whether the last failure was an answer from the server.
   *
   * `internal_error` is raised both for a request that never left the phone and
   * for a server that could not answer one, so the code alone cannot say which
   * happened, and the advice differs: the first is worth moving for and the
   * second is not. `true` means the server answered, `false` means the request
   * never reached it, and `null` means nothing has failed yet or the failure
   * was written down before this was recorded.
   */
  readonly lastErrorReachedServer: boolean | null;
}

/**
 * What an attempt's failure is written down as.
 *
 * `reachedServer` is omitted only where no request was made at all, so the
 * record honestly says nothing rather than claiming the phone was offline.
 */
export interface PendingCompletionFailure {
  readonly code: string;
  readonly message: string;
  readonly reachedServer?: boolean;
}

export interface PendingCompletionStore {
  /** Write a completion before the local check is displayed. */
  record(input: PendingCompletionInput): Promise<PendingCompletionRecord>;
  /** Everything held, in the order recorded, whatever its state. */
  list(): Promise<PendingCompletionRecord[]>;
  /** The records a sync attempts. */
  listPending(): Promise<PendingCompletionRecord[]>;
  /** The records the interface must surface as needing action. */
  listRejected(): Promise<PendingCompletionRecord[]>;
  /** The server stored this completion. The record is done and goes away. */
  markAcknowledged(id: string): Promise<void>;
  /** The server refused in a way a repeat would not change. */
  markRejected(id: string, error: PendingCompletionFailure): Promise<void>;
  /** An attempt failed in a way that may yet succeed. The record stays pending. */
  noteAttemptFailed(id: string, error: PendingCompletionFailure): Promise<void>;
  /**
   * Throw everything away, because the account these records belong to no
   * longer exists. Every record names a challenge and a task on the server, so
   * after an account deletion none of them can ever be sent: keeping them would
   * leave one person's walks on the phone for whoever signs in next.
   */
  discardAll(): Promise<void>;
  close(): Promise<void>;
}

export interface PendingCompletionStoreOptions {
  readonly database: SqliteDatabase;
  readonly newRecordId?: () => string;
  readonly now?: () => Date;
}

/**
 * The table, as a phone that has never held a record gets it.
 *
 * `IF NOT EXISTS` covers a fresh install. A phone that already holds records
 * was created from an earlier shape and keeps it, so every column added since
 * version 1 is listed in `ADDED_COLUMNS` below and applied on open rather than
 * being silently redefined here.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS pending_completions (
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
  last_error_message TEXT,
  last_error_reached_server INTEGER CHECK (last_error_reached_server IN (0, 1))
);
`;

/**
 * The columns added after version 1, by name and by definition.
 *
 * Every one of them has to be nullable: the rows already on the phone get the
 * column with nothing in it, and a record whose failure was written down before
 * the column existed genuinely does not know the answer. Nothing here rewrites
 * a row, so a record already on the phone is never given a fact about itself
 * that was not observed.
 */
const ADDED_COLUMNS: readonly { readonly name: string; readonly definition: string }[] = [
  {
    name: "last_error_reached_server",
    definition: "INTEGER CHECK (last_error_reached_server IN (0, 1))",
  },
];

interface Row {
  id: string;
  challenge_id: string;
  task_id: string;
  completed_at: string;
  observation: string;
  app_version: string;
  verification_policy_version: string;
  status: string;
  created_at: string;
  attempts: number;
  last_error_code: string | null;
  last_error_message: string | null;
  last_error_reached_server: number | null;
}

const SELECT_COLUMNS =
  "id, challenge_id, task_id, completed_at, observation, app_version, " +
  "verification_policy_version, status, created_at, attempts, last_error_code, " +
  "last_error_message, last_error_reached_server";

function toRecord(row: Row): PendingCompletionRecord {
  return {
    id: row.id,
    challengeId: row.challenge_id,
    taskId: row.task_id,
    completedAt: row.completed_at,
    // `null` when the stored row no longer reads as an observation. The record
    // is still reported with the state it is stored in: the store says what is
    // on disk, and the sync pass is what turns an unsendable record into a
    // rejected one, so the refusal is written down exactly once and by the
    // same code path every other refusal takes.
    observation: parseObservation(row.observation),
    appVersion: row.app_version,
    verificationPolicyVersion: row.verification_policy_version,
    status: row.status === "rejected" ? "rejected" : "pending",
    createdAt: row.created_at,
    attempts: row.attempts,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    lastErrorReachedServer:
      row.last_error_reached_server === null ? null : row.last_error_reached_server === 1,
  };
}

function reachedServerValue(error: PendingCompletionFailure): SqliteValue {
  return error.reachedServer === undefined ? null : error.reachedServer ? 1 : 0;
}

function parseObservation(stored: string): MovementObservation | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stored);
  } catch {
    return null;
  }
  const parsed = movementObservation.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

/**
 * Bring a table created by an earlier version of the app up to date.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so the columns the table already
 * has are read first and only the missing ones are added. Running it on a
 * table `CREATE TABLE` has just made is a no-op, which is what keeps the schema
 * above readable as the whole shape rather than as a starting point.
 */
async function addMissingColumns(database: SqliteDatabase): Promise<void> {
  const existing = await database.getAllAsync<{ name: string }>(
    "SELECT name FROM pragma_table_info('pending_completions')",
    [],
  );
  const present = new Set(existing.map((column) => column.name));
  for (const column of ADDED_COLUMNS) {
    if (!present.has(column.name)) {
      await database.execAsync(
        `ALTER TABLE pending_completions ADD COLUMN ${column.name} ${column.definition}`,
      );
    }
  }
}

export async function openPendingCompletionStore(
  options: PendingCompletionStoreOptions,
): Promise<PendingCompletionStore> {
  const database = options.database;
  const newRecordId = options.newRecordId ?? randomUUID;
  const now = options.now ?? (() => new Date());

  await database.execAsync(SCHEMA);
  await addMissingColumns(database);

  async function select(where: string, params: readonly SqliteValue[]): Promise<Row[]> {
    return database.getAllAsync<Row>(
      `SELECT ${SELECT_COLUMNS} FROM pending_completions ${where} ORDER BY created_at, id`,
      params,
    );
  }

  async function read(id: string): Promise<PendingCompletionRecord | null> {
    const rows = await select("WHERE id = ?", [id]);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  return {
    async record(input) {
      const id = newRecordId();
      const createdAt = now().toISOString();
      await database.runAsync(
        `INSERT INTO pending_completions (
           id, challenge_id, task_id, completed_at, observation, app_version,
           verification_policy_version, status, created_at, attempts
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0)`,
        [
          id,
          input.challengeId,
          input.taskId,
          input.completedAt,
          JSON.stringify(input.observation),
          input.appVersion,
          input.verificationPolicyVersion,
          createdAt,
        ],
      );
      const stored = await read(id);
      if (stored === null) {
        // Unreachable: the insert either threw or wrote the row. Failing loudly
        // matters here because the caller is about to show a local check.
        throw new Error("the pending completion was not stored");
      }
      return stored;
    },

    async list() {
      return (await select("", [])).map(toRecord);
    },

    async listPending() {
      return (await select("WHERE status = 'pending'", [])).map(toRecord);
    },

    async listRejected() {
      return (await select("WHERE status = 'rejected'", [])).map(toRecord);
    },

    async markAcknowledged(id) {
      await database.runAsync("DELETE FROM pending_completions WHERE id = ?", [id]);
    },

    async markRejected(id, error) {
      await database.runAsync(
        `UPDATE pending_completions
            SET status = 'rejected', attempts = attempts + 1,
                last_error_code = ?, last_error_message = ?,
                last_error_reached_server = ?
          WHERE id = ?`,
        [error.code, error.message, reachedServerValue(error), id],
      );
    },

    async noteAttemptFailed(id, error) {
      // Guarded on the status so a failure arriving after the record was
      // rejected by another attempt cannot put it back into the retry set.
      await database.runAsync(
        `UPDATE pending_completions
            SET attempts = attempts + 1, last_error_code = ?, last_error_message = ?,
                last_error_reached_server = ?
          WHERE id = ? AND status = 'pending'`,
        [error.code, error.message, reachedServerValue(error), id],
      );
    },

    async discardAll() {
      // Rejected records go too: they are refusals about tasks that no longer
      // exist, and there is nobody left to act on them.
      await database.runAsync("DELETE FROM pending_completions", []);
    },

    close: () => database.closeAsync(),
  };
}
