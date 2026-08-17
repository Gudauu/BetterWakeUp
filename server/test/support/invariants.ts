/**
 * Every invariant the architecture requires of the database, read back out of a
 * whole database rather than asserted about one row.
 *
 * The schema carries these rules as unique indexes, check constraints, and
 * deferred constraint triggers, and issue 9's assault suite proves each one
 * refuses the write that would break it. This module is the other direction: it
 * takes a database in whatever state a run left it and answers whether anything
 * is broken, with no knowledge of how the state was produced. That is what lets
 * a concurrency test say "every interleaving leaves the database consistent"
 * instead of listing the outcomes it happens to expect.
 *
 * Every query returns the rows that violate the rule, so a failure names the
 * challenge, task, or account to look at rather than merely reporting a count.
 * The checks are read-only and take any executor, including a transaction, so a
 * test can create a violation with the constraints suspended, confirm the check
 * sees it, and roll the whole thing back.
 */

import { type SQL, sql } from "drizzle-orm";

import { executeRows, type SqlExecutor } from "../../src/db/query.ts";

export interface InvariantViolation {
  /** The architecture's own wording of the rule that is broken. */
  readonly invariant: string;
  /** The offending rows, one object per row, as the check selected them. */
  readonly rows: readonly Record<string, unknown>[];
}

interface InvariantCheck {
  readonly invariant: string;
  readonly offendingRows: SQL;
}

const CHECKS: readonly InvariantCheck[] = [
  {
    invariant: "one active challenge per account",
    offendingRows: sql`
      select account_id, count(*)::int as open_challenges
      from challenges
      where status in ('active', 'recovery_pending')
      group by account_id
      having count(*) > 1
    `,
  },
  {
    invariant: "one completion result per scheduled task",
    offendingRows: sql`
      select task_id, count(*)::int as completions
      from task_completions
      group by task_id
      having count(*) > 1
    `,
  },
  {
    // The status column makes one outcome per task representable; what a
    // snapshot can still show is a task carrying the instants of two of them,
    // or a forgiveness with no miss under it.
    invariant: "one terminal outcome per scheduled task, missed supersedable by forgiven once",
    offendingRows: sql`
      select id, status, acknowledged_at, skipped_at, missed_at, forgiven_at
      from scheduled_tasks
      where (
        (acknowledged_at is not null)::int
        + (skipped_at is not null)::int
        + (missed_at is not null)::int
      ) > 1
      or (forgiven_at is not null and missed_at is null)
      or (
        status = 'scheduled'
        and (acknowledged_at is not null or skipped_at is not null or missed_at is not null)
      )
    `,
  },
  {
    invariant: "one terminal outcome per challenge",
    offendingRows: sql`
      select id, status, terminal_at
      from challenges
      where (status in ('succeeded', 'failed', 'expired')) <> (terminal_at is not null)
    `,
  },
  {
    invariant: "task rows in scheduled or completed status equal the required count while active",
    offendingRows: sql`
      select c.id, c.required_task_count, count(t.id) filter (
        where t.status in ('scheduled', 'completed')
      )::int as live_tasks
      from challenges c
      left join scheduled_tasks t on t.challenge_id = c.id
      where c.status = 'active'
      group by c.id, c.required_task_count
      having count(t.id) filter (where t.status in ('scheduled', 'completed'))
        <> c.required_task_count
    `,
  },
  {
    // The account column makes a second consumption unrepresentable, so what a
    // snapshot checks is the effect: an account cannot have forgiven two tasks,
    // and cannot have forgiven one without spending its allowance.
    invariant: "Emergency Recovery is consumed at most once per account",
    offendingRows: sql`
      select a.id, a.emergency_recovery_consumed_at, count(t.id)::int as forgiven_tasks
      from accounts a
      join challenges c on c.account_id = a.id
      join scheduled_tasks t on t.challenge_id = c.id and t.forgiven_at is not null
      group by a.id, a.emergency_recovery_consumed_at
      having count(t.id) > 1 or a.emergency_recovery_consumed_at is null
    `,
  },
  {
    invariant: "a challenge succeeds only after its required completion count is reached",
    offendingRows: sql`
      select c.id, c.required_task_count, count(t.id) filter (
        where t.status = 'completed'
      )::int as completed_tasks
      from challenges c
      left join scheduled_tasks t on t.challenge_id = c.id
      where c.status = 'succeeded'
      group by c.id, c.required_task_count
      having count(t.id) filter (where t.status = 'completed') < c.required_task_count
    `,
  },
  {
    // Both readings of the rule. Per transaction is the continuously true form
    // the deferred trigger enforces; per challenge is how the architecture
    // words it, and it is what a settlement that wrote only half of a movement
    // would break.
    invariant: "ledger entries balance to zero, per transaction",
    offendingRows: sql`
      select t.id, e.currency, coalesce(sum(e.amount_minor_units), 0)::int as balance
      from ledger_transactions t
      left join ledger_entries e on e.transaction_id = t.id
      group by t.id, e.currency
      having coalesce(sum(e.amount_minor_units), 0) <> 0 or count(e.id) = 0
    `,
  },
  {
    invariant: "ledger entries for a challenge balance to zero",
    offendingRows: sql`
      select t.challenge_id, e.currency, sum(e.amount_minor_units)::int as balance
      from ledger_transactions t
      join ledger_entries e on e.transaction_id = t.id
      where t.challenge_id is not null
      group by t.challenge_id, e.currency
      having sum(e.amount_minor_units) <> 0
    `,
  },
];

/** Every invariant that the given database currently breaks. */
export async function checkInvariants(executor: SqlExecutor): Promise<InvariantViolation[]> {
  const violations: InvariantViolation[] = [];
  for (const check of CHECKS) {
    const rows = await executeRows<Record<string, unknown>>(executor, check.offendingRows);
    if (rows.length > 0) {
      violations.push({ invariant: check.invariant, rows });
    }
  }
  return violations;
}

/** The names of the rules this module checks, for a test asserting coverage. */
export function invariantNames(): readonly string[] {
  return CHECKS.map((check) => check.invariant);
}

/**
 * Fails the calling test, naming every broken rule and the rows that break it.
 *
 * Throws rather than taking an `expect`, so the assertion reads the same from a
 * test, from a helper, and from an `afterEach`.
 */
export async function assertInvariantsHold(executor: SqlExecutor): Promise<void> {
  const violations = await checkInvariants(executor);
  if (violations.length === 0) {
    return;
  }
  const detail = violations
    .map((violation) => `  ${violation.invariant}: ${JSON.stringify(violation.rows)}`)
    .join("\n");
  throw new Error(`the database broke ${violations.length} invariant(s):\n${detail}`);
}
