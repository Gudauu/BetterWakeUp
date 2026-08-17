/**
 * Raw SQL results.
 *
 * Drizzle's `execute` returns whatever the underlying driver returns, which is
 * the one place the two drivers are visible through the shared `Database` type.
 * Both wrap rows in `{ rows }`, so the difference is contained here rather than
 * at every raw statement. Queries the builder can express should use the
 * builder; this is for statements it cannot, such as `FOR UPDATE SKIP LOCKED`.
 */

import type { SQL } from "drizzle-orm";

export interface SqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

export async function executeRows<TRow extends Record<string, unknown>>(
  executor: SqlExecutor,
  query: SQL,
): Promise<TRow[]> {
  const result = (await executor.execute(query)) as { rows?: readonly TRow[] };
  return [...(result.rows ?? [])];
}
