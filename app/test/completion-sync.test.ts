/**
 * Sending pending completions.
 *
 * The store underneath is the real one over a real SQLite engine, so what a
 * record's state is after an attempt is read back off disk rather than out of
 * the sync's own memory.
 */

import type { MovementObservation } from "@betterwakeup/contract";
import type { ApiClient, ApiRequest, ClientEndpointName } from "../src/api/client.ts";
import { ApiError } from "../src/api/errors.ts";
import {
  openPendingCompletionStore,
  type PendingCompletionInput,
  type PendingCompletionStore,
} from "../src/completions/store.ts";
import {
  type CompletionSync,
  type CompletionSyncEvent,
  createCompletionSync,
  type SyncTrigger,
} from "../src/completions/sync.ts";
import { createMemoryDatabase, createTestDatabaseFile } from "./support/node-sqlite.ts";

const OBSERVATION: MovementObservation = {
  startedAt: "2026-03-01T14:00:00.000Z",
  endedAt: "2026-03-01T14:04:00.000Z",
  steps: 220,
  provenance: "live-foreground",
  source: "expo-pedometer-android",
};

const INPUT: PendingCompletionInput = {
  challengeId: "11111111-1111-4111-8111-111111111111",
  taskId: "22222222-2222-4222-8222-222222222222",
  completedAt: "2026-03-01T14:04:00.000Z",
  observation: OBSERVATION,
  appVersion: "1.2.3",
  verificationPolicyVersion: "live-foreground-steps.1",
};

function ids(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `00000000-0000-4000-8000-00000000000${next}`;
  };
}

interface Attempt {
  readonly name: ClientEndpointName;
  readonly input: ApiRequest<"createCompletion">;
}

interface FakeClient extends ApiClient {
  readonly attempts: Attempt[];
  /** What the next attempt on a given record does. Default: acknowledge. */
  answer(recordId: string, outcome: () => Promise<unknown>): void;
}

function acknowledgement(): unknown {
  return {
    task: {
      id: INPUT.taskId,
      date: "2026-03-01",
      deadline: "2026-03-01T15:00:00.000Z",
      pauseCutoff: "2026-03-01T14:00:00.000Z",
      status: "completed",
      acknowledgedAt: "2026-03-01T14:04:02.000Z",
    },
    replayed: false,
    challengeStatus: "active",
  };
}

function createFakeClient(): FakeClient {
  const attempts: Attempt[] = [];
  const outcomes = new Map<string, () => Promise<unknown>>();
  return {
    attempts,
    answer(recordId, outcome) {
      outcomes.set(recordId, outcome);
    },
    async request(name, input) {
      const request = input as ApiRequest<"createCompletion">;
      attempts.push({ name, input: request });
      const outcome = outcomes.get(request.body.clientRecordId);
      const result = outcome === undefined ? acknowledgement() : await outcome();
      return result as never;
    },
  };
}

