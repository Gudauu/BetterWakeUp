/**
 * What the device is still holding on the user's behalf.
 *
 * A completion is written to disk before the user is told anything and only
 * leaves the store when the server acknowledges it, so a walk taken with no
 * signal is real work that has not been counted yet. The task screen says so
 * while it is open, but home is where the user actually looks, and home had no
 * way of knowing: someone who walked in a basement saw the same "your next
 * walk" card as someone who had not got up, which invites a second walk and
 * hides the one thing they might act on - keeping the app open somewhere with
 * signal before the deadline.
 *
 * This module answers that question and nothing else. It reads the store the
 * task screen already writes to, and it separates the record for the task the
 * challenge is currently asking for - which the user can still open and retry -
 * from records left over from an earlier day, which sync retries on their own.
 */

import { useEffect, useState } from "react";
import type { CompletionRuntimeState } from "./runtime.ts";
import type { PendingCompletionRecord } from "./store.ts";

/**
 * Where the current task's own record stands on this device. A refusal
 * outranks anything still pending, the same way it does on the task screen:
 * the user has something to do about it, and no retry will change it.
 */
export type CurrentTaskRecord = "none" | "waiting" | "refused";

export interface UnsentWork {
  readonly currentTask: CurrentTaskRecord;
  /** Walks recorded for some earlier task that the server still has not taken. */
  readonly earlierWaiting: number;
  /**
   * The current task's own record while it is still pending, so home can say
   * why it has not landed rather than only that it has not. Null in every
   * other state, refusals included: a refused record is read for its refusal.
   */
  readonly currentPending: PendingCompletionRecord | null;
}

export const NO_UNSENT_WORK: UnsentWork = {
  currentTask: "none",
  earlierWaiting: 0,
  currentPending: null,
};

export function unsentWork(
  records: readonly PendingCompletionRecord[],
  currentTaskId: string | null,
): UnsentWork {
  const mine = currentTaskId === null ? [] : records.filter((r) => r.taskId === currentTaskId);
  const minePending = mine.find((r) => r.status === "pending") ?? null;
  const currentTask: CurrentTaskRecord = mine.some((r) => r.status === "rejected")
    ? "refused"
    : minePending !== null
      ? "waiting"
      : "none";
  const currentPending = currentTask === "waiting" ? minePending : null;
  // Only pending records are counted here. A record refused on an earlier day
  // cannot be acted on from anywhere - the task it belonged to is closed - so
  // reporting it on home would be a worry with no press behind it.
  const earlierWaiting = records.filter(
    (r) => r.status === "pending" && r.taskId !== currentTaskId,
  ).length;
  return { currentTask, earlierWaiting, currentPending };
}

/**
 * What to say about the walks this device is holding when the challenge itself
 * could not be read.
 *
 * This is the state the store exists for and the one place the user has least
 * to go on: the read fails exactly when there is no connection, which is
 * exactly when a walk stays on the phone. An error screen that says only that
 * the challenge could not be loaded reads, to someone who got up and walked ten
 * minutes ago, as though the walk went with it - and the one thing they might
 * do about that, walking it again, cannot help, because the record is already
 * written and the second walk would be refused as a duplicate.
 *
 * Answers null when the device is holding nothing, so the screen says nothing
 * rather than reassuring someone about work they never did.
 */
export function heldWalksText(waiting: number): string | null {
  if (waiting <= 0) {
    return null;
  }
  const subject =
    waiting === 1
      ? "A walk you saved is still on this phone."
      : `${waiting} walks you saved are still on this phone.`;
  return `${subject} Nothing was lost: they send themselves as soon as the app can reach BetterWakeUp again, so there is no need to walk again.`;
}

/**
 * The store's answer, kept level with it for as long as the caller is mounted.
 *
 * Sync's own events are the trigger: a record being acknowledged, refused or
 * deferred is exactly when this answer changes, and subscribing to them means
 * home updates the moment a walk lands rather than on the next read of the
 * challenge. A store that cannot be read leaves the answer where it was, which
 * is the same choice the reminders hook makes about a failed read.
 */
export function useUnsentWork(
  runtime: CompletionRuntimeState,
  currentTaskId: string | null,
): UnsentWork {
  const [records, setRecords] = useState<readonly PendingCompletionRecord[]>([]);
  const ready = runtime.status === "ready" ? runtime.runtime : null;

  useEffect(() => {
    if (ready === null) {
      setRecords([]);
      return;
    }
    let active = true;
    const read = () => {
      void ready.store.list().then(
        (rows) => {
          if (active) {
            setRecords(rows);
          }
        },
        () => {
          // A store that will not answer says nothing about the user's walks,
          // and a disposed one is being torn down anyway.
        },
      );
    };
    read();
    const unsubscribe = ready.sync.subscribe(read);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [ready]);

  return unsentWork(records, currentTaskId);
}
