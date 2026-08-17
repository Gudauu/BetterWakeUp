/**
 * Issue 12's acceptance boundary: the same key fired from two connections
 * simultaneously, with exactly one attempt performing the domain change.
 *
 * Every test here runs against a real PostgreSQL database, because the whole
 * mechanism is a claim on a row: a fake would prove only that the code agrees
 * with itself about who won. The stand-in domain change is a `sessions` insert,
 * chosen because counting the rows afterwards answers "how many times did this
 * actually happen" without any bookkeeping the service could get wrong.
 */

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { Database } from "../../src/db/index.ts";
import { IDEMPOTENCY_LEASE_SECONDS } from "../../src/db/schema/payments.ts";
import { idempotencyKeys, sessions } from "../../src/db/schema.ts";
import { AppError } from "../../src/errors/app-error.ts";
import { hashRequest } from "../../src/idempotency/request-hash.ts";
import { runIdempotent, type Transaction } from "../../src/idempotency/service.ts";
import { insertAccount } from "../support/challenge-fixtures.ts";
import { useTestDatabase } from "../support/postgres.ts";

const testDatabase = useTestDatabase();

const COMMAND = "submitCompletion";
const REQUEST = { taskId: "3f1c0f0e-0000-4000-8000-000000000001", steps: 120 };

/** The stand-in domain change: one session row per performed command. */
function insertSession(accountId: string) {
  return async (tx: Transaction) => {
    const [row] = await tx
      .insert(sessions)
      .values({
        accountId,
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning({ id: sessions.id });
    if (row === undefined) throw new Error("insert returned no session");
    return { sessionId: row.id };
  };
}

function countSessions(db: Database, accountId: string): Promise<number> {
  return db
    .select({ total: sql<number>`count(*)::int` })
    .from(sessions)
    .where(eq(sessions.accountId, accountId))
    .then((rows) => rows[0]?.total ?? 0);
}

function readKey(db: Database, accountId: string, key: string) {
  return db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.accountId, accountId), eq(idempotencyKeys.key, key)))
    .then((rows) => rows[0]);
}

/**
 * Ages the row so the next attempt is entitled to take it over. The creation
 * instant moves with the lease, because the table requires the lease to follow
 * it, and a row whose lease is spent is by definition not a new row.
 */
function expireLease(db: Database, accountId: string, key: string): Promise<unknown> {
  return db
    .update(idempotencyKeys)
    .set({
      createdAt: sql`now() - interval '10 minutes'`,
      leaseExpiresAt: sql`now() - interval '1 second'`,
    })
    .where(and(eq(idempotencyKeys.accountId, accountId), eq(idempotencyKeys.key, key)));
}

async function expectAppError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(AppError);
    return thrown as AppError;
  }
  throw new Error("expected the call to reject");
}

describe("the first attempt on a key", () => {
  it("performs the command and stores its result", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);
    const key = randomUUID();

    const outcome = await runIdempotent(
      db,
      { accountId, key, commandType: COMMAND, request: REQUEST },
      insertSession(accountId),
    );

    expect(outcome.replayed).toBe(false);
    expect(await countSessions(db, accountId)).toBe(1);

    const row = await readKey(db, accountId, key);
    expect(row?.status).toBe("completed");
    expect(row?.completedAt).not.toBeNull();
    expect(row?.result).toEqual(outcome.result);
    expect(row?.commandType).toBe(COMMAND);
  });

  it("takes a lease of exactly the architecture's length", async () => {
    const test = testDatabase();
    const observer = test.connect();
    const accountId = await insertAccount(test.db);
    const key = randomUUID();
    let leased: { createdAt: Date; leaseExpiresAt: Date } | undefined;

    await runIdempotent(
      test.db,
      { accountId, key, commandType: COMMAND, request: REQUEST },
      async () => {
        // Read from a second connection: the command's own transaction holds
        // the only connection its pool has.
        const row = await readKey(observer.db, accountId, key);
        if (row !== undefined) leased = row;
        return { ok: true };
      },
    );

    if (leased === undefined) throw new Error("the key was not readable while the command ran");
    const seconds = (leased.leaseExpiresAt.getTime() - leased.createdAt.getTime()) / 1000;
    expect(seconds).toBe(IDEMPOTENCY_LEASE_SECONDS);
    expect(IDEMPOTENCY_LEASE_SECONDS).toBe(180);
  });
});

