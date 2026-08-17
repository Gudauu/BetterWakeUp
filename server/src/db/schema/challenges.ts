/**
 * Challenges, their weekly schedule, and the materialized scheduled tasks.
 *
 * This is where the product's rules stop being descriptions and become
 * constraints. The architecture lists the invariants the database must enforce
 * and says why: they have to hold for code paths that do not exist yet. Every
 * one of them that a single row or a single key can express is written here as
 * a check constraint or a unique index. The two that are aggregates, the task
 * count and the ledger balance, cannot be, and the task count is carried by a
 * deferred constraint trigger in the migration that follows this schema.
 *
 * Three modeling decisions are worth stating, because each one turns a rule
 * into a shape rather than a convention:
 *
 * - A task's outcome is one status column plus one instant per outcome. There
 *   is no state in which a task is both completed and missed. Making that
 *   outcome final needs a trigger as well, since a check constraint sees the
 *   row a statement would leave and not the row it started from: the state
 *   machine lives in migration 0005, which the assault suite is what found.
 * - The completion result lives in its own table keyed uniquely on the task,
 *   so "one completion result per scheduled task" is a unique index rather
 *   than a rule the completion service has to remember.
 * - `paused_at` is an instant on the challenge, not a per-task flag. Pause is
 *   a mode: the sweep consumes tasks as their own cutoffs pass, and the mode
 *   ends only when the user resumes.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { accounts } from "./identity.ts";

/** Matches the contract's `challengeStatus`. */
export const challengeStatus = pgEnum("challenge_status", [
  "active",
  "recovery_pending",
  "succeeded",
  "failed",
  "expired",
]);

/** Matches the contract's `taskStatus`. */
export const taskStatus = pgEnum("task_status", [
  "scheduled",
  "completed",
  "skipped",
  "missed",
  "forgiven",
]);

