/**
 * Rate limit counters.
 *
 * The counters live in PostgreSQL because there is no gateway layer doing this
 * and because Lambda instances share no memory. An in-process counter would be
 * enforced once per container, so the ceiling would multiply by however many
 * containers AWS decided to run: the limit a caller actually met would be a
 * function of our own scaling rather than of the policy.
 *
 * One row is one fixed window of one bucket for one subject. The window start
 * is part of the primary key, which is what makes counting a single atomic
 * upsert: the row for the current window either exists and is incremented or
 * does not and is created, with the database ordering two callers who arrive
 * together. Nothing reads before it writes, so there is no check-then-act to
 * interleave.
 */

import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const rateLimitCounters = pgTable(
  "rate_limit_counters",
  {
    /**
     * Which limit this counts, named independently of the route. Two endpoints
     * that share a bucket share one allowance, which is what stops a caller
     * doubling a limit by alternating between pause and resume.
     */
    bucket: text("bucket").notNull(),
    /**
     * Who is being counted: an account identifier, or a source address for the
     * limits that apply before there is an account.
     *
     * Deliberately not a foreign key. The subject is not always an account, and
     * a counter is not a fact about a person worth keeping once its window has
     * passed: the row is pruned by age, not by cascade.
     */
    subject: text("subject").notNull(),
    /** The start of the fixed window, derived from the clock and the width. */
    windowStart: timestamp("window_start", { withTimezone: true, mode: "date" }).notNull(),
    hits: integer("hits").notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.bucket, table.subject, table.windowStart] }),
    // Pruning is by age across every bucket at once, so the index leads on the
    // window rather than on the bucket the primary key already serves.
    index("rate_limit_counters_window_idx").on(table.windowStart),
    // A row exists because something was counted. A zero would mean a counter
    // was created by a reader, and nothing here reads before it writes.
    check("rate_limit_counters_hits_positive", sql`${table.hits} > 0`),
  ],
);
