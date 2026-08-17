/**
 * Entering and leaving pause mode.
 *
 * `POST /challenges/:challengeId/pause` sets the mode and
 * `DELETE /challenges/:challengeId/pause` clears it. Neither acts on a task:
 * pausing skips nothing, and resuming un-skips nothing. What the mode does is
 * decide, at each pause cutoff, whether the task that cutoff belongs to is one
 * the user faces or one the pause consumes, and `pause-skips.ts` is where that
 * decision is applied.
 *
 * Both ends bind at the cutoff boundary, which is the whole of the user-facing
 * rule:
 *
 * - A pause set at or after a task's cutoff leaves that task live. The user
 *   already lost the notice the No Regret duration promises, so the task they
 *   are inside of stays theirs, and the response names the first task the pause
 *   will actually consume so the app can say which one before the user confirms.
 * - A resume issued at or after a task's cutoff takes effect on the following
 *   task. That is not a rule this command applies by itself: it falls out of
 *   consuming, in the resuming transaction, every task whose cutoff passed
 *   while the mode was set. The sweep would have consumed those tasks; a resume
 *   arriving before it did must not hand them back.
 *
 * A pause has no limit and no expiry. Nothing here schedules a resume, and no
 * other module clears `paused_at`, so a challenge only ever leaves the mode
 * because its user asked. The year that expires a paused challenge is the
 * sweep's, and it ends the challenge rather than resuming it.
 */

import type {
  PauseChallengeResponse,
  ResumeChallengeResponse,
  TaskView,
} from "@betterwakeup/contract";
import { and, asc, eq, gt } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { challenges, scheduledTasks } from "../db/schema/challenges.ts";
import { AppError } from "../errors/app-error.ts";
import { runIdempotent, type Transaction } from "../idempotency/service.ts";
import { loadChallengeView, taskViewOf } from "./challenge-view.ts";
import { skipTasksConsumedByPause } from "./pause-skips.ts";

export interface PauseDependencies {
  readonly db: Database;
  /** The clock the cutoff boundary is judged against. A test states the moment. */
  readonly now?: (() => Date) | undefined;
}

export interface PauseCommand {
  readonly accountId: string;
  readonly challengeId: string;
  readonly idempotencyKey: string;
}

export async function pauseChallenge(
  deps: PauseDependencies,
  command: PauseCommand,
): Promise<{ response: PauseChallengeResponse; replayed: boolean }> {
  const at = (deps.now ?? (() => new Date()))();

  const outcome = await runIdempotent(
    deps.db,
    {
      accountId: command.accountId,
      key: command.idempotencyKey,
      commandType: "pauseChallenge",
      request: { challengeId: command.challengeId },
    },
    async (tx) => await enterPause(tx, command, at),
  );
  return { response: outcome.result, replayed: outcome.replayed };
}

export async function resumeChallenge(
  deps: PauseDependencies,
  command: PauseCommand,
): Promise<{ response: ResumeChallengeResponse; replayed: boolean }> {
  const at = (deps.now ?? (() => new Date()))();

  const outcome = await runIdempotent(
    deps.db,
    {
      accountId: command.accountId,
      key: command.idempotencyKey,
      commandType: "resumeChallenge",
      request: { challengeId: command.challengeId },
    },
    async (tx) => await leavePause(tx, command, at),
  );
  return { response: outcome.result, replayed: outcome.replayed };
}

async function enterPause(
  tx: Transaction,
  command: PauseCommand,
  at: Date,
): Promise<PauseChallengeResponse> {
  const challenge = await lockChallenge(tx, command);
  if (challenge.pausedAt !== null) {
    throw new AppError(
      "challenge_already_paused",
      "This challenge is already paused. Resume it before pausing it again.",
    );
  }

  await tx
    .update(challenges)
    .set({ pausedAt: at, updatedAt: at })
    .where(eq(challenges.id, challenge.id));

  return {
    challenge: await loadChallengeView(tx, challenge.id),
    // Strictly after the pause instant: the task whose cutoff has already
    // passed is one this pause leaves live, so naming it would tell the user
    // the pause takes a task it does not take.
    nextSkippedTask: await firstOpenTaskAfter(tx, challenge.id, at),
  };
}

async function leavePause(
  tx: Transaction,
  command: PauseCommand,
  at: Date,
): Promise<ResumeChallengeResponse> {
  const challenge = await lockChallenge(tx, command);
  if (challenge.pausedAt === null) {
    throw new AppError("challenge_not_paused", "This challenge is not paused.");
  }

  // Everything the pause consumed before this instant, consumed now. Doing it
  // here rather than leaving it to the sweep is what makes the boundary the
  // cutoff rather than whenever the next pass happens to run.
  await skipTasksConsumedByPause(tx, challenge.id, at);

  await tx
    .update(challenges)
    .set({ pausedAt: null, updatedAt: at })
    .where(eq(challenges.id, challenge.id));

  return {
    challenge: await loadChallengeView(tx, challenge.id),
    // Every task the pause consumed is now `skipped`, so the first open task is
    // the one the user faces. It can be a task whose cutoff passed before the
    // pause was ever set: that one stayed live throughout and is still theirs.
    nextLiveTask: await firstOpenTask(tx, challenge.id),
  };
}

/** The challenge fields both commands decide on, read under a row lock. */
interface LockedChallenge {
  readonly id: string;
  readonly pausedAt: Date | null;
}

/**
 * The challenge, locked, refusing anything that is not a running challenge.
 *
 * The account is part of the predicate even though the session gate has already
 * proved ownership: a row that has gone since is answered the same way an
 * unknown one is.
 *
 * `recovery_pending` is refused along with the terminal statuses. A challenge
 * awaiting Emergency Recovery is waiting on one decision with a deadline of its
 * own, and letting a pause suspend that clock would turn the recovery window
 * into an unbounded one.
 */
async function lockChallenge(tx: Transaction, command: PauseCommand): Promise<LockedChallenge> {
  const [row] = await tx
    .select({
      id: challenges.id,
      status: challenges.status,
      pausedAt: challenges.pausedAt,
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
      `This challenge is ${row.status}, so its pause mode cannot be changed.`,
    );
  }
  return { id: row.id, pausedAt: row.pausedAt };
}

/** The earliest open task whose cutoff is strictly after `at`, or null. */
async function firstOpenTaskAfter(
  tx: Transaction,
  challengeId: string,
  at: Date,
): Promise<TaskView | null> {
  const [task] = await tx
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
    .limit(1);
  return task === undefined ? null : taskViewOf(task);
}

/** The earliest open task, whatever its cutoff, or null. */
async function firstOpenTask(tx: Transaction, challengeId: string): Promise<TaskView | null> {
  const [task] = await tx
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.challengeId, challengeId), eq(scheduledTasks.status, "scheduled")))
    .orderBy(asc(scheduledTasks.sequence))
    .limit(1);
  return task === undefined ? null : taskViewOf(task);
}
