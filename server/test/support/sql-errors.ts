/**
 * Asserting that PostgreSQL, and not application code, rejected a write.
 *
 * A schema test is only worth anything if it fails for the reason it names, so
 * these assertions match the SQLSTATE rather than a message. The state also
 * distinguishes the kind of guard that fired: a unique index, a check
 * constraint, or one of the deferred constraint triggers.
 */

import { expect } from "vitest";

/** A unique index or primary key rejected the row. */
export const UNIQUE_VIOLATION = "23505";
/** A check constraint rejected the row. */
export const CHECK_VIOLATION = "23514";
/** A foreign key had no referent. */
export const FOREIGN_KEY_VIOLATION = "23503";
/**
 * The generic integrity class, which is what a constraint trigger raises. The
 * aggregate invariants (the task count, and later the ledger balance) arrive
 * this way, since no narrower state describes a count across rows.
 */
export const INTEGRITY_CONSTRAINT_VIOLATION = "23000";

/**
 * Drizzle wraps a driver error in a `DrizzleQueryError`, so the SQLSTATE the
 * assertion cares about sits somewhere down the `cause` chain rather than on
 * the thrown error itself. Reading `error.code` directly sees `undefined`,
 * which looks exactly like a missing constraint.
 */
export function sqlState(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const { code } = current as { code?: unknown };
    if (typeof code === "string") {
      return code;
    }
  }
  return undefined;
}

export async function expectSqlState(state: string, run: () => Promise<unknown>): Promise<void> {
  let thrown: unknown;
  let threw = false;
  try {
    await run();
  } catch (error) {
    thrown = error;
    threw = true;
  }
  expect(threw, "expected the write to be rejected").toBe(true);
  expect(sqlState(thrown), `expected SQLSTATE ${state}, got: ${String(thrown)}`).toBe(state);
}
