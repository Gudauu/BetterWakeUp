/**
 * A completion runtime with no device under it.
 *
 * The store is a real SQLite database in memory and the sync is the real one,
 * so a test that reaches the task screen through home exercises the same
 * recording path the app does. Only the pedometer and the foreground state are
 * fakes, because those are the two things a test machine does not have.
 */

import type { ApiClient } from "../../src/api/client.ts";
import type { CompletionRuntime, CompletionRuntimeFactory } from "../../src/completions/runtime.ts";
import type { PendingCompletionInput } from "../../src/completions/store.ts";
import { openPendingCompletionStore } from "../../src/completions/store.ts";
import { createCompletionSync } from "../../src/completions/sync.ts";
import { createMovementCapture } from "../../src/movement/capture.ts";
import { createSimulatedMovement } from "../../src/movement/simulated-pedometer.ts";
import { createFakeForeground, createFakePedometer } from "./fake-pedometer.ts";
import { createMemoryDatabase } from "./node-sqlite.ts";

export interface FakeCompletionRuntime extends CompletionRuntime {
  readonly pedometer: ReturnType<typeof createFakePedometer>;
  readonly foreground: ReturnType<typeof createFakeForeground>;
  /** How many times this runtime was disposed, for the tear-down assertion. */
  disposals(): number;
}

export interface FakeRuntimeOptions {
  readonly now?: () => Date;
  /** Left unset so the fake is reused; set to inspect the runtime a test built. */
  readonly onOpened?: (runtime: FakeCompletionRuntime) => void;
  /**
   * Completions already on this device before anything renders, which is the
   * state a phone is in after a walk taken with no signal. Written straight to
   * the store rather than through sync, so they stay pending; the second field
   * marks one as the refusal the server already gave.
   *
   * `failed` notes attempts that were made and did not land, leaving the
   * record pending with the last failure written down - the state a walk is in
   * when the phone has been trying all morning.
   */
  readonly seed?: readonly {
    readonly input: PendingCompletionInput;
    readonly rejected?: { code: string; message: string };
    readonly failed?: {
      code: string;
      message: string;
      times?: number;
      /** Left unset for a failure written down without it, as an older app did. */
      reachedServer?: boolean;
    };
  }[];
}

/**
 * The factory a screen is handed. Each call builds its own runtime, the same
 * way each mount of the real one opens its own database.
 */
export function fakeCompletionRuntimeFactory(
  options: FakeRuntimeOptions = {},
): CompletionRuntimeFactory {
  return async (api: ApiClient) => {
    const runtime = await openFakeCompletionRuntime(api, options);
    options.onOpened?.(runtime);
    return runtime;
  };
}

export async function openFakeCompletionRuntime(
  api: ApiClient,
  options: FakeRuntimeOptions = {},
): Promise<FakeCompletionRuntime> {
  const now = options.now ?? (() => new Date("2026-09-01T13:00:00.000Z"));
  let counter = 0;
  let disposed = 0;

  const store = await openPendingCompletionStore({
    database: createMemoryDatabase(),
    // expo-crypto's randomUUID does not bind under jest, so the ID generator
    // is supplied here rather than left to the default.
    newRecordId: () => {
      counter += 1;
      return `record-${counter}`;
    },
    now,
  });
  for (const seeded of options.seed ?? []) {
    const record = await store.record(seeded.input);
    if (seeded.rejected !== undefined) {
      await store.markRejected(record.id, seeded.rejected);
    }
    if (seeded.failed !== undefined) {
      const times = seeded.failed.times ?? 1;
      for (let attempt = 0; attempt < times; attempt += 1) {
        await store.noteAttemptFailed(record.id, {
          code: seeded.failed.code,
          message: seeded.failed.message,
          ...(seeded.failed.reachedServer === undefined
            ? {}
            : { reachedServer: seeded.failed.reachedServer }),
        });
      }
    }
  }

  const pedometer = createFakePedometer();
  const foreground = createFakeForeground();
  const sync = createCompletionSync({ store, client: api });

  return {
    store,
    sync,
    capture: createMovementCapture({ pedometer, foreground, platform: "ios", now }),
    appVersion: "1.0.0-test",
    pedometer,
    foreground,
    disposals: () => disposed,
    async dispose() {
      disposed += 1;
      sync.stop();
      await store.close();
    },
  };
}

/**
 * The runtime a development build assembles, for a test that drives today's
 * task the way a person does: through the screen's own simulated movement
 * controls rather than by pushing readings into a fake pedometer.
 *
 * Everything but the movement and the database file is the shipped code, and
 * the record IDs are real UUIDs because they are also the idempotency keys the
 * contract validates.
 */
export function simulatedCompletionRuntimeFactory(
  options: { readonly now?: () => Date } = {},
): CompletionRuntimeFactory {
  return async (api: ApiClient) => {
    const now = options.now ?? (() => new Date());
    let counter = 0;
    const store = await openPendingCompletionStore({
      database: createMemoryDatabase(),
      newRecordId: () => {
        counter += 1;
        return `66666666-0000-4000-8000-${String(counter).padStart(12, "0")}`;
      },
      now,
    });
    const movement = createSimulatedMovement();
    const sync = createCompletionSync({ store, client: api });

    return {
      store,
      sync,
      capture: createMovementCapture({
        pedometer: movement.pedometer,
        foreground: movement.foreground,
        platform: "ios",
        now,
      }),
      appVersion: "1.0.0-test",
      simulation: movement.simulation,
      async dispose() {
        sync.stop();
        await store.close();
      },
    };
  };
}