describe("a replay of a completed key", () => {
  it("returns the stored result without performing again", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);
    const key = randomUUID();
    const command = { accountId, key, commandType: COMMAND, request: REQUEST };

    const first = await runIdempotent(db, command, insertSession(accountId));
    const second = await runIdempotent(db, command, async () => {
      throw new Error("the command must not run twice");
    });

    expect(second.replayed).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(await countSessions(db, accountId)).toBe(1);
  });
});

describe("the concurrent case", () => {
  it("lets exactly one of two simultaneous attempts perform the domain change", async () => {
    const test = testDatabase();
    const other = test.connect();
    const accountId = await insertAccount(test.db);
    const key = randomUUID();
    const command = { accountId, key, commandType: COMMAND, request: REQUEST };
    let performed = 0;

    const perform = async (tx: Transaction) => {
      performed += 1;
      return await insertSession(accountId)(tx);
    };

    const [left, right] = await Promise.allSettled([
      runIdempotent(test.db, command, perform),
      runIdempotent(other.db, command, perform),
    ]);

    expect(performed).toBe(1);
    expect(await countSessions(test.db, accountId)).toBe(1);

    // One attempt won. The other either arrived after the winner committed and
    // replayed its result, or arrived while the winner still held the lease and
    // was told to retry. Both are correct; performing twice is not.
    const settled = [left, right];
    const winners = settled.filter(
      (outcome) => outcome.status === "fulfilled" && !outcome.value.replayed,
    );
    expect(winners).toHaveLength(1);

    const loser = settled.find((outcome) => outcome !== winners[0]);
    if (loser?.status === "fulfilled") {
      expect(loser.value.replayed).toBe(true);
      expect(loser.value.result).toEqual(
        (winners[0] as PromiseFulfilledResult<{ result: unknown }>).value.result,
      );
    } else {
      expect((loser?.reason as AppError).code).toBe("idempotency_in_progress");
    }
  });

  it("tells a second attempt to retry while the first still holds its lease", async () => {
    const test = testDatabase();
    const other = test.connect();
    const accountId = await insertAccount(test.db);
    const key = randomUUID();
    const command = { accountId, key, commandType: COMMAND, request: REQUEST };

    const firstGate = gate();

    const holder = test.connect();
    const first = runIdempotent(holder.db, command, async (tx) => {
      await firstGate.opened;
      return await insertSession(accountId)(tx);
    });

    // Wait until the claim is committed, so the second attempt is racing a
    // live lease rather than an empty table.
    await waitFor(async () => (await readKey(test.db, accountId, key)) !== undefined);

    const error = await expectAppError(runIdempotent(other.db, command, insertSession(accountId)));
    expect(error.code).toBe("idempotency_in_progress");
    expect(error.status).toBe(409);
    expect(error.retryAfterSeconds).toBeGreaterThan(0);
    expect(error.leaseExpiresAt).toBeDefined();

    firstGate.open();
    await first;
    expect(await countSessions(test.db, accountId)).toBe(1);
  });
});

