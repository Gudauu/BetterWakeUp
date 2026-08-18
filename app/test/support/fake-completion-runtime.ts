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
import { openPendingCompletionStore } from "../../src/completions/store.ts";
import { createCompletionSync } from "../../src/completions/sync.ts";
import { createMovementCapture } from "../../src/movement/capture.ts";
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
