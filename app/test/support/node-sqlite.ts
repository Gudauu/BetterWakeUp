/**
 * A real SQL engine for the pending completion store's tests.
 *
 * Node ships SQLite, so the store's own statements run against a real database
 * here rather than against a hand-written fake that would agree with whatever
 * the store happened to do. A file-backed database is what lets a test close
 * the store, open a new one over the same file, and prove the record survived
 * the process, which is the acceptance boundary of issue 30.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDatabase } from "../../src/completions/sqlite.ts";

export interface TestDatabaseFile {
  /** Open a fresh handle over the same file, as a new app launch would. */
  open(): SqliteDatabase;
  /** Remove the file and everything under it. */
  remove(): void;
}

export function createTestDatabaseFile(): TestDatabaseFile {
  const directory = mkdtempSync(join(tmpdir(), "betterwakeup-"));
  const path = join(directory, "pending-completions.db");
  return {
    open: () => adapt(new DatabaseSync(path)),
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}

export function createMemoryDatabase(): SqliteDatabase {
  return adapt(new DatabaseSync(":memory:"));
}

function adapt(database: DatabaseSync): SqliteDatabase {
  return {
    async execAsync(sql) {
      database.exec(sql);
    },
    async runAsync(sql, params) {
      const result = database.prepare(sql).run(...params);
      return { changes: Number(result.changes) };
    },
    async getAllAsync<Row>(sql: string, params: readonly (string | number | null)[]) {
      // `all` returns null-prototype objects, which compare unequal to plain
      // ones under some matchers; spreading gives the store ordinary rows.
      return database
        .prepare(sql)
        .all(...params)
        .map((row) => ({ ...row })) as Row[];
    },
    async closeAsync() {
      database.close();
    },
  };
}
