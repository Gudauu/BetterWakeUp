/**
 * Acknowledging a task completion.
 *
 * This is the command the whole product turns on: until the server has
 * acknowledged a completion it does not count, so every refusal here is a
 * refusal a user feels. The rules are the architecture's, and they are checked
 * in a fixed order for a reason, from the ones that will never pass to the ones
 * that could pass under a different request:
 *
 * 1. The body's `clientRecordId` must be the key the request carries. A pending
 *    record and the key it is retried under are the same identifier, so a
 *    mismatch is a client that has confused two records and would otherwise
 *    have one record's result stored against the other's key.
 * 2. The observation's provenance must be `live-foreground`. Android offers no
 *    historical step query at all, so foreground observation is the only
 *    guarantee both platforms make and the server accepts nothing else.
 * 3. The task must exist, be the caller's, still be open, and belong to an
 *    `active` challenge.
 * 4. The command must have been received no later than the deadline plus the
 *    sixty-second receipt grace.
 * 5. The reported completion instant must fall inside the task window and at or
 *    before the deadline.
 * 6. The observation must reach the challenge's step target.
 *
 * The first two are decided before an idempotency key is claimed. A request
 * that can never succeed should not consume the caller's key, because the fix
 * for both is a corrected request the client sends under a new one.
 *
 * **The receipt instant is the server clock when the command is handled.** The
 * grace exists because the product makes server acknowledgment a hard condition
 * for credit, and the thing it protects against is network variance between the
 * device and here. The idempotency key's own `created_at` is a second reading of
 * the same clock, and it is the one the sweep reads to know a completion is in
 * flight; the two differ only by the duration of an attempt, so they disagree
 * about a completion only when an attempt crashes within a minute of the
 * deadline and is retried. That gap is bounded and stated rather than hidden.
 *
 * The task row is read `for update`, which is what makes this command and the
 * overdue sweep mutually exclusive over one task rather than each correct alone.
 */

import {
  ACCEPTED_COMPLETION_PROVENANCE,
  type CreateCompletionRequest,
  type CreateCompletionResponse,
  RECEIPT_GRACE_SECONDS,
} from "@betterwakeup/contract";
import { and, eq } from "drizzle-orm";
import { taskViewOf } from "../challenges/challenge-view.ts";
import type { Database } from "../db/client.ts";
import { challenges, scheduledTasks, taskCompletions } from "../db/schema/challenges.ts";
import { AppError } from "../errors/app-error.ts";
import { runIdempotent, type Transaction } from "../idempotency/service.ts";
import { startOfLocalDay } from "../schedule/zoned-time.ts";

export interface CreateCompletionDependencies {
  readonly db: Database;
  /** The clock the receipt instant is read from. A test states the moment. */
  readonly now?: (() => Date) | undefined;
}

export interface CreateCompletionCommand {
  readonly accountId: string;
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly body: CreateCompletionRequest;
}

export async function createCompletion(
  deps: CreateCompletionDependencies,
  command: CreateCompletionCommand,
): Promise<{ response: CreateCompletionResponse; replayed: boolean }> {
  assertRecordMatchesKey(command);
  assertProvenanceAccepted(command.body);

  const receivedAt = (deps.now ?? (() => new Date()))();

  const outcome = await runIdempotent(
    deps.db,
    {
      accountId: command.accountId,
      key: command.idempotencyKey,
      commandType: "createCompletion",
      // The task is part of the request's identity: the same record replayed
      // against a different task is a different command, not a retry.
      request: { taskId: command.taskId, ...command.body },
      // And it is recorded as the key's subject, which is how the sweep sees
      // that a completion for this task is in flight and leaves the task alone
      // until the attempt resolves or its lease runs out.
      subject: command.taskId,
    },
    async (tx) => await acknowledge(tx, command, receivedAt),
  );

  // `replayed` is decided by the key rather than stored under it: the stored
  // result is what the first attempt produced, and whether this caller is the
  // one who produced it is a property of this request. The app treats both as
  // acknowledged, and the flag is what lets it tell a retry that landed from
  // one that had already landed.
  return {
    response: { ...outcome.result, replayed: outcome.replayed },
    replayed: outcome.replayed,
  };
}