/** Matches the contract's `weekday`. */
export const weekday = pgEnum("weekday", [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

/** Matches the contract's `movementProvenance`, label for label. */
export const movementProvenance = pgEnum("movement_provenance", [
  "live-foreground",
  "historical-query",
]);

/** The statuses that hold an account's one challenge slot. */
const OPEN_CHALLENGE_STATUSES = sql`('active', 'recovery_pending')`;

/** The statuses from which no transition exists. */
const TERMINAL_CHALLENGE_STATUSES = sql`('succeeded', 'failed', 'expired')`;

export const challenges = pgTable(
  "challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    status: challengeStatus("status").notNull().default("active"),
    /** How many completions the challenge needs. Skips and forgivenesses do not count. */
    requiredTaskCount: integer("required_task_count").notNull(),
    stepTarget: integer("step_target").notNull(),
    /** The No Regret duration, as minutes before the deadline. */
    noRegretMinutes: integer("no_regret_minutes").notNull(),
    /** The confirmed IANA zone every task instant was computed in. */
    timeZone: text("time_zone").notNull(),
    /** Minor units, so no part of the system has to agree on a rounding rule. */
    depositMinorUnits: integer("deposit_minor_units").notNull(),
    depositCurrency: text("deposit_currency").notNull().default("USD"),
    /** The terms version accepted at funding, including the recovery window. */
    policyVersion: text("policy_version").notNull(),
    /**
     * The end date if nothing is paused from here on. Stored rather than
     * derived because the maximum duration rule is checked against it at
     * creation and the app shows it.
     */
    projectedEndDate: date("projected_end_date", { mode: "string" }).notNull(),
    /**
     * When the pause mode was set. Null while the challenge is running. A
     * pause has no expiry: only a resume, or the year that expires the
     * challenge, ends it.
     */
    pausedAt: timestamp("paused_at", { withTimezone: true, mode: "date" }),
    /**
     * False once an authorization renewal has failed. The challenge continues
     * unsecured; the app asks for a new card. Always true for a zero deposit
     * challenge, which has nothing to secure.
     */
    depositSecured: boolean("deposit_secured").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    /** When the challenge became `active`, which for a funded one is its webhook. */
    activatedAt: timestamp("activated_at", { withTimezone: true, mode: "date" }),
    /**
     * When the challenge reached a terminal status. One column for all three
     * terminal statuses, so a challenge cannot carry two outcomes.
     */
    terminalAt: timestamp("terminal_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    // One active challenge per account. The slot is held by `recovery_pending`
    // too: that challenge is still running and may return to `active`. Every
    // terminal challenge drops out of the index, which is what gives the
    // account its slot back.
    uniqueIndex("challenges_open_per_account_key")
      .on(table.accountId)
      .where(sql`${table.status} in ${OPEN_CHALLENGE_STATUSES}`),
    // The sweep selects by status across all accounts, so it needs its own index.
    index("challenges_status_idx").on(table.status),
    check("challenges_required_task_count_positive", sql`${table.requiredTaskCount} > 0`),
    check("challenges_step_target_positive", sql`${table.stepTarget} > 0`),
    check("challenges_no_regret_minutes_nonnegative", sql`${table.noRegretMinutes} >= 0`),
    // A deposit is either nothing at all, or at least the processor's minimum,
    // which is the same rule the contract states for the wire.
    check(
      "challenges_deposit_zero_or_funded",
      sql`${table.depositMinorUnits} = 0 or ${table.depositMinorUnits} >= 100`,
    ),
    // One terminal outcome per challenge: the status and the instant agree, so
    // there is no half-closed challenge with an outcome and no time, or a time
    // and no outcome.
    check(
      "challenges_terminal_status_has_instant",
      sql`(${table.status} in ${TERMINAL_CHALLENGE_STATUSES}) = (${table.terminalAt} is not null)`,
    ),
    check(
      "challenges_terminal_after_activation",
      sql`${table.terminalAt} is null or ${table.activatedAt} is null or ${table.terminalAt} >= ${table.activatedAt}`,
    ),
    // Recovery applies only to funded challenges. A zero deposit challenge
    // that misses goes straight to `failed`, because a lifetime allowance must
    // not be consumable on a challenge that costs nothing to fail.
    check(
      "challenges_recovery_requires_deposit",
      sql`${table.status} <> 'recovery_pending' or ${table.depositMinorUnits} > 0`,
    ),
  ],
);

/**
 * The weekly schedule, one row per active weekday.
 *
 * A separate table rather than a JSON column because the composite primary key
 * is what makes a weekday unrepresentable twice in one schedule, and because
 * materialization reads these rows to place task dates.
 */
export const challengeScheduleDays = pgTable(
  "challenge_schedule_days",
  {
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    weekday: weekday("weekday").notNull(),
    /** Wall-clock deadline in the challenge's time zone. Each active day may differ. */
    deadlineLocal: time("deadline_local").notNull(),
  },
  (table) => [primaryKey({ columns: [table.challengeId, table.weekday] })],
);

export const scheduledTasks = pgTable(
  "scheduled_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    /**
     * Materialization order, starting at 1. Appended replacements continue the
     * sequence, so the ordinal identifies a task within its challenge even
     * after a time zone change rewrites its instants.
     */
    sequence: integer("sequence").notNull(),
    /** The calendar date in the challenge's time zone. */
    taskDate: date("task_date", { mode: "string" }).notNull(),
    deadline: timestamp("deadline", { withTimezone: true, mode: "date" }).notNull(),
    /** Deadline minus the No Regret duration. Pausing at or after this leaves the task live. */
    pauseCutoff: timestamp("pause_cutoff", { withTimezone: true, mode: "date" }).notNull(),
    status: taskStatus("status").notNull().default("scheduled"),
    /**
     * When the server acknowledged the completion, not when the device
     * recorded it. Held on the task as well as on the completion row so that
     * every outcome the status can name has its instant in the same place, and
     * so the app's task view is one row.
     */
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true, mode: "date" }),
    /** Set when the pause mode consumed the task. */
    skippedAt: timestamp("skipped_at", { withTimezone: true, mode: "date" }),
    /** Set when the deadline plus the receipt grace passed with no completion. */
    missedAt: timestamp("missed_at", { withTimezone: true, mode: "date" }),
    /**
     * Set when Emergency Recovery superseded the miss. One column, so a task
     * cannot be forgiven twice, and the miss it supersedes is preserved rather
     * than deleted.
     */
    forgivenAt: timestamp("forgiven_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("scheduled_tasks_challenge_sequence_key").on(table.challengeId, table.sequence),
    // A challenge has at most one task on a calendar date. A replacement for a
    // skipped or forgiven task is appended at the next eligible weekday past
    // the last one, never onto a date already spoken for.
    uniqueIndex("scheduled_tasks_challenge_date_key").on(table.challengeId, table.taskDate),
    // The sweep selects overdue tasks by deadline across all challenges.
    index("scheduled_tasks_deadline_idx").on(table.status, table.deadline),
    // And selects tasks whose pause cutoff has passed, for paused challenges.
    index("scheduled_tasks_pause_cutoff_idx").on(table.status, table.pauseCutoff),
    check("scheduled_tasks_sequence_positive", sql`${table.sequence} > 0`),
    // The cutoff is the deadline minus a non-negative No Regret duration, so
    // the two coincide only when that duration is zero.
    check(
      "scheduled_tasks_cutoff_at_or_before_deadline",
      sql`${table.pauseCutoff} <= ${table.deadline}`,
    ),
    // Each outcome instant is set exactly when its status says so. Together
    // with the single status column this is "one terminal outcome per task".
    check(
      "scheduled_tasks_completed_status_has_instant",
      sql`(${table.status} = 'completed') = (${table.acknowledgedAt} is not null)`,
    ),
    check(
      "scheduled_tasks_skipped_status_has_instant",
      sql`(${table.status} = 'skipped') = (${table.skippedAt} is not null)`,
    ),
    // `missed` is the one outcome that survives its own transition: a forgiven
    // task is a missed task that recovery superseded, so it keeps its miss.
    check(
      "scheduled_tasks_missed_status_has_instant",
      sql`(${table.status} in ('missed', 'forgiven')) = (${table.missedAt} is not null)`,
    ),
    check(
      "scheduled_tasks_forgiven_status_has_instant",
      sql`(${table.status} = 'forgiven') = (${table.forgivenAt} is not null)`,
    ),
    check(
      "scheduled_tasks_forgiven_after_missed",
      sql`${table.forgivenAt} is null or ${table.forgivenAt} >= ${table.missedAt}`,
    ),
  ],
);

