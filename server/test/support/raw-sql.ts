/**
 * A raw PostgreSQL session, for tests that must not go through any application
 * code at all.
 *
 * The schema suites write through Drizzle, which is fair: that is how the
 * server will write. The assault suite exists to answer a different question,
 * which is what a stranger with a `psql` prompt can do to the data. Drizzle
 * cannot express many of those writes at all, because its own types refuse
 * them, so an invariant that only Drizzle's types carry would look enforced in
 * a Drizzle test and be wide open in production.
 *
 * The one thing this module borrows from the harness is a connection string.
 */

import pg from "pg";
import { afterEach, beforeEach } from "vitest";

import type { TestDatabase } from "./postgres.ts";

export type Row = Record<string, unknown>;

export interface RawSql {
  query(text: string, params?: readonly unknown[]): Promise<Row[]>;
  /** Runs `run` between BEGIN and COMMIT, so deferred triggers fire at the end. */
  transaction(run: (tx: RawSql) => Promise<void>): Promise<void>;
}

/**
 * Opens a raw session against the current test database and closes it after
 * the test. Registered after `useTestDatabase()`, so the database exists by the
 * time this connects.
 */
export function useRawSql(testDatabase: () => TestDatabase): () => RawSql {
  let client: pg.Client | undefined;

  beforeEach(async () => {
    client = new pg.Client({ connectionString: testDatabase().connectionString });
    await client.connect();
  });

  afterEach(async () => {
    await client?.end();
    client = undefined;
  });

  return () => {
    if (client === undefined) {
      throw new Error("useRawSql() was read outside a test.");
    }
    return session(client);
  };
}

function session(client: pg.Client): RawSql {
  const statements: RawSql = {
    async query(text, params) {
      const result = await client.query(text, params === undefined ? undefined : [...params]);
      return result.rows as Row[];
    },
    async transaction(run) {
      await client.query("begin");
      try {
        await run({
          query: statements.query,
          transaction() {
            throw new Error("raw transactions do not nest");
          },
        });
        // The commit is the interesting statement: a deferred constraint
        // trigger raises here and nowhere else.
        await client.query("commit");
      } catch (error) {
        try {
          await client.query("rollback");
        } catch {
          // A failed commit already ended the transaction.
        }
        throw error;
      }
    },
  };
  return statements;
}

/** The single value of a single-row, single-column result. */
export function single(rows: readonly Row[], column: string): string {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("statement returned no rows");
  }
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error(`column ${column} was not a string`);
  }
  return value;
}
