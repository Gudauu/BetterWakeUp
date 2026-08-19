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
  type PendingCompletionRecord,
  type PendingCompletionStore,
} from "../src/completions/store.ts";
import {
  type CompletionSync,
  type CompletionSyncEvent,
  createCompletionSync,
  RETRY_ATTEMPT_LIMIT,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  retryDelayFor,
  type SyncTimer,
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

/**
 * A clock the test moves by hand. Nothing here may spend a real second: the
 * shortest wait the rule can ask for is fifteen of them.
 */
interface FakeTimer {
  readonly timer: SyncTimer;
  /** The wait the sync last asked for, or null when it is not waiting. */
  waiting(): number | null;
  /** Run the outstanding wait now. */
  fire(): Promise<void>;
}

function createFakeTimer(): FakeTimer {
  let pending: { run: () => void; milliseconds: number } | null = null;
  return {
    timer: (run, milliseconds) => {
      pending = { run, milliseconds };
      return () => {
        pending = null;
      };
    },
    waiting: () => pending?.milliseconds ?? null,
    async fire() {
      const due = pending;
      pending = null;
      due?.run();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

describe("how long before the next pass", () => {
  function deferral(attempts: number, retryAfterSeconds?: number): PendingCompletionRecord {
    return {
      id: "00000000-0000-4000-8000-00000000000f",
      challengeId: INPUT.challengeId,
      taskId: INPUT.taskId,
      completedAt: INPUT.completedAt,
      observation: OBSERVATION,
      appVersion: INPUT.appVersion,
      verificationPolicyVersion: INPUT.verificationPolicyVersion,
      status: "pending",
      createdAt: INPUT.completedAt,
      attempts,
      lastErrorCode: retryAfterSeconds === undefined ? null : "rate_limited",
      lastErrorMessage: null,
    };
  }

  const failure = (retryAfterSeconds?: number): ApiError =>
    new ApiError("internal_error", "no", {
      status: null,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });

  it("asks for nothing when no record is pending", () => {
    expect(retryDelayFor([])).toBeNull();
  });

  it("doubles the wait with each failed attempt and stops at the cap", () => {
    expect(retryDelayFor([{ record: deferral(0), error: failure() }])).toBe(RETRY_BASE_MS);
    expect(retryDelayFor([{ record: deferral(1), error: failure() }])).toBe(RETRY_BASE_MS * 2);
    expect(retryDelayFor([{ record: deferral(2), error: failure() }])).toBe(RETRY_BASE_MS * 4);
    expect(retryDelayFor([{ record: deferral(6), error: failure() }])).toBe(RETRY_CAP_MS);
  });

  it("takes the wait the server named over the backoff", () => {
    expect(retryDelayFor([{ record: deferral(0), error: failure(47) }])).toBe(47_000);
  });

  it("waits as long as the record that asked for most, so no allowance is spent early", () => {
    expect(
      retryDelayFor([
        { record: deferral(0), error: failure() },
        { record: deferral(0), error: failure(600) },
      ]),
    ).toBe(600_000);
  });

  it("stops holding a clock open once a record has failed its limit of attempts", () => {
    expect(retryDelayFor([{ record: deferral(RETRY_ATTEMPT_LIMIT - 1), error: failure() }])).toBe(
      RETRY_CAP_MS,
    );
    expect(retryDelayFor([{ record: deferral(RETRY_ATTEMPT_LIMIT), error: failure() }])).toBeNull();
  });
});

describe("completion sync retrying on its own", () => {
  let store: PendingCompletionStore;
  let client: FakeClient;
  let clock: FakeTimer;
  let sync: CompletionSync;

  beforeEach(async () => {
    store = await openPendingCompletionStore({
      database: createMemoryDatabase(),
      newRecordId: ids(),
    });
    client = createFakeClient();
    clock = createFakeTimer();
    sync = createCompletionSync({ store, client, timer: clock.timer });
  });

  afterEach(async () => {
    sync.stop();
    await store.close();
  });

  /** A record the server refuses until the test says otherwise. */
  async function deferredRecord(error: () => ApiError): Promise<string> {
    const record = await store.record(INPUT);
    client.answer(record.id, async () => {
      throw error();
    });
    return record.id;
  }

  it("sends a deferred record again on its own clock, with no trigger and no press", async () => {
    let reachable = false;
    const id = await deferredRecord(() => new ApiError("internal_error", "boom", { status: 500 }));
    client.answer(id, async () => {
      if (!reachable) {
        throw new ApiError("internal_error", "boom", { status: 500 });
      }
      return acknowledgement();
    });

    await sync.start();
    expect(client.attempts).toHaveLength(1);
    expect(clock.waiting()).toBe(RETRY_BASE_MS);

    reachable = true;
    await clock.fire();

    expect(client.attempts).toHaveLength(2);
    expect(await store.list()).toEqual([]);
    // Nothing is pending, so nothing is waiting: the clock stops with the work.
    expect(clock.waiting()).toBeNull();
  });

  it("lengthens the wait as attempts keep failing", async () => {
    await deferredRecord(() => new ApiError("internal_error", "boom", { status: 500 }));

    await sync.start();
    expect(clock.waiting()).toBe(RETRY_BASE_MS);
    await clock.fire();
    expect(clock.waiting()).toBe(RETRY_BASE_MS * 2);
    await clock.fire();
    expect(clock.waiting()).toBe(RETRY_BASE_MS * 4);
  });

  it("waits the seconds a rate limit named rather than its own backoff", async () => {
    await deferredRecord(
      () => new ApiError("rate_limited", "too many", { status: 429, retryAfterSeconds: 90 }),
    );

    await sync.start();

    expect(clock.waiting()).toBe(90_000);
  });

  it("asks for nothing after a refusal, which no wait would change", async () => {
    await deferredRecord(() => new ApiError("step_target_not_met", "short", { status: 422 }));

    await sync.start();

    expect(await store.listRejected()).toHaveLength(1);
    expect(clock.waiting()).toBeNull();
  });

  it("leaves no clock behind once it is stopped", async () => {
    await deferredRecord(() => new ApiError("internal_error", "boom", { status: 500 }));

    await sync.start();
    expect(clock.waiting()).toBe(RETRY_BASE_MS);

    sync.stop();

    expect(clock.waiting()).toBeNull();
  });

  it("keeps no clock for a caller that only asked one question", async () => {
    await deferredRecord(() => new ApiError("internal_error", "boom", { status: 500 }));

    await sync.syncAll();

    expect(clock.waiting()).toBeNull();
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