/**
 * The completion result for a task: what the device observed, and when the
 * server acknowledged it.
 *
 * Its own table because a completion is evidence, not a flag. The unique key on
 * the task is the invariant "one completion result per scheduled task", and it
 * is what makes a duplicate delivery of the same completion a database error
 * rather than a second row nobody notices.
 */
export const taskCompletions = pgTable(
  "task_completions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => scheduledTasks.id, { onDelete: "cascade" }),
    /** When the device evaluated the step target, by the device's clock. */
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }).notNull(),
    /** When the server acknowledged it. This is the instant the deadline is judged against. */
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    observationStartedAt: timestamp("observation_started_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    observationEndedAt: timestamp("observation_ended_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    steps: integer("steps").notNull(),
    provenance: movementProvenance("provenance").notNull(),
    /** The platform reader, kept for auditing a completion after a policy change. */
    source: text("source").notNull(),
    appVersion: text("app_version").notNull(),
    verificationPolicyVersion: text("verification_policy_version").notNull(),
  },
  (table) => [
    uniqueIndex("task_completions_task_key").on(table.taskId),
    check("task_completions_steps_nonnegative", sql`${table.steps} >= 0`),
    check(
      "task_completions_observation_ordered",
      sql`${table.observationEndedAt} >= ${table.observationStartedAt}`,
    ),
  ],
);
