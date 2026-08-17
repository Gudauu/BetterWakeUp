/**
 * The two backlogs that are levels rather than events.
 *
 * Most of what the alarms watch is something that happened: a renewal was
 * refused, a webhook could not be accepted, a forfeit could not be collected.
 * Those are counted where they happen. Two of the alarms the architecture asks
 * for are not events at all:
 *
 * - a deposit unsecured for longer than a day, and
 * - a settlement command past its `execute_after` instant.
 *
 * Both describe a state the system has been sitting in, and neither has a
 * moment at which something goes wrong: the renewal that left the deposit
 * unsecured failed a day earlier and was already counted then, and a settlement
 * command becomes overdue simply because a clock passed it while nothing ran.
 * A system that has stopped working produces no events at all, so counting
 * events would make the worst outage the quietest one.
 *
 * So the sweep measures both on every run and publishes the number it found.
 * That also gives the alarms a heartbeat: the daily sweep is the only thing
 * that emits these, so a sweep that stops running stops the metric, and the
 * alarms treat missing data as a breach.
 *
 * Two counts, one query each, no rows returned. These run beside a sweep that
 * is already touching both tables, and neither one takes a lock.
 */

import { sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";

/** How long a deposit may sit unsecured before it is worth waking somebody. */
export const UNSECURED_DEPOSIT_TOLERANCE_HOURS = 24;

/**
 * How far past `execute_after` a pending command may sit before it counts.
 *
 * Not zero. The sweep creates settlement commands and executes them in the
 * same invocation, so a command written moments ago and executed moments later
 * is briefly past its instant during perfectly normal operation. An hour is
 * longer than any single sweep and far shorter than the daily cadence, so it
 * catches a command nothing picked up without catching one in flight.
 */
export const SETTLEMENT_LATENESS_TOLERANCE_MINUTES = 60;

export interface BacklogMeasurement {
  /**
   * Funded, still-running challenges whose deposit has had no live hold behind
   * it for longer than the tolerance.
   */
  readonly depositsUnsecuredOverADay: number;
  /** Pending settlement commands whose eligibility instant is well past. */
  readonly overdueSettlementCommands: number;
}

export interface MeasureBacklogOptions {
  readonly db: Database;
  /** The instant to measure against, so a test states the moment. */
  readonly now: Date;
}

export async function measureBacklog(options: MeasureBacklogOptions): Promise<BacklogMeasurement> {
  const { db, now } = options;

  const unsecuredSince = new Date(
    now.getTime() - UNSECURED_DEPOSIT_TOLERANCE_HOURS * 60 * 60 * 1000,
  );
  const settlementSince = new Date(
    now.getTime() - SETTLEMENT_LATENESS_TOLERANCE_MINUTES * 60 * 1000,
  );

  // When the deposit stopped being secured is not stored on the challenge:
  // `deposit_secured` is a flag with no instant beside it, and the challenge's
  // own `updated_at` moves for reasons that have nothing to do with the
  // deposit, such as a task being marked missed. The instant that does mean it
  // is the last thing that happened to the challenge's holds: a hold that
  // ended, or a live hold whose renewal was last refused. A funded challenge
  // that never had a hold at all falls back to when it was activated.
  const unsecured = await db.execute<{ count: number }>(sql`
    select count(*)::int as count
    from challenges c
    where c.status in ('active', 'recovery_pending')
      and c.deposit_minor_units > 0
      and c.deposit_secured = false
      and coalesce(
        (
          select max(coalesce(a.ended_at, a.updated_at))
          from challenge_authorizations a
          where a.challenge_id = c.id
        ),
        c.activated_at,
        c.created_at
      ) <= ${unsecuredSince}
  `);

  const overdue = await db.execute<{ count: number }>(sql`
    select count(*)::int as count
    from payment_commands
    where status = 'pending'
      and execute_after <= ${settlementSince}
  `);

  return {
    depositsUnsecuredOverADay: firstCount(unsecured),
    overdueSettlementCommands: firstCount(overdue),
  };
}

/**
 * The count out of a driver-shaped result.
 *
 * The two drivers disagree about what `execute` returns: node-postgres hands
 * back a result object with a `rows` array, and Neon's serverless driver hands
 * back the array itself. Reading through both here keeps that difference from
 * reaching a caller, and a count that is missing entirely reads as zero rather
 * than as `NaN`, which would publish a metric nothing could alarm on.
 */
function firstCount(result: unknown): number {
  const rows = Array.isArray(result)
    ? result
    : ((result as { rows?: unknown[] } | null)?.rows ?? []);
  const value = (rows[0] as { count?: unknown } | undefined)?.count;
  return typeof value === "number" ? value : Number(value ?? 0);
}