describe("the lease", () => {
  it("may be taken over once it has run out", async () => {
    const test = testDatabase();
    const other = test.connect();
    const accountId = await insertAccount(test.db);
    const key = randomUUID();
    const command = { accountId, key, commandType: COMMAND, request: REQUEST };

    const firstGate = gate();
    const holder = test.connect();
    const first = runIdempotent(holder.db, command, async (tx) => {
      await firstGate.opened;
      return await insertSession(accountId)(tx);
    });
    await waitFor(async () => (await readKey(test.db, accountId, key)) !== undefined);
    await expireLease(test.db, accountId, key);

    const takenOver = await runIdempotent(other.db, command, insertSession(accountId));
    expect(takenOver.replayed).toBe(false);

    firstGate.open();
    // The attempt whose lease was taken has nothing to commit under a key it no
    // longer owns, so its domain change rolls back rather than doubling up.
    const error = await expectAppError(first);
    expect(error.code).toBe("idempotency_in_progress");
    expect(await countSessions(test.db, accountId)).toBe(1);
  });

  it("is not released by the attempt it was taken from", async () => {
    const test = testDatabase();
    const accountId = await insertAccount(test.db);
    const key = randomUUID();
    const command = { accountId, key, commandType: COMMAND, request: REQUEST };

    const gates = { first: gate(), second: gate() };
    const abandoned = test.connect();
    const failing = runIdempotent(abandoned.db, command, async () => {
      await gates.first.opened;
      throw new Error("the abandoned attempt failed");
    });
    await waitFor(async () => (await readKey(test.db, accountId, key)) !== undefined);
    await expireLease(test.db, accountId, key);
    const abandonedOwner = (await readKey(test.db, accountId, key))?.leaseOwner;

    const taker = test.connect();
    const taken = runIdempotent(taker.db, command, async (tx) => {
      await gates.second.opened;
      return await insertSession(accountId)(tx);
    });
    // A new owner on the row is what says the takeover committed.
    await waitFor(async () => {
      const row = await readKey(test.db, accountId, key);
      return row !== undefined && row.leaseOwner !== abandonedOwner;
    });

    // The abandoned attempt fails while the taker is mid-flight. Its cleanup
    // must not touch a row it no longer owns.
    gates.first.open();
    await expect(failing).rejects.toThrow("the abandoned attempt failed");
    expect(await readKey(test.db, accountId, key)).toBeDefined();

    gates.second.open();
    const outcome = await taken;
    expect(outcome.replayed).toBe(false);
    expect(await countSessions(test.db, accountId)).toBe(1);
  });

  it("is not completed by an attempt that lost it to a later claim", async () => {
    const test = testDatabase();
    const accountId = await insertAccount(test.db);
    const key = randomUUID();
    const command = { accountId, key, commandType: COMMAND, request: REQUEST };

    // The abandoned attempt still believes it holds the key.
    const abandonedGate = gate();
    const abandoned = test.connect();
    const stale = runIdempotent(abandoned.db, command, async (tx) => {
      await abandonedGate.opened;
      return await insertSession(accountId)(tx);
    });
    await waitFor(async () => (await readKey(test.db, accountId, key)) !== undefined);
    await expireLease(test.db, accountId, key);

    // A second attempt takes the key over and then fails, which releases it.
    const taker = test.connect();
    await expect(
      runIdempotent(taker.db, command, async () => {
        throw new Error("the taker failed");
      }),
    ).rejects.toThrow("the taker failed");
    expect(await readKey(test.db, accountId, key)).toBeUndefined();

    // A third attempt claims a brand new row under the same key.
    const freshGate = gate();
    const fresh = test.connect();
    const current = runIdempotent(fresh.db, command, async (tx) => {
      await freshGate.opened;
      return await insertSession(accountId)(tx);
    });
    await waitFor(async () => (await readKey(test.db, accountId, key)) !== undefined);

    // The abandoned attempt finishes last. Its row is `in_progress` again, so
    // status alone would let it complete somebody else's claim.
    abandonedGate.open();
    const error = await expectAppError(stale);
    expect(error.code).toBe("idempotency_in_progress");

    freshGate.open();
    expect((await current).replayed).toBe(false);
    expect(await countSessions(test.db, accountId)).toBe(1);
  });

  it("keeps the receipt instant a takeover inherited", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);
    const key = randomUUID();
    const command = { accountId, key, commandType: COMMAND, request: REQUEST };

    await db.insert(idempotencyKeys).values({
      accountId,
      key,
      commandType: COMMAND,
      requestHash: hashRequest(REQUEST),
      // A crashed attempt from five minutes ago: the lease is spent, but it
      // still has to follow the instant the row was created.
      createdAt: new Date(Date.now() - 300_000),
      leaseExpiresAt: new Date(Date.now() - 120_000),
    });
    const before = await readKey(db, accountId, key);

    await runIdempotent(db, command, insertSession(accountId));

    const after = await readKey(db, accountId, key);
    // The architecture makes the insert instant the receipt instant, so a
    // takeover must not restart the clock the sweep reads.
    expect(after?.createdAt).toEqual(before?.createdAt);
    expect(after?.leaseOwner).not.toBe(before?.leaseOwner);
    expect(after?.status).toBe("completed");
  });
});

