/**
 * The pieces today's task needs, assembled once and torn down together.
 *
 * The daily completion screen asks for a store, a sync and a movement capture
 * rather than building them, which is what keeps its tests free of a device.
 * Something still has to build the real ones, and doing it in the screen that
 * opens it would mean a database opened and closed on every visit. So it is
 * done here, held for as long as a challenge is on screen, and disposed when
 * that stops being true.
 *
 * Opening the runtime is also the architecture's "app opening" sync pass: the
 * first thing a live runtime does is try to send every completion still on
 * disk, so a day recorded with no network is sent without the user going
 * anywhere near the task screen.
 *
 * The native modules are imported inside the factory rather than at the top of
 * this file. Every other module that touches `expo-sqlite` or `expo-sensors`
 * is named `native-*` precisely so nothing above the ports pulls a native
 * module into its import graph, and a screen importing this one must not
 * quietly undo that.
 */

import { useEffect, useState } from "react";
import type { ApiClient } from "../api/client.ts";
import { loadAppConfig } from "../config.ts";
import type { MovementCapture } from "../movement/capture.ts";
import { openPendingCompletionStore, type PendingCompletionStore } from "./store.ts";
import { type CompletionSync, createCompletionSync } from "./sync.ts";

export interface CompletionRuntime {
  readonly store: PendingCompletionStore;
  readonly sync: CompletionSync;
  readonly capture: MovementCapture;
  /** Sent with every completion, so a bad client build can be identified. */
  readonly appVersion: string;
  /** Stop listening for sync triggers and close the database. */
  dispose(): Promise<void>;
}

/**
 * How a runtime is built. Substituted in tests, and the seam a development
 * build uses to drive the task screen without a real pedometer.
 */
export type CompletionRuntimeFactory = (api: ApiClient) => Promise<CompletionRuntime>;

export type CompletionRuntimeState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly runtime: CompletionRuntime }
  | { readonly status: "failed"; readonly message: string };

const FAILED_MESSAGE =
  "Today's task cannot be opened on this device right now. Restart the app and try again.";

export async function createNativeCompletionRuntime(api: ApiClient): Promise<CompletionRuntime> {
  const [
    { foregroundTrigger, openNativeDatabase, reconnectTrigger },
    { createNativeMovementCapture },
  ] = await Promise.all([import("./native-store.ts"), import("../movement/native-pedometer.ts")]);

  const store = await openPendingCompletionStore({ database: await openNativeDatabase() });
  const sync = createCompletionSync({
    store,
    client: api,
    triggers: [foregroundTrigger, reconnectTrigger],
  });

  // Not awaited: the first pass talks to the network, and a screen that waited
  // for it would be blank for as long as a bad connection takes to time out.
  void sync.start();

  return {
    store,
    sync,
    capture: createNativeMovementCapture(),
    appVersion: loadAppConfig().appVersion,
    async dispose() {
      sync.stop();
      await store.close();
    },
  };
}

/**
 * A runtime for as long as the component that asked for one is mounted.
 *
 * A runtime that finishes opening after the component has gone is disposed
 * rather than kept: leaving it would hold a database handle and a foreground
 * listener that nothing can ever reach again.
 */
export function useCompletionRuntime(
  api: ApiClient,
  create: CompletionRuntimeFactory,
): CompletionRuntimeState {
  const [state, setState] = useState<CompletionRuntimeState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    let opened: CompletionRuntime | null = null;

    setState({ status: "loading" });
    void create(api).then(
      (runtime) => {
        if (!active) {
          void runtime.dispose();
          return;
        }
        opened = runtime;
        setState({ status: "ready", runtime });
      },
      () => {
        // A device whose database or step counter will not open is a device
        // that cannot record a day, which is a sentence to show rather than an
        // unhandled rejection.
        if (active) {
          setState({ status: "failed", message: FAILED_MESSAGE });
        }
      },
    );

    return () => {
      active = false;
      void opened?.dispose();
    };
  }, [api, create]);

  return state;
}
