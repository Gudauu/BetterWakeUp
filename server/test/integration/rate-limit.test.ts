/**
 * Issue 15 against a real PostgreSQL.
 *
 * The acceptance boundary is the last section: two apps, each holding its own
 * connection the way two Lambda containers hold their own, firing at one
 * account at the same time. Exactly the allowance is admitted. A counter that
 * read before it wrote would admit more, and how many more would depend on how
 * many containers AWS happened to be running.
 */

import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { Database } from "../../src/db/index.ts";
import { rateLimitCounters } from "../../src/db/schema.ts";
import { createApp } from "../../src/http/app.ts";
import { createLogger } from "../../src/observability/logger.ts";
import type { RateLimitPolicy } from "../../src/rate-limit/policy.ts";
import { RATE_LIMITS } from "../../src/rate-limit/policy.ts";
import { createRateLimiter, pruneRateLimitCounters } from "../../src/rate-limit/service.ts";
import { fakeSessionGate, TEST_ACCOUNT_ID } from "../support/fake-session-gate.ts";
import { useTestDatabase } from "../support/postgres.ts";

const testDatabase = useTestDatabase();

const POLICY: RateLimitPolicy = {
  bucket: "test-bucket",
  scope: "account",
  limit: 3,
  windowSeconds: 300,
};

/** The one counter row for a bucket and subject, whichever window it is in. */
async function counterFor(db: Database, bucket: string, subject: string) {
  const rows = await db
    .select()
    .from(rateLimitCounters)
    .where(and(eq(rateLimitCounters.bucket, bucket), eq(rateLimitCounters.subject, subject)));
  return rows;
}

/** What a `consume` did, without the test having to catch to find out. */
async function attempt(
  limiter: { consume: (policy: RateLimitPolicy, subject: string) => Promise<void> },
  policy: RateLimitPolicy,
  subject: string,
): Promise<{ allowed: boolean; retryAfterSeconds?: number | undefined }> {
  try {
    await limiter.consume(policy, subject);
    return { allowed: true };
  } catch (error) {
    const app = error as { code?: string; retryAfterSeconds?: number };
    if (app.code !== "rate_limited") throw error;
    return { allowed: false, retryAfterSeconds: app.retryAfterSeconds };
  }
}

describe("counting one subject", () => {
  it("admits exactly the allowance and refuses the next request", async () => {
    const { db } = testDatabase();
    const limiter = createRateLimiter({ db });

    const outcomes = [];
    for (let i = 0; i < POLICY.limit + 2; i += 1) {
      outcomes.push(await attempt(limiter, POLICY, "subject-a"));
    }

    expect(outcomes.map((o) => o.allowed)).toEqual([true, true, true, false, false]);
  });

  it("tells a refused caller how long the window has left", async () => {
    const { db } = testDatabase();
    const limiter = createRateLimiter({ db });

    for (let i = 0; i < POLICY.limit; i += 1) await limiter.consume(POLICY, "subject-a");
    const refused = await attempt(limiter, POLICY, "subject-a");

    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(POLICY.windowSeconds);
  });

  it("keeps one row per window rather than one per request", async () => {
    const { db } = testDatabase();
    const limiter = createRateLimiter({ db });

    for (let i = 0; i < POLICY.limit; i += 1) await limiter.consume(POLICY, "subject-a");

    const rows = await counterFor(db, POLICY.bucket, "subject-a");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hits).toBe(POLICY.limit);
  });
});

describe("what a counter does not reach", () => {
  it("counts two subjects separately", async () => {
    const { db } = testDatabase();
    const limiter = createRateLimiter({ db });

    for (let i = 0; i < POLICY.limit; i += 1) await limiter.consume(POLICY, "subject-a");

    await expect(limiter.consume(POLICY, "subject-b")).resolves.toBeUndefined();
  });

  it("counts two buckets separately", async () => {
    const { db } = testDatabase();
    const limiter = createRateLimiter({ db });

    for (let i = 0; i < POLICY.limit; i += 1) await limiter.consume(POLICY, "subject-a");

    const other = { ...POLICY, bucket: "other-bucket" };
    await expect(limiter.consume(other, "subject-a")).resolves.toBeUndefined();
  });
});

describe("the window turning over", () => {
  it("starts a fresh allowance, because the window is part of the key", async () => {
    const { db } = testDatabase();
    const limiter = createRateLimiter({ db });

    for (let i = 0; i < POLICY.limit; i += 1) await limiter.consume(POLICY, "subject-a");
    expect((await attempt(limiter, POLICY, "subject-a")).allowed).toBe(false);

    // Move the spent counter into the previous window rather than sleeping
    // through a real one. The row stays legal; it simply is no longer the row
    // the current instant maps to, which is the whole mechanism under test.
    const [spent] = await counterFor(db, POLICY.bucket, "subject-a");
    if (spent === undefined) throw new Error("no counter to move");
    await db
      .update(rateLimitCounters)
      .set({ windowStart: new Date(spent.windowStart.getTime() - POLICY.windowSeconds * 1000) })
      .where(
        and(
          eq(rateLimitCounters.bucket, POLICY.bucket),
          eq(rateLimitCounters.subject, "subject-a"),
          eq(rateLimitCounters.windowStart, spent.windowStart),
        ),
      );

    expect((await attempt(limiter, POLICY, "subject-a")).allowed).toBe(true);
  });

  it("prunes counters whose window has closed and keeps the live one", async () => {
    const { db } = testDatabase();
    const limiter = createRateLimiter({ db });
    await limiter.consume(POLICY, "subject-a");

    const [live] = await counterFor(db, POLICY.bucket, "subject-a");
    if (live === undefined) throw new Error("no counter to keep");
    await db.insert(rateLimitCounters).values({
      bucket: POLICY.bucket,
      subject: "subject-a",
      windowStart: new Date(live.windowStart.getTime() - 10 * POLICY.windowSeconds * 1000),
      hits: 99,
    });

    await pruneRateLimitCounters(db, POLICY.windowSeconds);

    const remaining = await counterFor(db, POLICY.bucket, "subject-a");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.windowStart.getTime()).toBe(live.windowStart.getTime());
  });
});

describe("issue 15's acceptance boundary", () => {
  it("holds one allowance across two concurrent instances", async () => {
    const test = testDatabase();
    const policy = RATE_LIMITS.deleteSession;
    if (policy === null) throw new Error("deleteSession must declare a limit");

    // Two apps over two connections, which is what two Lambda containers are.
    // Nothing is shared between them except the database.
    const instances = [test.handle, test.connect()].map((handle) =>
      createApp({
        logger: createLogger({ sink: () => {} }),
        sessionGate: fakeSessionGate(),
        rateLimiter: createRateLimiter({ db: handle.db }),
        handlers: { deleteSession: () => ({}) },
      }),
    );

    const attempts = policy.limit + 10;
    const responses = await Promise.all(
      Array.from({ length: attempts }, (_, i) =>
        // Alternating, so neither instance can be the only one that counted.
        instances[i % instances.length]?.request("/sessions", {
          method: "DELETE",
          headers: { authorization: "Bearer anything" },
        }),
      ),
    );

    const statuses = responses.map((response) => response?.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(policy.limit);
    expect(statuses.filter((status) => status === 429)).toHaveLength(attempts - policy.limit);

    // And the database agrees: one row, counting every attempt exactly once.
    const rows = await counterFor(test.db, policy.bucket, TEST_ACCOUNT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hits).toBe(attempts);
  });
});