/**
 * The pending record's identifier is the idempotency key.
 *
 * The contract says so, and the reason it is sent twice is that a client
 * assembling a request from two places can get them out of step. Answering
 * `validation_failed` with the field named is what lets the app log which of
 * its own records was mis-sent.
 */
function assertRecordMatchesKey(command: CreateCompletionCommand): void {
  if (command.body.clientRecordId === command.idempotencyKey) return;
  throw new AppError(
    "validation_failed",
    "The completion's clientRecordId must be the idempotency key the request carries.",
    {
      details: [
        {
          path: ["clientRecordId"],
          message: "does not match the request's idempotency key",
        },
      ],
    },
  );
}

function assertProvenanceAccepted(body: CreateCompletionRequest): void {
  if (body.observation.provenance === ACCEPTED_COMPLETION_PROVENANCE) return;
  throw new AppError(
    "movement_provenance_rejected",
    `A completion must be observed while the app is open: ${ACCEPTED_COMPLETION_PROVENANCE} movement only.`,
  );
}

/** The row shape the command needs: the task, and the challenge it belongs to. */
interface TaskAndChallenge {
  readonly taskId: string;
  readonly taskStatus: (typeof scheduledTasks.$inferSelect)["status"];
  readonly taskDate: string;
  readonly deadline: Date;
  readonly challengeId: string;
  readonly challengeStatus: (typeof challenges.$inferSelect)["status"];
  readonly requiredTaskCount: number;
  readonly stepTarget: number;
  readonly timeZone: string;
}

async function acknowledge(
  tx: Transaction,
  command: CreateCompletionCommand,
  receivedAt: Date,
): Promise<CreateCompletionResponse> {
  const task = await lockTask(tx, command);

  if (task.challengeStatus !== "active") {
    throw new AppError(
      "challenge_not_active",
      `This task's challenge is ${task.challengeStatus}, so a completion cannot be recorded against it.`,
    );
  }
  if (task.taskStatus !== "scheduled") {
    throw new AppError(
      "task_already_resolved",
      `This task is already ${task.taskStatus}. Its outcome does not change.`,
    );
  }

  assertWithinReceiptGrace(task, receivedAt);
  assertInsideTaskWindow(task, command.body);
  assertStepTargetMet(task, command.body);

  await tx.insert(taskCompletions).values({
    taskId: task.taskId,
    completedAt: new Date(command.body.completedAt),
    acknowledgedAt: receivedAt,
    observationStartedAt: new Date(command.body.observation.startedAt),
    observationEndedAt: new Date(command.body.observation.endedAt),
    steps: command.body.observation.steps,
    provenance: command.body.observation.provenance,
    source: command.body.observation.source,
    appVersion: command.body.appVersion,
    verificationPolicyVersion: command.body.verificationPolicyVersion,
  });

  const [completed] = await tx
    .update(scheduledTasks)
    .set({ status: "completed", acknowledgedAt: receivedAt, updatedAt: receivedAt })
    // The status is part of the predicate as well as of the check above, so the
    // update cannot resolve a task a concurrent writer resolved first even if
    // the row lock were ever relaxed.
    .where(and(eq(scheduledTasks.id, task.taskId), eq(scheduledTasks.status, "scheduled")))
    .returning();
  if (completed === undefined) {
    throw new AppError("internal_error", "the completion update matched no open task");
  }

  const challengeStatus = await succeedIfComplete(tx, task, receivedAt);

  return { task: taskViewOf(completed), replayed: false, challengeStatus };
}

