/**
 * Builders for a challenge that the database will accept.
 *
 * The task count invariant is a deferred constraint trigger, so a challenge and
 * the full set of tasks it requires have to arrive in one transaction. That
 * makes "insert a valid active challenge" several statements rather than one,
 * and every schema test needs it before it can attempt the violation it is
 * actually about. Issue 9's assault suite will need the same starting point.
 */

import type { Database } from "../../src/db/index.ts";
import {
  accounts,
  challengeScheduleDays,
  challenges,
  scheduledTasks,
} from "../../src/db/schema.ts";

export type ChallengeStatusValue = (typeof challenges.$inferInsert)["status"];
export type TaskStatusValue = (typeof scheduledTasks.$inferInsert)["status"];

/** Arbitrary but fixed, so a task date never depends on when the suite runs. */
const FIRST_TASK_DATE = Date.UTC(2026, 0, 5, 16, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
/** The No Regret duration the fixtures use, matching `noRegretMinutes` below. */
const PAUSE_CUTOFF_LEAD_MS = 60 * 60 * 1000;

export interface ChallengeOptions {
  /** How many completions the challenge needs. */
  readonly requiredTaskCount: number;
  /** How many `scheduled` tasks to materialize. Defaults to the required count. */
  readonly taskCount: number;
  readonly status: ChallengeStatusValue;
  readonly depositMinorUnits: number;
  /**
   * The status every materialized task takes. Defaults to `scheduled`, or to
   * `completed` for a `succeeded` challenge, which the database will not accept
   * without its required completions.
   */
  readonly taskStatus: TaskStatusValue;
  /**
   * When a terminal challenge reached its status. Defaults to the first task's
   * instant. A test with two ended challenges has to set it, because the status
   * transition trigger refuses to update a challenge that already ended.
   */
  readonly terminalAt?: Date;
}

const DEFAULT_OPTIONS: Omit<ChallengeOptions, "taskStatus"> = {
  requiredTaskCount: 3,
  taskCount: 3,
  status: "active",
  depositMinorUnits: 2000,
};

export async function insertAccount(db: Database): Promise<string> {
  const [row] = await db.insert(accounts).values({}).returning({ id: accounts.id });
  if (row === undefined) {
    throw new Error("insert returned no account");
  }
  return row.id;
}

/** The deadline of the task at `sequence`, counting from 1. */
export function taskDeadline(sequence: number): Date {
  return new Date(FIRST_TASK_DATE + (sequence - 1) * DAY_MS);
}

export function taskDate(sequence: number): string {
  const date = taskDeadline(sequence).toISOString();
  return date.slice(0, 10);
}

export function taskValues(
  challengeId: string,
  sequence: number,
  status: TaskStatusValue = "scheduled",
) {
  const deadline = taskDeadline(sequence);
  return {
    challengeId,
    sequence,
    taskDate: taskDate(sequence),
    deadline,
    pauseCutoff: new Date(deadline.getTime() - PAUSE_CUTOFF_LEAD_MS),
    status,
    // Each outcome instant is required by a check constraint exactly when the
    // status names it, so a fixture cannot set the status alone.
    ...(status === "completed" ? { acknowledgedAt: deadline } : {}),
    ...(status === "skipped" ? { skippedAt: deadline } : {}),
    ...(status === "missed" || status === "forgiven" ? { missedAt: deadline } : {}),
    ...(status === "forgiven" ? { forgivenAt: deadline } : {}),
  };
}

/**
 * Inserts an account, a challenge, its weekly schedule, and its tasks in one
 * transaction, so the deferred task count trigger sees a complete challenge.
 */
export async function insertChallenge(
  db: Database,
  overrides: Partial<ChallengeOptions> = {},
): Promise<{ accountId: string; challengeId: string }> {
  const accountId = await insertAccount(db);
  const challengeId = await insertChallengeForAccount(db, accountId, overrides);
  return { accountId, challengeId };
}

export async function insertChallengeForAccount(
  db: Database,
  accountId: string,
  overrides: Partial<ChallengeOptions> = {},
): Promise<string> {
  const status = overrides.status ?? DEFAULT_OPTIONS.status;
  const options: ChallengeOptions = {
    ...DEFAULT_OPTIONS,
    taskStatus: status === "succeeded" ? "completed" : "scheduled",
    ...(overrides.requiredTaskCount === undefined
      ? {}
      : { taskCount: overrides.requiredTaskCount }),
    ...overrides,
  };
  const terminal =
    options.status === "succeeded" || options.status === "failed" || options.status === "expired";

  return await db.transaction(async (tx) => {
    const [challenge] = await tx
      .insert(challenges)
      .values({
        accountId,
        status: options.status,
        requiredTaskCount: options.requiredTaskCount,
        stepTarget: 500,
        noRegretMinutes: 60,
        timeZone: "America/Los_Angeles",
        depositMinorUnits: options.depositMinorUnits,
        policyVersion: "2026-01-01",
        projectedEndDate: taskDate(options.requiredTaskCount),
        activatedAt: new Date(FIRST_TASK_DATE - DAY_MS),
        ...(terminal ? { terminalAt: options.terminalAt ?? new Date(FIRST_TASK_DATE) } : {}),
      })
      .returning({ id: challenges.id });
    if (challenge === undefined) {
      throw new Error("insert returned no challenge");
    }

    await tx
      .insert(challengeScheduleDays)
      .values(
        (
          ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const
        ).map((weekday) => ({ challengeId: challenge.id, weekday, deadlineLocal: "08:00:00" })),
      );

    if (options.taskCount > 0) {
      await tx
        .insert(scheduledTasks)
        .values(
          Array.from({ length: options.taskCount }, (_, index) =>
            taskValues(challenge.id, index + 1, options.taskStatus),
          ),
        );
    }

    return challenge.id;
  });
}
