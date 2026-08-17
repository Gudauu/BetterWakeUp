/**
 * What the pending completion store needs from SQLite, and nothing more.
 *
 * The port is shaped like the subset of `expo-sqlite`'s asynchronous API the
 * store uses, so the real adapter is a pass-through and the SQL itself lives
 * in shared code rather than behind a native module. That is what lets the
 * tests run the store's real statements against a real SQL engine (Node's own
 * `node:sqlite`) instead of against a hand-written fake that would agree with
 * whatever the store happened to do.
 */

export type SqliteValue = string | number | null;

export interface SqliteRunResult {
  /** Rows the statement changed, which is how a guarded update reports a miss. */
  readonly changes: number;
}

export interface SqliteDatabase {
  /** Run one or more statements with no parameters, used for the schema. */
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params: readonly SqliteValue[]): Promise<SqliteRunResult>;
  getAllAsync<Row>(sql: string, params: readonly SqliteValue[]): Promise<Row[]>;
  closeAsync(): Promise<void>;
}
