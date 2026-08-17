/**
 * The same starting point `challenge-fixtures.ts` builds, written in SQL.
 *
 * The assault suite cannot reuse the Drizzle fixtures without importing the
 * schema it is trying to attack from the outside, so the setup is duplicated
 * rather than shared. The duplication is the point: if the two ever disagree
 * about what a valid challenge looks like, one of them is wrong about the
 * database.
 */

import type { RawSql, Row } from "./raw-sql.ts";
import { single } from "./raw-sql.ts";

/** Fixed, so a task date never depends on when the suite runs. */
const FIRST_TASK_DATE = Date.UTC(2026, 0, 5, 16, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const PAUSE_CUTOFF_LEAD_MS = 60 * 60 * 1000;

export type TaskStatus = "scheduled" | "completed" | "skipped" | "missed" | "forgiven";
export type ChallengeStatus = "active" | "recovery_pending" | "succeeded" | "failed" | "expired";

export interface RawChallengeOptions {
  readonly status: ChallengeStatus;
  readonly requiredTaskCount: number;
  /** How many tasks to materialize. Defaults to the required count. */
  readonly taskCount: number;
  readonly taskStatus: TaskStatus;
  readonly depositMinorUnits: number;
}

/** The deadline of the task at `sequence`, counting from 1. */
export function taskDeadline(sequence: number): Date {
  return new Date(FIRST_TASK_DATE + (sequence - 1) * DAY_MS);
}

export function taskDate(sequence: number): string {
  return taskDeadline(sequence).toISOString().slice(0, 10);
}

export async function insertAccount(sql: RawSql): Promise<string> {
  return single(await sql.query("insert into accounts default values returning id"), "id");
}

/**
 * Inserts a task in one statement. Every outcome instant is tied to the status
 * by a check constraint, so the status alone is never enough.
 */
export async function insertTask(
  sql: RawSql,
  challengeId: string,
  sequence: number,
  status: TaskStatus = "scheduled",
): Promise<string> {
  const deadline = taskDeadline(sequence);
  return single(
    await sql.query(
      `insert into scheduled_tasks
         (challenge_id, sequence, task_date, deadline, pause_cutoff, status,
          acknowledged_at, skipped_at, missed_at, forgiven_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning id`,
      [
        challengeId,
        sequence,
        taskDate(sequence),
        deadline,
        new Date(deadline.getTime() - PAUSE_CUTOFF_LEAD_MS),
        status,
        status === "completed" ? deadline : null,
        status === "skipped" ? deadline : null,
        status === "missed" || status === "forgiven" ? deadline : null,
        status === "forgiven" ? deadline : null,
      ],
    ),
    "id",
  );
}

/**
 * An account, a challenge, its weekly schedule, and its tasks, in one
 * transaction, so the deferred task count trigger sees a complete challenge.
 */
export async function insertChallenge(
  sql: RawSql,
  overrides: Partial<RawChallengeOptions> = {},
): Promise<{ accountId: string; challengeId: string }> {
  const accountId = await insertAccount(sql);
  const challengeId = await insertChallengeForAccount(sql, accountId, overrides);
  return { accountId, challengeId };
}

export async function insertChallengeForAccount(
  sql: RawSql,
  accountId: string,
  overrides: Partial<RawChallengeOptions> = {},
): Promise<string> {
  const status = overrides.status ?? "active";
  const requiredTaskCount = overrides.requiredTaskCount ?? 3;
  const options: RawChallengeOptions = {
    status,
    requiredTaskCount,
    taskCount: requiredTaskCount,
    // A `succeeded` challenge the database will accept needs its completions.
    taskStatus: status === "succeeded" ? "completed" : "scheduled",
    depositMinorUnits: 2000,
    ...overrides,
  };
  const terminal = status === "succeeded" || status === "failed" || status === "expired";

  let challengeId = "";
  await sql.transaction(async (tx) => {
    challengeId = single(
      await tx.query(
        `insert into challenges
           (account_id, status, required_task_count, step_target, no_regret_minutes,
            time_zone, deposit_minor_units, policy_version, projected_end_date,
            activated_at, terminal_at)
         values ($1, $2, $3, 500, 60, 'America/Los_Angeles', $4, '2026-01-01', $5, $6, $7)
         returning id`,
        [
          accountId,
          options.status,
          options.requiredTaskCount,
          options.depositMinorUnits,
          taskDate(options.requiredTaskCount),
          new Date(FIRST_TASK_DATE - DAY_MS),
          terminal ? new Date(FIRST_TASK_DATE) : null,
        ],
      ),
      "id",
    );

    await tx.query(
      `insert into challenge_schedule_days (challenge_id, weekday, deadline_local)
       select $1, weekday, '08:00:00'::time from unnest($2::weekday[]) as weekday`,
      [challengeId, ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]],
    );

    for (let sequence = 1; sequence <= options.taskCount; sequence += 1) {
      await insertTask(tx, challengeId, sequence, options.taskStatus);
    }
  });
  return challengeId;
}

/** The tasks of a challenge, ordered by sequence, as raw rows. */
export async function tasksOf(sql: RawSql, challengeId: string): Promise<Row[]> {
  return await sql.query(
    "select id, sequence, status from scheduled_tasks where challenge_id = $1 order by sequence",
    [challengeId],
  );
}
