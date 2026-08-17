/**
 * The idempotency service.
 *
 * Every state-changing client command runs through `runIdempotent`, which
 * implements the architecture's three-step sequence:
 *
 * 1. Insert the key `in_progress` in its own short transaction, recording the
 *    account, the command type, and a hash of the request.
 * 2. If that insert loses the primary key, read the winner's row. A `completed`
 *    row replays its stored result. An `in_progress` row inside its lease is a
 *    retry response rather than an error. An `in_progress` row past its lease
 *    may be taken over, because the earlier attempt did not commit.
 * 3. Perform the domain change and mark the key `completed` with its result in
 *    one transaction.
 *
 * Two properties do the real work here.
 *
 * **The insert is the concurrency control.** Nothing reads before it writes, so
 * two callers presenting one key at the same instant are ordered by the
 * database, not by a check-then-act the scheduler can interleave. Exactly one
 * of them gets a row back and therefore exactly one performs the domain change.
 *
 * **The lease is owned, not merely timed.** A takeover mints a new
 * `lease_owner`, and an attempt completes or releases the row only while the
 * owner is still its own. `status = 'in_progress'` is not a substitute: a row
 * that was taken over, failed, released, and claimed again is `in_progress`
 * once more, and a status check alone would let the original attempt complete
 * somebody else's claim, or let a failed attempt delete a row its successor is
 * still working under. Either way an attempt entitled to commit loses its
 * domain change to one that is not.
 *
 * Time is always the database's `now()`, never the process clock, so a Lambda
 * container with a skewed clock cannot take over a live lease or hold an
 * expired one.
 *
 * `runIdempotent` opens its own transactions and must not be called inside one.
 */

import { and, eq, lte, sql } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { IDEMPOTENCY_LEASE_SECONDS, idempotencyKeys } from "../db/schema/payments.ts";
import { AppError } from "../errors/app-error.ts";
import { hashRequest } from "./request-hash.ts";

/** The handle a domain change is given: the transaction the key completes in. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** A database handle that can run a transaction. Narrower than `Database`. */
type Transactional = Pick<Database, "transaction" | "insert" | "select" | "update" | "delete">;

export interface IdempotentCommand {
  /** The authenticated account. Keys are scoped to it, never global. */
  readonly accountId: string;
  /** The client's idempotency key, already validated as a UUID at the edge. */
  readonly key: string;
  /** Which command the key is spent on. A key is not reusable across commands. */
  readonly commandType: string;
  /** The request the key stands for. Hashed, never stored. */
  readonly request: unknown;
  /**
   * The one resource the command acts on, when it has one.
   *
   * Recorded rather than derived because the sweep has to recognise a command
   * that is in flight against a task without having the request that named it.
   * It is not part of the key's identity: the subject is already inside the
   * hashed request for every command that has one.
   */
  readonly subject?: string | undefined;
}

export interface IdempotentOutcome<Result> {
  /** True when the result came from the stored row rather than a fresh run. */
  readonly replayed: boolean;
  readonly result: Result;
}

/** A JSON value, which is what a stored result has to be. */
type Storable = Record<string, unknown>;

/**
 * How many times the sequence may restart before giving up.
 *
 * A restart happens only when the row moved underneath us between two
 * statements: it was released by a failed attempt, or taken over by another
 * one. Each restart is preceded by a committed change to the row by somebody
 * else, so the loop cannot spin; the bound is a backstop, not a policy.
 */
const MAX_ATTEMPTS = 5;

/**
 * Run a command at most once per idempotency key.
 *
 * `perform` receives the transaction the key is completed in, so the domain
 * change and the record of it either both commit or neither does. It runs at
 * most once per key across every caller and every retry; a caller that arrives
 * after it committed gets its stored result instead.
 */
export async function runIdempotent<Result extends Storable>(
  db: Transactional,
  command: IdempotentCommand,
  perform: (tx: Transaction) => Promise<Result>,
): Promise<IdempotentOutcome<Result>> {
  const requestHash = hashRequest(command.request);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const claimed = await claim(db, command, requestHash);
    if (claimed !== undefined) {
      return { replayed: false, result: await performAndComplete(db, command, claimed, perform) };
    }

    const existing = await read(db, command);
    if (existing === undefined) continue;
    assertSameRequest(existing, command, requestHash);
    if (existing.status === "completed") {
      return { replayed: true, result: storedResult<Result>(existing, command) };
    }

    const takenOver = await takeOver(db, command);
    if (takenOver !== undefined) {
      return { replayed: false, result: await performAndComplete(db, command, takenOver, perform) };
    }

    // The takeover found nothing to take: either the holder finished while we
    // looked, or its lease is still live. Re-reading is what tells them apart,
    // and it uses the database's clock rather than ours.
    const current = await read(db, command);
    if (current === undefined) continue;
    assertSameRequest(current, command, requestHash);
    if (current.status === "completed") {
      return { replayed: true, result: storedResult<Result>(current, command) };
    }
    if (current.leaseRemainingSeconds > 0) throw inProgress(current);
  }

  throw new AppError(
    "internal_error",
    `The idempotency key for ${command.commandType} changed hands ${MAX_ATTEMPTS} times without resolving.`,
  );
}

/** Step 1: the short transaction that is also the concurrency control. */
async function claim(
  db: Transactional,
  command: IdempotentCommand,
  requestHash: string,
): Promise<string | undefined> {
  const inserted = await db
    .insert(idempotencyKeys)
    .values({
      accountId: command.accountId,
      key: command.key,
      commandType: command.commandType,
      requestHash,
      subjectId: command.subject ?? null,
    })
    .onConflictDoNothing()
    .returning({ leaseOwner: idempotencyKeys.leaseOwner });
  return inserted[0]?.leaseOwner;
}

