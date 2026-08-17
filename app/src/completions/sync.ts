/**
 * Sending pending completions to the server.
 *
 * Every attempt is one record's attempt. A pass fires all pending records at
 * once and each one's outcome is written down on its own, so a record the
 * server will never accept cannot stop any other record from syncing.
 *
 * The three moments the architecture names (the app opening, the network
 * coming back, and a completion being recorded) are all the same operation
 * here: run every pending record. The first two arrive as triggers, which are
 * plain subscribe functions so that nothing in this module imports a native
 * module.
 *
 * What happens to a record is decided by the contract's own disposition for
 * the error code, never by a status code or a message: `reject` marks the
 * record rejected and stops retrying it, and everything else, including a
 * request that never reached the server, leaves it pending.
 */

import type { CreateCompletionResponse } from "@betterwakeup/contract";
import type { ApiClient } from "../api/client.ts";
import { ApiError } from "../api/errors.ts";
import type {
  PendingCompletionInput,
  PendingCompletionRecord,
  PendingCompletionStore,
} from "./store.ts";

export type CompletionSyncEvent =
  /** The server stored the completion. The record has been removed. */
  | { type: "acknowledged"; record: PendingCompletionRecord; response: CreateCompletionResponse }
  /** The server refused in a way a repeat would not change. Surface it. */
  | { type: "rejected"; record: PendingCompletionRecord; error: ApiError }
  /** The attempt failed and the record stays pending. */
  | { type: "deferred"; record: PendingCompletionRecord; error: ApiError };

export interface CompletionSyncResult {
  readonly acknowledged: number;
  readonly rejected: number;
  readonly deferred: number;
}

/**
 * Something that says "try again now": the app coming to the foreground, or
 * the network coming back. It hands back its own unsubscribe.
 */
export type SyncTrigger = (fire: () => void) => () => void;

export interface CompletionSyncOptions {
  readonly store: PendingCompletionStore;
  readonly client: ApiClient;
  readonly triggers?: readonly SyncTrigger[];
}

export interface CompletionSync {
  /** Write the completion, then try to send it. Returns the stored record. */
  record(input: PendingCompletionInput): Promise<PendingCompletionRecord>;
  /** Attempt every pending record, independently. */
  syncAll(): Promise<CompletionSyncResult>;
  /** Subscribe to triggers and run a first pass. This is the "on open" call. */
  start(): Promise<CompletionSyncResult>;
  /** Stop listening to triggers. In-flight attempts finish on their own. */
  stop(): void;
  subscribe(listener: (event: CompletionSyncEvent) => void): () => void;
}

/** The refusal a record with an unreadable stored observation is given. */
const UNSENDABLE_CODE = "validation_failed" as const;
const UNSENDABLE_MESSAGE = "The stored movement observation is unreadable, so it cannot be sent.";

export function createCompletionSync(options: CompletionSyncOptions): CompletionSync {
  const listeners = new Set<(event: CompletionSyncEvent) => void>();
  /**
   * Records with an attempt in the air. A trigger firing during a pass, which
   * happens whenever a completion is recorded while the app has just come
   * back, must not send the same record twice: the second send would be
   * answered `idempotency_in_progress` and counted as a failure of a record
   * that is actually fine.
   */
  const inFlight = new Set<string>();
  let unsubscribes: (() => void)[] = [];

  function publish(event: CompletionSyncEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  async function attempt(record: PendingCompletionRecord): Promise<CompletionSyncEvent | null> {
    if (inFlight.has(record.id)) {
      return null;
    }
    inFlight.add(record.id);
    try {
      if (record.observation === null) {
        const error = new ApiError(UNSENDABLE_CODE, UNSENDABLE_MESSAGE);
        await options.store.markRejected(record.id, {
          code: UNSENDABLE_CODE,
          message: UNSENDABLE_MESSAGE,
        });
        return { type: "rejected", record, error };
      }

      const response = await options.client.request("createCompletion", {
        params: { taskId: record.taskId },
        body: {
          clientRecordId: record.id,
          completedAt: record.completedAt,
          observation: record.observation,
          appVersion: record.appVersion,
          verificationPolicyVersion: record.verificationPolicyVersion,
        },
        // The record's own ID, so every retry of this record is the same
        // command to the server rather than a second completion.
        idempotencyKey: record.id,
      });
      await options.store.markAcknowledged(record.id);
      return { type: "acknowledged", record, response };
    } catch (cause) {
      const error =
        cause instanceof ApiError
          ? cause
          : // Anything that is not an ApiError is a defect in the client rather
            // than an answer from the server, so the record stays pending.
            new ApiError("internal_error", "The completion could not be sent.", { cause });
      if (error.disposition === "reject") {
        await options.store.markRejected(record.id, { code: error.code, message: error.message });
        return { type: "rejected", record, error };
      }
      await options.store.noteAttemptFailed(record.id, {
        code: error.code,
        message: error.message,
      });
      return { type: "deferred", record, error };
    } finally {
      inFlight.delete(record.id);
    }
  }

  function tally(events: readonly (CompletionSyncEvent | null)[]): CompletionSyncResult {
    let acknowledged = 0;
    let rejected = 0;
    let deferred = 0;
    for (const event of events) {
      if (event === null) {
        continue;
      }
      publish(event);
      if (event.type === "acknowledged") {
        acknowledged += 1;
      } else if (event.type === "rejected") {
        rejected += 1;
      } else {
        deferred += 1;
      }
    }
    return { acknowledged, rejected, deferred };
  }

  async function syncAll(): Promise<CompletionSyncResult> {
    const pending = await options.store.listPending();
    // All at once and each on its own: one record's failure is written down
    // without touching any other record's outcome.
    const events = await Promise.all(pending.map((record) => attempt(record)));
    return tally(events);
  }

  return {
    async record(input) {
      const stored = await options.store.record(input);
      // The record is on disk before this returns, so a crash here still
      // leaves the completion to be sent on the next launch.
      const event = await attempt(stored);
      tally([event]);
      return stored;
    },

    syncAll,

    async start() {
      if (unsubscribes.length === 0) {
        unsubscribes = (options.triggers ?? []).map((trigger) =>
          trigger(() => {
            void syncAll();
          }),
        );
      }
      return syncAll();
    },

    stop() {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
      unsubscribes = [];
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
