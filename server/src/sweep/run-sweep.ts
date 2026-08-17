/**
 * The scheduled sweep.
 *
 * EventBridge Scheduler invokes the Lambda, the handler discriminates the
 * scheduled event before any application code runs, and this is where it
 * arrives. The pass is the architecture's, in its order:
 *
 * 0. Expire challenges paused for a year, and consume the tasks whose pause
 *    cutoffs have passed.
 * 1. Select tasks past their deadline and receipt grace with no acknowledged
 *    completion.
 * 2. Lock a bounded batch with `for update skip locked`.
 * 3. Mark them `missed`.
 * 4. Move each affected challenge to `recovery_pending` or `failed`.
 * 5. Create settlement commands with an `execute_after` instant.
 * 6. Execute due settlement commands. **Not here.** Issue 25 owns execution,
 *    and the separation is the architecture's: no capture happens in the
 *    transaction that fails a challenge, so a user who opens the app later
 *    still has an intact authorization to recover against.
 * 7. Renew authorizations approaching `capture_before`, which is where a
 *    challenge outliving several holds stays secured.
 * 8. Repeat until no due batch remains.
 *
 * Step 0 before step 1 is the ordering that matters, and it is enforced by this
 * function alone: a skipped task's deadline passes like any other, so judging
 * overdue tasks first would fail a challenge the user had already paused.
 *
 * **The sweep is idempotent.** Nothing here reads a counter or advances a
 * cursor. Every unit of work is selected by the state that makes it due and
 * ends by leaving that state, so a second invocation over the same data selects
 * nothing and writes nothing. That is what makes running it twice the same as
 * running it once, and it is also what makes a crashed pass safe to repeat.
 *
 * **The sweep never waits.** Every row it takes is taken with skip locked, so
 * two invocations take disjoint work and a row some user's command is holding
 * is left for the next invocation rather than fought over. A daily pass with
 * extra ticks through the hours that contain deadlines means nothing is
 * required to happen within minutes of one.
 */

import type { Database } from "../db/client.ts";
import type { ScheduledEvent } from "../lambda/events.ts";
import type { Logger } from "../observability/logger.ts";
import type { PaymentProviderClient } from "../payments/provider.ts";
import { runRenewalPass } from "../payments/renewal.ts";
import { runOverduePass } from "./overdue-pass.ts";
import { runPausePass } from "./pause-pass.ts";

/**
 * How much one pass takes before looking again.
 *
 * Small on purpose: the architecture asks for frequency rather than batch size
 * to clear a backlog, so that one invocation stays well inside the Lambda
 * timeout even when every unit of work is slow.
 */
const DEFAULT_BATCH_SIZE = 50;

/**
 * How many times an invocation repeats step 8 before reporting a backlog.
 *
 * Reaching this is not an error. It is the sweep saying the queue was deeper
 * than one invocation, which the next scheduled tick continues from with no
 * state carried between them.
 */
const DEFAULT_MAX_PASSES = 10;

export interface SweepResult {
  /** Overdue tasks marked `missed`. */
  readonly tasksMissed: number;
  /** Tasks the pause mode consumed, each with a replacement appended. */
  readonly tasksSkipped: number;
  /** Both of the above: how much of the backlog this invocation resolved. */
  readonly tasksResolved: number;
  readonly challengesFailed: number;
  readonly challengesInRecovery: number;
  /** Challenges expired after a year of pause. */
  readonly challengesExpired: number;
  /** Settlement commands written. None of them executed. */
  readonly settlementsCreated: number;
  /** Deposit holds replaced by a fresh one before their window ran out. */
  readonly authorizationsRenewed: number;
  /** Holds the provider refused to renew, leaving those deposits unsecured. */
  readonly renewalsFailed: number;
  /** Whether work remained when the pass stopped. */
  readonly moreWorkPending: boolean;
}

export interface SweepDependencies {
  readonly db: Database;
  /**
   * The payment provider, when one is configured.
   *
   * Optional because everything except renewal is provider-free: a deployment
   * with no provider still misses tasks, fails challenges, and writes the
   * settlement commands it will execute once one exists. Renewal is the one
   * step that reaches a network, so it is the one step that is skipped.
   */
  readonly provider?: PaymentProviderClient | undefined;
  /** The instant the whole invocation reasons from. A test states the moment. */
  readonly now?: (() => Date) | undefined;
  readonly batchSize?: number | undefined;
  readonly maxPasses?: number | undefined;
}

