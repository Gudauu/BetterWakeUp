/**
 * What today's task looks like to the user.
 *
 * The product makes a day count only when both checks pass, so the interface
 * has to hold two facts apart: the device evaluated the step target, and the
 * server acknowledged that result before the deadline. This module is the one
 * place the two are combined into the progression the architecture draws:
 *
 * ```text
 * Task incomplete
 *     -> Completed locally, synchronization pending
 *         -> Acknowledged by server
 *         -> Rejected, action required
 * ```
 *
 * The server's own task view is the only evidence of acknowledgment. A local
 * record proves nothing about the server, so no arrangement of pending records
 * can produce `acknowledged`, which is what keeps a locally complete but
 * unsynced task from ever rendering as complete.
 */

import type { TaskView } from "@betterwakeup/contract";
import type { PendingCompletionRecord } from "./store.ts";

/** Where today's task stands. The four states the architecture names. */
export type DailyCompletionStatus = "incomplete" | "syncPending" | "acknowledged" | "rejected";

/**
 * One check's own answer. The two checks are reported separately and are never
 * collapsed into a single "done", because a passing local check with a waiting
 * server check is precisely the state the user must be able to see.
 */
export type CheckState = "waiting" | "passed" | "failed";

export interface DailyCompletionState {
  readonly status: DailyCompletionStatus;
  /** The device evaluated the step target and wrote the result down. */
  readonly localCheck: CheckState;
  /** The server received and acknowledged that result. */
  readonly serverCheck: CheckState;
  /** Whole minutes until the deadline; negative once it has passed. */
  readonly minutesToDeadline: number | null;
  readonly deadlinePassed: boolean;
  /** The deadline is close and the server has still not acknowledged. */
  readonly deadlineWarning: boolean;
  /** The record the server refused, when there is one. */
  readonly rejectedRecord: PendingCompletionRecord | null;
  /** The record still waiting to be acknowledged, when there is one. */
  readonly pendingRecord: PendingCompletionRecord | null;
}

/**
 * How close the deadline has to be before a pending synchronization is called
 * out. Thirty minutes is chosen to leave room for the user to act: reconnect,
 * move somewhere with signal, or simply keep the app open.
 */
export const DEADLINE_WARNING_MINUTES = 30;

export interface DailyCompletionInput {
  /** The task the server says is open, or null when none is. */
  readonly task: TaskView | null;
  /** Every stored record, of any task; this module picks out today's. */
  readonly records: readonly PendingCompletionRecord[];
  readonly now: Date;
  readonly warnWithinMinutes?: number;
}

export function dailyCompletionState(input: DailyCompletionInput): DailyCompletionState {
  const { task, now } = input;
  const warnWithin = input.warnWithinMinutes ?? DEADLINE_WARNING_MINUTES;

  const minutesToDeadline =
    task === null ? null : Math.floor((new Date(task.deadline).getTime() - now.getTime()) / 60_000);
  const deadlinePassed = minutesToDeadline !== null && minutesToDeadline < 0;

  if (task === null) {
    return {
      status: "incomplete",
      localCheck: "waiting",
      serverCheck: "waiting",
      minutesToDeadline: null,
      deadlinePassed: false,
      deadlineWarning: false,
      rejectedRecord: null,
      pendingRecord: null,
    };
  }

  const forTask = input.records.filter((record) => record.taskId === task.id);
  const rejectedRecord = forTask.find((record) => record.status === "rejected") ?? null;
  const pendingRecord = forTask.find((record) => record.status === "pending") ?? null;

  // The server is the only authority on the second check. `acknowledgedAt`
  // rather than the status alone, because that instant is what the server
  // records when it stores the completion.
  if (task.status === "completed" && task.acknowledgedAt !== null) {
    return {
      status: "acknowledged",
      localCheck: "passed",
      serverCheck: "passed",
      minutesToDeadline,
      deadlinePassed,
      deadlineWarning: false,
      rejectedRecord: null,
      pendingRecord: null,
    };
  }

  // A refusal outranks a retry still in the store: the user has something to
  // do about it, and nothing pending is going to change the refusal.
  if (rejectedRecord !== null) {
    return {
      status: "rejected",
      localCheck: "passed",
      serverCheck: "failed",
      minutesToDeadline,
      deadlinePassed,
      deadlineWarning: false,
      rejectedRecord,
      pendingRecord,
    };
  }

  if (pendingRecord !== null) {
    return {
      status: "syncPending",
      localCheck: "passed",
      serverCheck: "waiting",
      minutesToDeadline,
      deadlinePassed,
      deadlineWarning: minutesToDeadline !== null && minutesToDeadline <= warnWithin,
      rejectedRecord: null,
      pendingRecord,
    };
  }

  return {
    status: "incomplete",
    localCheck: "waiting",
    serverCheck: "waiting",
    minutesToDeadline,
    deadlinePassed,
    deadlineWarning: false,
    rejectedRecord: null,
    pendingRecord: null,
  };
}