/**
 * The task and its challenge, with the task row locked.
 *
 * One statement rather than two reads: the challenge's step target, time zone,
 * and status all decide this command, and reading them separately would leave a
 * window in which the challenge ended between the two reads.
 *
 * A task that does not exist and a task belonging to somebody else are the same
 * answer. The session gate has already proved ownership, so reaching either
 * here means the task was deleted underneath the request.
 */
async function lockTask(
  tx: Transaction,
  command: CreateCompletionCommand,
): Promise<TaskAndChallenge> {
  const [row] = await tx
    .select({
      taskId: scheduledTasks.id,
      taskStatus: scheduledTasks.status,
      taskDate: scheduledTasks.taskDate,
      deadline: scheduledTasks.deadline,
      challengeId: challenges.id,
      challengeStatus: challenges.status,
      requiredTaskCount: challenges.requiredTaskCount,
      stepTarget: challenges.stepTarget,
      timeZone: challenges.timeZone,
    })
    .from(scheduledTasks)
    .innerJoin(challenges, eq(challenges.id, scheduledTasks.challengeId))
    .where(and(eq(scheduledTasks.id, command.taskId), eq(challenges.accountId, command.accountId)))
    // Locks the task row only: the challenge is read for its configuration and
    // is locked by the one statement that changes it, below.
    .for("update", { of: scheduledTasks })
    .limit(1);

  if (row === undefined) {
    throw new AppError("not_found", "No task with this identifier.");
  }
  return row;
}

function assertWithinReceiptGrace(task: TaskAndChallenge, receivedAt: Date): void {
  const latestAcceptable = task.deadline.getTime() + RECEIPT_GRACE_SECONDS * 1000;
  if (receivedAt.getTime() <= latestAcceptable) return;
  throw new AppError(
    "deadline_passed",
    `This completion arrived after the deadline and its ${RECEIPT_GRACE_SECONDS} second receipt grace.`,
  );
}

/**
 * The reported instant has to be inside the task's own day and at or before the
 * deadline.
 *
 * The window start is the beginning of the task's calendar day in the
 * challenge's zone, derived here rather than stored: the task row keeps the date
 * and the zone is on the challenge, so the two together are the window and
 * storing a third instant would mean keeping it true through a time zone change.
 */
function assertInsideTaskWindow(task: TaskAndChallenge, body: CreateCompletionRequest): void {
  const completedAt = Date.parse(body.completedAt);
  const windowStart = startOfLocalDay(task.taskDate, task.timeZone).getTime();
  if (completedAt >= windowStart && completedAt <= task.deadline.getTime()) return;
  throw new AppError(
    "completion_outside_task_window",
    "The reported completion instant is outside this task's window or past its deadline.",
  );
}

function assertStepTargetMet(task: TaskAndChallenge, body: CreateCompletionRequest): void {
  if (body.observation.steps >= task.stepTarget) return;
  throw new AppError(
    "step_target_not_met",
    `This task needs ${task.stepTarget} steps and the observation carries ${body.observation.steps}.`,
  );
}

/**
 * The challenge succeeds on the completion that reaches its required count.
 *
 * Counting the rows rather than incrementing a column is what makes this
 * correct under a replay: there is no number to double-count, and the deferred
 * trigger checks the same count at commit, so a disagreement between this and
 * the database is a failed transaction rather than a challenge that claims an
 * outcome it has not earned.
 */
async function succeedIfComplete(
  tx: Transaction,
  task: TaskAndChallenge,
  receivedAt: Date,
): Promise<CreateCompletionResponse["challengeStatus"]> {
  const completedTasks = await tx
    .select({ id: scheduledTasks.id })
    .from(scheduledTasks)
    .where(
      and(eq(scheduledTasks.challengeId, task.challengeId), eq(scheduledTasks.status, "completed")),
    );
  if (completedTasks.length < task.requiredTaskCount) return "active";

  await tx
    .update(challenges)
    .set({ status: "succeeded", terminalAt: receivedAt, updatedAt: receivedAt })
    .where(and(eq(challenges.id, task.challengeId), eq(challenges.status, "active")));
  return "succeeded";
}
