/**
 * The rate limiter.
 *
 * Counting is one statement: an upsert on `(bucket, subject, window_start)`
 * that increments and returns the new total. That single statement is the whole
 * concurrency story. Two Lambda containers arriving in the same microsecond are
 * ordered by the row lock the upsert takes, so each sees a distinct total and
 * exactly `limit` of them are inside the allowance. A read followed by a write
 * would let both read the same total and both decide they were the last one
 * permitted, which is the failure the acceptance test fires at this.
 *
 * The window is derived from the database's clock rather than the process
 * clock, for the same reason the idempotency lease is: a container with a
 * skewed clock would otherwise be counted against a window of its own, and a
 * caller could pick the container with the friendliest clock by retrying.
 *
 * The window is fixed rather than sliding. A fixed window is one row and one
 * statement; a sliding window is a row per request and a scan. The cost is the
 * usual boundary effect, where a caller can spend two allowances across the
 * instant a window turns over, and that is an acceptable price for a limit
 * whose job is to bound cost and abuse rather than to shape traffic precisely.
 */

import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../db/query.ts";
import { executeRows } from "../db/query.ts";
import { AppError } from "../errors/app-error.ts";
import type { RateLimitPolicy } from "./policy.ts";

export interface RateLimiter {
  /**
   * Count one request against `subject`, and throw `rate_limited` if that puts
   * the subject past the policy's allowance.
   */
  consume(policy: RateLimitPolicy, subject: string): Promise<void>;
}

export interface RateLimiterDependencies {
  readonly db: SqlExecutor;
}

interface CounterRow extends Record<string, unknown> {
  readonly hits: number;
  readonly retry_after: number;
}

export function createRateLimiter(deps: RateLimiterDependencies): RateLimiter {
  return {
    async consume(policy, subject) {
      const width = policy.windowSeconds;
      const windowStart = sql`to_timestamp(floor(extract(epoch from now()) / ${width}) * ${width})`;

      const rows = await executeRows<CounterRow>(
        deps.db,
        sql`
          insert into rate_limit_counters (bucket, subject, window_start, hits)
          values (${policy.bucket}, ${subject}, ${windowStart}, 1)
          on conflict (bucket, subject, window_start)
          do update set hits = rate_limit_counters.hits + 1
          returning
            hits,
            greatest(
              1,
              ceil(extract(epoch from (window_start + make_interval(secs => ${width})) - now()))
            )::int as retry_after
        `,
      );

      const row = rows[0];
      // An upsert with RETURNING always produces its row. No row means the
      // statement did not do what this code believes it does, which is our bug
      // rather than the caller's, so it must not read as a refusal.
      if (row === undefined) {
        throw new AppError("internal_error", "The rate limit counter returned no row.");
      }
      if (row.hits <= policy.limit) return;

      // The message names the allowance and not the ceiling. Telling a caller
      // the exact limit tells an abusive one how close to it they may sit.
      throw new AppError("rate_limited", "Too many requests. Try again shortly.", {
        retryAfterSeconds: row.retry_after,
      });
    },
  };
}

/**
 * Remove counters for windows that have already closed.
 *
 * Nothing reads a closed window, so these rows are only storage. The sweep
 * calls this; until issue 23 wires it in, it is exercised by its own test.
 */
export async function pruneRateLimitCounters(
  db: SqlExecutor,
  olderThanSeconds: number,
): Promise<void> {
  await executeRows(
    db,
    sql`
      delete from rate_limit_counters
      where window_start < now() - make_interval(secs => ${olderThanSeconds})
    `,
  );
}