interface KeyRow {
  readonly commandType: string;
  readonly requestHash: string;
  readonly status: "in_progress" | "completed";
  readonly leaseExpiresAt: Date;
  readonly result: unknown;
  /**
   * How long the lease has left, measured by the database in the same
   * statement that read the row. Negative once it has run out.
   *
   * The remaining time is computed in SQL rather than by subtracting a
   * `now()` column here, so nothing depends on how a driver renders a bare
   * `now()`: an integer comes back an integer under both of them.
   */
  readonly leaseRemainingSeconds: number;
}

async function read(db: Transactional, command: IdempotentCommand): Promise<KeyRow | undefined> {
  const rows = await db
    .select({
      commandType: idempotencyKeys.commandType,
      requestHash: idempotencyKeys.requestHash,
      status: idempotencyKeys.status,
      leaseExpiresAt: idempotencyKeys.leaseExpiresAt,
      result: idempotencyKeys.result,
      leaseRemainingSeconds: sql<number>`ceil(extract(epoch from (${idempotencyKeys.leaseExpiresAt} - now())))::int`,
    })
    .from(idempotencyKeys)
    .where(keyOf(command));
  return rows[0];
}

/**
 * Step 2's third branch: claim a lease that ran out.
 *
 * The expiry is compared against the database's `now()` inside the same
 * statement that writes, so the row is locked for the comparison and two
 * simultaneous takeovers cannot both succeed. The new owner is minted here,
 * which is what tells the attempt being taken over that it lost.
 */
async function takeOver(
  db: Transactional,
  command: IdempotentCommand,
): Promise<string | undefined> {
  const taken = await db
    .update(idempotencyKeys)
    .set({
      leaseOwner: sql`gen_random_uuid()`,
      leaseExpiresAt: sql`now() + ${leaseInterval()}`,
    })
    .where(
      and(
        keyOf(command),
        eq(idempotencyKeys.status, "in_progress"),
        lte(idempotencyKeys.leaseExpiresAt, sql`now()`),
      ),
    )
    .returning({ leaseOwner: idempotencyKeys.leaseOwner });
  return taken[0]?.leaseOwner;
}

/** Step 3: the domain change and the record of it, committed together. */
async function performAndComplete<Result extends Storable>(
  db: Transactional,
  command: IdempotentCommand,
  leaseOwner: string,
  perform: (tx: Transaction) => Promise<Result>,
): Promise<Result> {
  try {
    return await db.transaction(async (tx) => {
      const result = await perform(tx);
      if (result === null || result === undefined) {
        throw new AppError(
          "internal_error",
          `The ${command.commandType} command produced no result to store against its idempotency key.`,
        );
      }

      const completed = await tx
        .update(idempotencyKeys)
        .set({ status: "completed", result, completedAt: sql`now()` })
        .where(
          and(
            keyOf(command),
            eq(idempotencyKeys.status, "in_progress"),
            eq(idempotencyKeys.leaseOwner, leaseOwner),
          ),
        )
        .returning({ key: idempotencyKeys.key });

      // Our lease was taken over while the domain change was in flight. The
      // throw rolls that change back, which is the whole point of completing
      // the key in the same transaction.
      if (completed.length === 0) throw new LeaseLostError();
      return result;
    });
  } catch (thrown) {
    if (thrown instanceof LeaseLostError) {
      throw new AppError(
        "idempotency_in_progress",
        "Another attempt took over this idempotency key. Retry the command.",
        { retryAfterSeconds: 1 },
      );
    }
    // The domain change failed and rolled back, so the key stands for nothing.
    // Releasing it lets the client retry at once rather than waiting out a
    // lease for an attempt that left no trace. A crash releases nothing, which
    // is exactly the case the lease exists for.
    await release(db, command, leaseOwner);
    throw thrown;
  }
}

async function release(
  db: Transactional,
  command: IdempotentCommand,
  leaseOwner: string,
): Promise<void> {
  await db
    .delete(idempotencyKeys)
    .where(
      and(
        keyOf(command),
        eq(idempotencyKeys.status, "in_progress"),
        eq(idempotencyKeys.leaseOwner, leaseOwner),
      ),
    );
}

/** Signals that the lease changed hands mid-flight. Never leaves this module. */
class LeaseLostError extends Error {}

function keyOf(command: IdempotentCommand) {
  return and(
    eq(idempotencyKeys.accountId, command.accountId),
    eq(idempotencyKeys.key, command.key),
  );
}

function leaseInterval() {
  return sql.raw(`interval '${IDEMPOTENCY_LEASE_SECONDS} seconds'`);
}

/**
 * The architecture's last rule: a key reused with a different request is
 * rejected. The command type is part of the request's identity, so spending a
 * completion key on a pause is the same mistake as changing the body.
 */
function assertSameRequest(row: KeyRow, command: IdempotentCommand, requestHash: string): void {
  if (row.commandType === command.commandType && row.requestHash === requestHash) return;
  throw new AppError(
    "idempotency_key_reused",
    "This idempotency key was already used for a different request.",
  );
}

function inProgress(row: KeyRow): AppError {
  return new AppError(
    "idempotency_in_progress",
    "This command is already being processed. Retry to collect its result.",
    {
      retryAfterSeconds: Math.max(1, row.leaseRemainingSeconds),
      leaseExpiresAt: row.leaseExpiresAt.toISOString(),
    },
  );
}

function storedResult<Result extends Storable>(row: KeyRow, command: IdempotentCommand): Result {
  if (row.result === null || row.result === undefined) {
    // Unreachable while the table's check constraint holds; a completed row
    // without a result would otherwise replay success with nothing in it.
    throw new AppError(
      "internal_error",
      `The completed idempotency key for ${command.commandType} stored no result.`,
    );
  }
  return row.result as Result;
}