/** What the Lambda handler's scheduled arm calls. */
export type SweepRunner = (event: ScheduledEvent, logger: Logger) => Promise<SweepResult>;

export function createSweep(deps: SweepDependencies): SweepRunner {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxPasses = deps.maxPasses ?? DEFAULT_MAX_PASSES;

  return async (_event, logger) => {
    // One instant for the whole invocation, so a task is not judged against a
    // clock that moved between two of its own rules, and so a test can state
    // the moment a boundary is tested at. Every comparison carries it into SQL
    // as a parameter rather than reading the database's own `now()`.
    const now = (deps.now ?? (() => new Date()))();

    // Passed over rather than resolved: rows another writer held. Carried
    // across passes so a repeat does not choose the same held row again and
    // spend the whole invocation on it.
    const passedOver = new Set<string>();
    // Holds this invocation already tried to renew. A decline leaves the row
    // due, so without this the pass would spend its ceiling on one card.
    const attemptedRenewals = new Set<string>();
    const totals = {
      tasksMissed: 0,
      tasksSkipped: 0,
      challengesFailed: 0,
      challengesInRecovery: 0,
      challengesExpired: 0,
      settlementsCreated: 0,
      authorizationsRenewed: 0,
      renewalsFailed: 0,
    };
    let moreWorkPending = false;

    for (let pass = 0; pass < maxPasses; pass += 1) {
      const pause = await runPausePass({ db: deps.db, now, batchSize });
      const overdue = await runOverduePass({ db: deps.db, now, batchSize, passedOver });

      totals.tasksSkipped += pause.tasksSkipped;
      totals.challengesExpired += pause.challengesExpired;
      totals.tasksMissed += overdue.tasksMissed;
      totals.challengesFailed += overdue.challengesFailed;
      totals.challengesInRecovery += overdue.challengesInRecovery;
      totals.settlementsCreated += pause.settlementsCreated + overdue.settlementsCreated;

      // Step 7. After the overdue pass rather than before it, because a
      // challenge that has just failed no longer needs its hold renewed, and
      // renewing one the same invocation is about to stop relying on is a
      // provider call for nothing.
      const renewal =
        deps.provider === undefined
          ? { authorizationsRenewed: 0, renewalsFailed: 0, moreWorkPending: false }
          : await runRenewalPass({
              db: deps.db,
              provider: deps.provider,
              now,
              batchSize,
              logger,
              attempted: attemptedRenewals,
            });
      totals.authorizationsRenewed += renewal.authorizationsRenewed;
      totals.renewalsFailed += renewal.renewalsFailed;

      moreWorkPending = pause.moreWorkPending || overdue.moreWorkPending || renewal.moreWorkPending;
      if (!moreWorkPending) break;
    }

    const result: SweepResult = {
      ...totals,
      tasksResolved: totals.tasksMissed + totals.tasksSkipped,
      moreWorkPending,
    };
    logger.info("sweep completed", {
      command: "sweep",
      result: result.moreWorkPending ? "backlog_remaining" : "drained",
    });
    return result;
  };
}

/**
 * The runner a handler with no database handle falls back to.
 *
 * The server still has no composition root: `createHandler` is constructed at
 * module load and nothing decides where a database handle is opened across
 * invocations. Answering with an explicit "not configured" line is honest about
 * that, and it is what a deployment would page on; guessing a connection string
 * here would hide the gap instead.
 */
export const unconfiguredSweep: SweepRunner = async (_event, logger) => {
  logger.error("sweep invoked with no database configured", {
    command: "sweep",
    result: "not_configured",
    errorClassification: "internal",
    errorCode: "internal_error",
  });
  return await Promise.resolve({
    tasksMissed: 0,
    tasksSkipped: 0,
    tasksResolved: 0,
    challengesFailed: 0,
    challengesInRecovery: 0,
    challengesExpired: 0,
    settlementsCreated: 0,
    authorizationsRenewed: 0,
    renewalsFailed: 0,
    moreWorkPending: false,
  });
};