describe("a key reused for a different request", () => {
  it("is rejected when the body differs", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);
    const key = randomUUID();

    await runIdempotent(
      db,
      { accountId, key, commandType: COMMAND, request: REQUEST },
      insertSession(accountId),
    );

    const error = await expectAppError(
      runIdempotent(
        db,
        { accountId, key, commandType: COMMAND, request: { ...REQUEST, steps: 121 } },
        insertSession(accountId),
      ),
    );
    expect(error.code).toBe("idempotency_key_reused");
    expect(error.status).toBe(409);
    expect(await countSessions(db, accountId)).toBe(1);
  });

  it("is rejected when the same body is spent on a different command", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);
    const key = randomUUID();

    await runIdempotent(
      db,
      { accountId, key, commandType: COMMAND, request: REQUEST },
      insertSession(accountId),
    );

    const error = await expectAppError(
      runIdempotent(
        db,
        { accountId, key, commandType: "pauseChallenge", request: REQUEST },
        insertSession(accountId),
      ),
    );
    expect(error.code).toBe("idempotency_key_reused");
  });

  it("accepts the same key on a different account", async () => {
    const { db } = testDatabase();
    const first = await insertAccount(db);
    const second = await insertAccount(db);
    const key = randomUUID();

    await runIdempotent(
      db,
      { accountId: first, key, commandType: COMMAND, request: REQUEST },
      insertSession(first),
    );
    const other = await runIdempotent(
      db,
      { accountId: second, key, commandType: COMMAND, request: REQUEST },
      insertSession(second),
    );

    expect(other.replayed).toBe(false);
    expect(await countSessions(db, first)).toBe(1);
    expect(await countSessions(db, second)).toBe(1);
  });
});

describe("a command that fails", () => {
  it("commits nothing and releases the key for an immediate retry", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);
    const key = randomUUID();
    const command = { accountId, key, commandType: COMMAND, request: REQUEST };

    await expect(
      runIdempotent(db, command, async (tx) => {
        await insertSession(accountId)(tx);
        throw new Error("the domain change failed");
      }),
    ).rejects.toThrow("the domain change failed");

    expect(await countSessions(db, accountId)).toBe(0);
    expect(await readKey(db, accountId, key)).toBeUndefined();

    const retried = await runIdempotent(db, command, insertSession(accountId));
    expect(retried.replayed).toBe(false);
    expect(await countSessions(db, accountId)).toBe(1);
  });

  it("keeps an AppError from the domain change rather than masking it", async () => {
    const { db } = testDatabase();
    const accountId = await insertAccount(db);
    const key = randomUUID();

    const error = await expectAppError(
      runIdempotent(db, { accountId, key, commandType: COMMAND, request: REQUEST }, async () => {
        throw new AppError("deadline_passed", "The deadline has passed.");
      }),
    );
    expect(error.code).toBe("deadline_passed");
  });
});

/** A latch the test opens to let a blocked command proceed. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition did not hold in time");
}