describe("completion sync", () => {
  let store: PendingCompletionStore;
  let client: FakeClient;
  let sync: CompletionSync;
  let events: CompletionSyncEvent[];

  beforeEach(async () => {
    store = await openPendingCompletionStore({
      database: createMemoryDatabase(),
      newRecordId: ids(),
    });
    client = createFakeClient();
    sync = createCompletionSync({ store, client });
    events = [];
    sync.subscribe((event) => events.push(event));
  });

  afterEach(async () => {
    sync.stop();
    await store.close();
  });

  it("sends the record's own ID as the idempotency key and removes it once acknowledged", async () => {
    const record = await sync.record(INPUT);

    expect(client.attempts).toHaveLength(1);
    expect(client.attempts[0]).toMatchObject({
      name: "createCompletion",
      input: {
        params: { taskId: INPUT.taskId },
        idempotencyKey: record.id,
        body: {
          clientRecordId: record.id,
          completedAt: INPUT.completedAt,
          observation: OBSERVATION,
          appVersion: "1.2.3",
          verificationPolicyVersion: "live-foreground-steps.1",
        },
      },
    });
    expect(await store.list()).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(["acknowledged"]);
  });

  it("keeps a record pending when the request never reached the server, and sends it again", async () => {
    let reachable = false;
    const record = await store.record(INPUT);
    client.answer(record.id, async () => {
      if (!reachable) {
        throw new ApiError("internal_error", "The request did not reach the server.", {
          status: null,
        });
      }
      return acknowledgement();
    });

    await sync.syncAll();
    expect(await store.listPending()).toMatchObject([{ id: record.id, attempts: 1 }]);
    expect(events.at(-1)?.type).toBe("deferred");

    reachable = true;
    await sync.syncAll();
    expect(await store.list()).toEqual([]);
  });

  it("retains a rejected record, surfaces it, and never sends it again", async () => {
    const record = await store.record(INPUT);
    client.answer(record.id, async () => {
      throw new ApiError("task_already_resolved", "That task is already resolved.", {
        status: 409,
      });
    });

    await sync.syncAll();
    const attemptsAfterRejection = client.attempts.length;
    await sync.syncAll();

    expect(client.attempts).toHaveLength(attemptsAfterRejection);
    expect(await store.listRejected()).toMatchObject([
      { id: record.id, lastErrorCode: "task_already_resolved" },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "rejected" });
  });

  it("attempts every pending record independently in one pass", async () => {
    // Left with no staged outcome, so the fake acknowledges it.
    await store.record(INPUT);
    const rejected = await store.record(INPUT);
    client.answer(rejected.id, async () => {
      throw new ApiError("step_target_not_met", "not enough movement", { status: 422 });
    });
    const deferred = await store.record(INPUT);
    client.answer(deferred.id, async () => {
      throw new ApiError("rate_limited", "too many", { status: 429 });
    });

    const result = await sync.syncAll();

    expect(result).toEqual({ acknowledged: 1, rejected: 1, deferred: 1 });
    expect(await store.listPending()).toMatchObject([{ id: deferred.id }]);
    expect(await store.listRejected()).toMatchObject([{ id: rejected.id }]);
  });

  it("never sends the same record twice at once", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const record = await store.record(INPUT);
    client.answer(record.id, async () => {
      await held;
      return acknowledgement();
    });

    const first = sync.syncAll();
    const second = sync.syncAll();
    release();
    await Promise.all([first, second]);

    expect(client.attempts).toHaveLength(1);
  });

  it("rejects a record whose stored observation is unreadable without sending it", async () => {
    const database = createMemoryDatabase();
    const damaged = await openPendingCompletionStore({ database, newRecordId: ids() });
    const record = await damaged.record(INPUT);
    await database.runAsync("UPDATE pending_completions SET observation = 'null' WHERE id = ?", [
      record.id,
    ]);
    const damagedSync = createCompletionSync({ store: damaged, client });

    await damagedSync.syncAll();

    expect(client.attempts).toHaveLength(0);
    expect(await damaged.listRejected()).toMatchObject([
      { id: record.id, lastErrorCode: "validation_failed" },
    ]);
    await damaged.close();
  });

  it("keeps a record pending when the failure is not an answer from the server", async () => {
    const record = await store.record(INPUT);
    client.answer(record.id, async () => {
      throw new TypeError("undefined is not a function");
    });

    await sync.syncAll();

    expect(await store.listPending()).toMatchObject([{ id: record.id, attempts: 1 }]);
  });

  it("runs a pass when a trigger fires and stops listening after stop()", async () => {
    let fire = (): void => {};
    const trigger: SyncTrigger = (callback) => {
      fire = callback;
      return () => {
        fire = () => {};
      };
    };
    const triggered = createCompletionSync({ store, client, triggers: [trigger] });
    await store.record(INPUT);

    await triggered.start();
    expect(client.attempts).toHaveLength(1);

    await store.record(INPUT);
    fire();
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.attempts).toHaveLength(2);

    triggered.stop();
    await store.record(INPUT);
    fire();
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.attempts).toHaveLength(2);
  });
});

describe("completion sync across a killed app", () => {
  it("syncs a completion recorded before the app died on the next launch", async () => {
    const file = createTestDatabaseFile();
    try {
      const before = await openPendingCompletionStore({
        database: file.open(),
        newRecordId: ids(),
      });
      const offline: ApiClient = {
        async request() {
          throw new ApiError("internal_error", "The request did not reach the server.", {
            status: null,
          });
        },
      };
      const record = await createCompletionSync({ store: before, client: offline }).record(INPUT);
      // The process ends here: nothing acknowledged the completion.
      await before.close();

      const client = createFakeClient();
      const after = await openPendingCompletionStore({ database: file.open() });
      const result = await createCompletionSync({ store: after, client }).start();

      expect(result).toEqual({ acknowledged: 1, rejected: 0, deferred: 0 });
      expect(client.attempts[0]?.input.idempotencyKey).toBe(record.id);
      expect(await after.list()).toEqual([]);
      await after.close();
    } finally {
      file.remove();
    }
  });
});
