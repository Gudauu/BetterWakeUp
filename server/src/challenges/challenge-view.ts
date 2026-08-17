/**
 * Rendering the stored challenge as the app sees it.
 *
 * One reader, used by every command that answers with a challenge. Creation
 * reads it back through its own transaction rather than assembling the
 * response from what it just inserted, so the response describes rows that
 * exist rather than intentions that might not have committed, and so the
 * defaults the database applies are the ones the app is told about.
 *
 * Two fields are derived here rather than stored, because storing them would
 * mean keeping them true:
 *
 * - `pause.expiresAt` is the paused instant plus the maximum pause length. It
 *   is null while the challenge is running, which is the same thing as saying
 *   a challenge that is not paused has no pause to expire.
 * - `recoveryOffer` is the missed task that opened the offer plus the recovery
 *   window. It is present only in `recovery_pending`, which is the only status
 *   in which an offer stands.
 */

import {
  type ChallengeView,
  MAXIMUM_PAUSE_DAYS,
  RECOVERY_WINDOW_HOURS,
  type TaskView,
  type Weekday,
} from "@betterwakeup/contract";
import { asc, eq } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { challengeScheduleDays, challenges, scheduledTasks } from "../db/schema/challenges.ts";
import { AppError } from "../errors/app-error.ts";

/** A handle that can read. Both a `Database` and a transaction satisfy it. */
type Readable = Pick<Database, "select">;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Schedule days are returned in week order, so two equal schedules compare equal. */
const WEEK_ORDER: readonly Weekday[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

/**
 * The challenge with `challengeId`, as the contract's `challengeView`.
 *
 * Three reads rather than one join: a join across the schedule days and the
 * tasks multiplies rows by both and would have to be unpicked again, and the
 * challenge is a single row addressed by its primary key either way.
 */
export async function loadChallengeView(db: Readable, challengeId: string): Promise<ChallengeView> {
  const [challenge] = await db.select().from(challenges).where(eq(challenges.id, challengeId));
  if (challenge === undefined) {
    throw new AppError("not_found", "No challenge with this identifier.");
  }

  const days = await db
    .select()
    .from(challengeScheduleDays)
    .where(eq(challengeScheduleDays.challengeId, challengeId));
  const tasks = await db
    .select()
    .from(scheduledTasks)
    .where(eq(scheduledTasks.challengeId, challengeId))
    .orderBy(asc(scheduledTasks.sequence));

  return {
    id: challenge.id,
    status: challenge.status,
    configuration: {
      requiredTaskCount: challenge.requiredTaskCount,
      schedule: days
        .map((day) => ({
          weekday: day.weekday,
          // The column is a `time`, which reads back with seconds the contract
          // does not carry.
          deadline: day.deadlineLocal.slice(0, 5),
        }))
        .sort(
          (left, right) => WEEK_ORDER.indexOf(left.weekday) - WEEK_ORDER.indexOf(right.weekday),
        ),
      stepTarget: challenge.stepTarget,
      noRegretMinutes: challenge.noRegretMinutes,
      timeZone: challenge.timeZone,
      deposit: {
        amount: challenge.depositMinorUnits,
        // The column exists so a second currency is not a migration; version 1
        // prices in USD only, which is what the contract's literal says.
        currency: "USD",
      },
    },
    policyVersion: challenge.policyVersion,
    createdAt: challenge.createdAt.toISOString(),
    activatedAt: challenge.activatedAt?.toISOString() ?? null,
    projectedEndDate: challenge.projectedEndDate,
    pause: {
      pausedAt: challenge.pausedAt?.toISOString() ?? null,
      expiresAt:
        challenge.pausedAt === null
          ? null
          : new Date(challenge.pausedAt.getTime() + MAXIMUM_PAUSE_DAYS * DAY_MS).toISOString(),
    },
    progress: {
      requiredTaskCount: challenge.requiredTaskCount,
      completedTaskCount: countStatus(tasks, "completed"),
      skippedTaskCount: countStatus(tasks, "skipped"),
      forgivenTaskCount: countStatus(tasks, "forgiven"),
    },
    depositSecured: challenge.depositSecured,
    currentTask: currentTaskOf(tasks),
    recoveryOffer: challenge.status === "recovery_pending" ? recoveryOfferOf(tasks) : null,
  };
}

type TaskRow = typeof scheduledTasks.$inferSelect;

function countStatus(tasks: readonly TaskRow[], status: TaskRow["status"]): number {
  return tasks.filter((task) => task.status === status).length;
}

export function taskViewOf(task: TaskRow): TaskView {
  return {
    id: task.id,
    date: task.taskDate,
    deadline: task.deadline.toISOString(),
    pauseCutoff: task.pauseCutoff.toISOString(),
    status: task.status,
    acknowledgedAt: task.acknowledgedAt?.toISOString() ?? null,
  };
}

/**
 * The next task still open.
 *
 * Ordering is by sequence, which is materialization order and therefore also
 * date order: a replacement task is appended past the last date the challenge
 * holds, so the two never disagree.
 */
function currentTaskOf(tasks: readonly TaskRow[]): TaskView | null {
  const open = tasks.find((task) => task.status === "scheduled");
  return open === undefined ? null : taskViewOf(open);
}

/**
 * The standing Emergency Recovery offer.
 *
 * The offer belongs to the miss that opened it, so it is the latest missed
 * task: an earlier miss would already have ended the challenge. A
 * `recovery_pending` challenge with no missed task is not a state any path
 * produces, and answering it with no offer would leave the app showing a
 * challenge it cannot act on, so it is our bug and reported as one.
 */
function recoveryOfferOf(tasks: readonly TaskRow[]): ChallengeView["recoveryOffer"] {
  const missed = tasks.filter((task) => task.status === "missed" && task.missedAt !== null);
  const latest = missed[missed.length - 1];
  if (latest?.missedAt == null) {
    throw new AppError(
      "internal_error",
      "a challenge awaiting Emergency Recovery has no missed task to offer it for",
    );
  }
  return {
    taskId: latest.id,
    offeredAt: latest.missedAt.toISOString(),
    expiresAt: new Date(latest.missedAt.getTime() + RECOVERY_WINDOW_HOURS * HOUR_MS).toISOString(),
  };
}
