/**
 * Step 0 of the sweep: everything the pause mode owes, before any task is
 * judged overdue.
 *
 * Two things happen here, in this order:
 *
 * 1. A challenge paused for a year is expired, and its authorization released.
 * 2. Every task whose own pause cutoff passed while the mode was set is
 *    consumed, one transaction per task, by the same code the resume command
 *    runs.
 *
 * Expiry comes first only to save work: an expired challenge is no longer
 * `active`, so it drops out of the consumption candidates and the sweep does
 * not skip tasks belonging to a challenge that has just ended.
 *
 * The ordering against step 1 is the load-bearing one, and it is stated in the
 * architecture: a skipped task's deadline passes like any other, so evaluating
 * overdue tasks first would fail a challenge the user had already paused. The
 * sweep's entry point is what enforces it; this module is one half of the pair.
 *
 * Every candidate is taken with `for update skip locked`, so two invocations
 * take disjoint challenges and neither waits for the other. A challenge another
 * writer holds is not an error and not a retry: it is left for the next pass,
 * which is the only reading that keeps one slow resume from stalling a sweep.
 */

import { MAXIMUM_PAUSE_DAYS } from "@betterwakeup/contract";
import { and, eq, exists, gt, isNotNull, lte, sql } from "drizzle-orm";
import { skipTasksConsumedByPause } from "../challenges/pause-skips.ts";
import type { Database } from "../db/client.ts";
import { challenges, scheduledTasks } from "../db/schema/challenges.ts";
import { createSettlementCommand } from "./payment-commands.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PausePassResult {
  readonly challengesExpired: number;
  readonly tasksSkipped: number;
  readonly settlementsCreated: number;
  /** True when the pass stopped on its ceiling rather than on running out. */
  readonly moreWorkPending: boolean;
}

export interface PausePassOptions {
  readonly db: Database;
  readonly now: Date;
  /** How many challenges one pass will take. */
  readonly batchSize: number;
}

/**
 * Expires challenges paused past the maximum, and consumes the tasks the pause
 * has spent.
 */
export async function runPausePass(options: PausePassOptions): Promise<PausePassResult> {
  const expired = await expireLongPauses(options);
  const consumed = await consumePausedTasks(options);
  return {
    challengesExpired: expired.challenges,
    settlementsCreated: expired.settlements,
    tasksSkipped: consumed.tasks,
    moreWorkPending: expired.moreWorkPending || consumed.moreWorkPending,
  };
}

/**
 * A pause has no expiry of its own; the challenge does.
 *
 * The architecture cancels the authorization on expiry and charges nothing, so
 * this creates a release command and no capture. A zero deposit challenge
 * expires exactly the same way with no command at all, which is the difference
 * the acceptance boundary asks about.
 */
async function expireLongPauses(
  options: PausePassOptions,
): Promise<{ challenges: number; settlements: number; moreWorkPending: boolean }> {
  const pausedBefore = new Date(options.now.getTime() - MAXIMUM_PAUSE_DAYS * DAY_MS);
  let expired = 0;
  let settlements = 0;

  for (let taken = 0; taken < options.batchSize; taken += 1) {
    const done = await options.db.transaction(async (tx) => {
      const [challenge] = await tx
        .select({ id: challenges.id, depositMinorUnits: challenges.depositMinorUnits })
        .from(challenges)
        .where(
          and(
            eq(challenges.status, "active"),
            isNotNull(challenges.pausedAt),
            lte(challenges.pausedAt, pausedBefore),
          ),
        )
        .for("update", { skipLocked: true })
        .limit(1);
      if (challenge === undefined) return false;

      await tx
        .update(challenges)
        .set({ status: "expired", terminalAt: options.now, updatedAt: options.now })
        .where(and(eq(challenges.id, challenge.id), eq(challenges.status, "active")));
      expired += 1;

      if (challenge.depositMinorUnits > 0) {
        const created = await createSettlementCommand(tx, {
          challengeId: challenge.id,
          kind: "release_authorization",
          executeAfter: options.now,
        });
        if (created) settlements += 1;
      }
      return true;
    });
    if (!done) return { challenges: expired, settlements, moreWorkPending: false };
  }
  return { challenges: expired, settlements, moreWorkPending: true };
}

/**
 * Consumes the tasks whose cutoffs passed while the mode was set.
 *
 * One challenge per transaction rather than one task, because
 * `skipTasksConsumedByPause` already loops until the challenge owes nothing:
 * splitting that across transactions would leave a challenge whose replacement
 * task also has a passed cutoff live until the next invocation, which is the
 * case the resume command had to handle too.
 */
async function consumePausedTasks(
  options: PausePassOptions,
): Promise<{ tasks: number; moreWorkPending: boolean }> {
  let skipped = 0;

  for (let taken = 0; taken < options.batchSize; taken += 1) {
    const done = await options.db.transaction(async (tx) => {
      const [challenge] = await tx
        .select({ id: challenges.id })
        .from(challenges)
        .where(
          and(
            eq(challenges.status, "active"),
            isNotNull(challenges.pausedAt),
            owesPauseSkip(options.now),
          ),
        )
        .for("update", { skipLocked: true })
        .limit(1);
      if (challenge === undefined) return false;

      const skips = await skipTasksConsumedByPause(tx, challenge.id, options.now);
      skipped += skips.length;
      return true;
    });
    if (!done) return { tasks: skipped, moreWorkPending: false };
  }
  return { tasks: skipped, moreWorkPending: true };
}

/**
 * The challenge holds an open task the pause has already spent.
 *
 * The same `(pausedAt, now]` window the consumption itself uses, restated as a
 * predicate so a challenge with nothing due is never taken, and so a challenge
 * the sweep has just finished with does not come back in the next iteration.
 */
function owesPauseSkip(now: Date) {
  return exists(
    sql`(select 1 from ${scheduledTasks} where ${and(
      eq(scheduledTasks.challengeId, challenges.id),
      eq(scheduledTasks.status, "scheduled"),
      gt(scheduledTasks.pauseCutoff, challenges.pausedAt),
      lte(scheduledTasks.pauseCutoff, now),
    )} limit 1)`,
  );
}
