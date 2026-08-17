/**
 * Guards the one mistake the migration folder invites: editing the Drizzle
 * schema and forgetting to run `pnpm --filter @betterwakeup/server run
 * db:generate`. The schema would compile, the tests would query columns the
 * database does not have, and the failure would surface as an unrelated query
 * error somewhere else.
 *
 * The comparison is over table and column names and nullability rather than
 * types. Those are what a missing migration changes, and matching PostgreSQL's
 * type spellings against Drizzle's would fail for reasons that are not drift.
 */

import { is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { executeRows } from "../../src/db/index.ts";
import * as schema from "../../src/db/schema.ts";
import { useTestDatabase } from "../support/postgres.ts";

const testDatabase = useTestDatabase();

interface ColumnShape {
  readonly table: string;
  readonly column: string;
  readonly nullable: boolean;
}

function declaredColumns(): ColumnShape[] {
  const columns: ColumnShape[] = [];
  for (const exported of Object.values(schema)) {
    // The schema module also exports enums, and Drizzle keeps its table
    // internals behind symbols, so `is` is the way to pick out the tables.
    if (!is(exported, PgTable)) {
      continue;
    }
    const config = getTableConfig(exported);
    for (const column of config.columns) {
      columns.push({ table: config.name, column: column.name, nullable: !column.notNull });
    }
  }
  return columns.sort(compareColumns);
}

function compareColumns(a: ColumnShape, b: ColumnShape): number {
  return a.table === b.table ? a.column.localeCompare(b.column) : a.table.localeCompare(b.table);
}

describe("migrations match the Drizzle schema", () => {
  it("has every declared column, and no extra ones", async () => {
    const rows = await executeRows<{
      table_name: string;
      column_name: string;
      is_nullable: "YES" | "NO";
    }>(
      testDatabase().db,
      sql`select table_name, column_name, is_nullable
          from information_schema.columns
          where table_schema = 'public'`,
    );

    const applied = rows
      .map((row) => ({
        table: row.table_name,
        column: row.column_name,
        nullable: row.is_nullable === "YES",
      }))
      .sort(compareColumns);

    expect(applied).toEqual(declaredColumns());
  });
});
