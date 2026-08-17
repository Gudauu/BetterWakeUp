/**
 * Changing a running challenge's time zone.
 *
 * A challenge's schedule is a wall-clock time on a weekday, so the instants a
 * task is judged against only exist once a zone is chosen. When the user moves,
 * the wall-clock promise is what they want kept: an 08:00 deadline stays 08:00
 * where they now are. Every task keeps its calendar date and its sequence, and
 * only its deadline and pause cutoff move.
 *
 * Which tasks move is the whole of the rule, and it is stated against a stored
 * instant:
 *
 * > Re-materialize only tasks whose stored pause cutoff is strictly later than
 * > the instant the command is received.
 *
 * That boundary is not the same as "tasks that have not started", and the
 * difference is the reason the architecture words it this way. A task can have a
 * passed pause cutoff and a deadline still hours ahead, and the two readings
 * disagree about it. The cutoff is what the user was promised: once it passes,
 * they can no longer pause that task, so the terms it is judged on are settled
 * and a command issued afterward must not restate them. A task in that state is
 * left exactly as it is, in the zone it was materialized in.
 *
 * Everything with a resolved outcome (completed, missed, forgiven, skipped) is
 * outside the rule for the same reason and is additionally excluded by status:
 * a finished task's instants are part of the record of what happened.
 *
 * One consequence is worth stating rather than discovering. Moving eastward
 * moves a deadline earlier, so a task whose cutoff was still ahead can come out
 * of the change with a deadline that has already passed, and the sweep will
 * treat it as missed. Nothing upstream states a policy for that case, so this
 * command applies the rule as written rather than inventing a refusal, and the
 * test suite pins the behavior instead of leaving it accidental.
 */

import type { ChangeTimeZoneResponse, TaskView } from "@betterwakeup/contract";
import { and, asc, eq, gt } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { challenges, scheduledTasks } from "../db/schema/challenges.ts";
import { AppError } from "../errors/app-error.ts";
import { runIdempotent, type Transaction } from "../idempotency/service.ts";
import { type ScheduleConfiguration, taskInstants } from "../schedule/engine.ts";
import { loadChallengeView, taskViewOf } from "./challenge-view.ts";
import { loadWeeklySchedule } from "./weekly-schedule.ts";

export interface ChangeTimeZoneDependencies {
  readonly db: Database;
  /** The clock the cutoff boundary is judged against. A test states the moment. */
  readonly now?: (() => Date) | undefined;
}

export interface ChangeTimeZoneCommand {
  readonly accountId: string;
  readonly challengeId: string;
  readonly idempotencyKey: string;
  /** An IANA zone. The validation boundary has already rejected anything else. */
  readonly timeZone: string;
}

export async function changeChallengeTimeZone(
  deps: ChangeTimeZoneDependencies,
  command: ChangeTimeZoneCommand,
): Promise<{ response: ChangeTimeZoneResponse; replayed: boolean }> {
  const at = (deps.now ?? (() => new Date()))();

  const outcome = await runIdempotent(
    deps.db,
    {
      accountId: command.accountId,
      key: command.idempotencyKey,
      commandType: "changeChallengeTimeZone",
      request: { challengeId: command.challengeId, timeZone: command.timeZone },
    },
    async (tx) => await rematerialize(tx, command, at),
  );
  return { response: outcome.result, replayed: outcome.replayed };
}

async function rematerialize(
  tx: Transaction,
  command: ChangeTimeZoneCommand,
  at: Date,
): Promise<ChangeTimeZoneResponse> {
  const challenge = await lockChallenge(tx, command);

  // The same zone is not a smaller version of a move, it is not a move. Writing
  // the identical instants back would leave `updated_at` claiming a change the
  // user did not make, and would report tasks as re-materialized that nothing
  // happened to.
  if (challenge.timeZone === command.timeZone) {
    return { challenge: await loadChallengeView(tx, challenge.id), rematerializedTasks: [] };
  }

  const configuration: ScheduleConfiguration = {
    requiredTaskCount: challenge.requiredTaskCount,
    noRegretMinutes: challenge.noRegretMinutes,
    timeZone: command.timeZone,
    schedule: await loadWeeklySchedule(tx, challenge.id),
  };

  await tx
    .update(challenges)
    .set({ timeZone: command.timeZone, updatedAt: at })
    .where(eq(challenges.id, challenge.id));

  const moved: TaskView[] = [];
  for (const task of await tasksAheadOfTheirCutoff(tx, challenge.id, at)) {
    const instants = taskInstants(configuration, task.taskDate, task.sequence);
    const [updated] = await tx
      .update(scheduledTasks)
      .set({
        deadline: instants.deadline,
        pauseCutoff: instants.pauseCutoff,
        updatedAt: at,
      })
      // The status is in the predicate as well as in the read, so a task another
      // writer resolved between the two is not rewritten by this one.
      .where(and(eq(scheduledTasks.id, task.id), eq(scheduledTasks.status, "scheduled")))
      .returning();
    if (updated === undefined) {
      throw new AppError("internal_error", "the time zone change matched no open task");
    }
    moved.push(taskViewOf(updated));
  }

  return { challenge: await loadChallengeView(tx, challenge.id), rematerializedTasks: moved };
}

/** The challenge fields the command decides on, read under a row lock. */
interface LockedChallenge {
  readonly id: string;
  readonly timeZone: string;
  readonly requiredTaskCount: number;
  readonly noRegretMinutes: number;
}

/**
 * The challenge, locked, refusing anything that is not a running challenge.
 *
 * The lock makes this and any writer that resolves one of the same tasks
 * mutually exclusive, which is what stops a task from being moved into a zone
 * after a completion or a pause skip decided it under the old one.
 *
 * A paused challenge is accepted: the mode suspends tasks, not the challenge's
 * relationship to a clock, and the user who moves is exactly the user who is
 * likely to be paused. `recovery_pending` is refused along with the terminal
 * statuses, because that challenge is waiting on one decision whose own window
 * is measured from a missed task, and a command that moves instants underneath
 * it would change what that decision is about.
 */
async function lockChallenge(
  tx: Transaction,
  command: ChangeTimeZoneCommand,
): Promise<LockedChallenge> {
  const [row] = await tx
    .select({
      id: challenges.id,
      status: challenges.status,
      timeZone: challenges.timeZone,
      requiredTaskCount: challenges.requiredTaskCount,
      noRegretMinutes: challenges.noRegretMinutes,
    })
    .from(challenges)
    .where(and(eq(challenges.id, command.challengeId), eq(challenges.accountId, command.accountId)))
    .for("update")
    .limit(1);

  if (row === undefined) {
    throw new AppError("not_found", "No challenge with this identifier.");
  }
  if (row.status !== "active") {
    throw new AppError(
      "challenge_not_active",
      `This challenge is ${row.status}, so its time zone cannot be changed.`,
    );
  }
  return {
    id: row.id,
    timeZone: row.timeZone,
    requiredTaskCount: row.requiredTaskCount,
    noRegretMinutes: row.noRegretMinutes,
  };
}

/** Open tasks whose stored cutoff is strictly later than the receipt instant, locked. */
async function tasksAheadOfTheirCutoff(
  tx: Transaction,
  challengeId: string,
  at: Date,
): Promise<(typeof scheduledTasks.$inferSelect)[]> {
  return await tx
    .select()
    .from(scheduledTasks)
    .where(
      and(
        eq(scheduledTasks.challengeId, challengeId),
        eq(scheduledTasks.status, "scheduled"),
        gt(scheduledTasks.pauseCutoff, at),
      ),
    )
    .orderBy(asc(scheduledTasks.sequence))
    .for("update");
}
