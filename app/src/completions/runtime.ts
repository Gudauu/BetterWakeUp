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
import {
  createConfiguredScreenLock,
  keepScreenAwakeWhileWalking,
  type ScreenLock,
} from "../movement/screen-lock.ts";
import type { MovementSimulation } from "../movement/simulated-pedometer.ts";
import { openPendingCompletionStore, type PendingCompletionStore } from "./store.ts";
import { type CompletionSync, createCompletionSync } from "./sync.ts";

export interface CompletionRuntime {
  readonly store: PendingCompletionStore;
  readonly sync: CompletionSync;
  readonly capture: MovementCapture;
  /** Sent with every completion, so a bad client build can be identified. */
  readonly appVersion: string;
  /**
   * Present only in a build whose movement is simulated. The task screen shows
   * its controls, and says so, when it is here.
   */
  readonly simulation?: MovementSimulation | undefined;
  /** Stop listening for sync triggers and close the database. */
  dispose(): Promise<void>;
}

/**
 * How a runtime is built. Substituted in tests, and the seam a development
 * build uses to drive the task screen without a real pedometer.
 */
export type CompletionRuntimeFactory = (
  api: ApiClient,
  owner: string,
) => Promise<CompletionRuntime>;

export type CompletionRuntimeState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly runtime: CompletionRuntime }
  | { readonly status: "failed"; readonly message: string };

const FAILED_MESSAGE =
  "Today's task cannot be opened on this device right now. Restart the app and try again.";

/**
 * Everything but the movement, which is the only part a build varies.
 *
 * The database, the sync and the version are the real ones in every build,
 * including the simulated one: a development build that also faked storage or
 * the network would prove nothing about the flow it exists to exercise.
 */
async function openRuntime(
  api: ApiClient,
  owner: string,
  movement: {
    capture: MovementCapture;
    simulation: MovementSimulation | undefined;
    screenLock?: ScreenLock;
  },
): Promise<CompletionRuntime> {
  const { foregroundTrigger, openNativeDatabase, reconnectTrigger } = await import(
    "./native-store.ts"
  );

  const store = await openPendingCompletionStore({ database: await openNativeDatabase(), owner });
  const sync = createCompletionSync({
    store,
    client: api,
    triggers: [foregroundTrigger, reconnectTrigger],
  });

  // Not awaited: the first pass talks to the network, and a screen that waited
  // for it would be blank for as long as a bad connection takes to time out.
  void sync.start();

  // Held here rather than by the task screen, because the window and the screen
  // have different lifetimes: a capture that is still open when its screen
  // unmounts is still counting, and the phone must not lock under it.
  const releaseScreen = keepScreenAwakeWhileWalking(
    movement.capture,
    movement.screenLock ?? createConfiguredScreenLock(),
  );

  return {
    store,
    sync,
    capture: movement.capture,
    simulation: movement.simulation,
    appVersion: loadAppConfig().appVersion,
    async dispose() {
      sync.stop();
      releaseScreen();
      await store.close();
    },
  };
}

export async function createNativeCompletionRuntime(
  api: ApiClient,
  owner: string,
): Promise<CompletionRuntime> {
  const { createNativeMovementCapture } = await import("../movement/native-pedometer.ts");
  return openRuntime(api, owner, { capture: createNativeMovementCapture(), simulation: undefined });
}

/**
 * A runtime whose steps are typed in rather than walked.
 *
 * `Platform.OS` is still what the observation's source is derived from, because
 * the code really is running on that platform and the alternative - naming a
 * source of our own - would put a value on the server that no real device can
 * produce. What makes these completions identifiable is the build: nothing
 * reaches here unless it was built with movement simulation turned on.
 */
export async function createSimulatedCompletionRuntime(
  api: ApiClient,
  owner: string,
): Promise<CompletionRuntime> {
  const [{ createMovementCapture }, { createSimulatedMovement }, { Platform }] = await Promise.all([
    import("../movement/capture.ts"),
    import("../movement/simulated-pedometer.ts"),
    import("react-native"),
  ]);

  const movement = createSimulatedMovement();
  return openRuntime(api, owner, {
    capture: createMovementCapture({
      pedometer: movement.pedometer,
      foreground: movement.foreground,
      platform: Platform.OS,
    }),
    simulation: movement.simulation,
  });
}

/** The runtime this build asked for. One read of the config decides it. */
export async function createConfiguredCompletionRuntime(
  api: ApiClient,
  owner: string,
): Promise<CompletionRuntime> {
  return loadAppConfig().simulateMovement
    ? createSimulatedCompletionRuntime(api, owner)
    : createNativeCompletionRuntime(api, owner);
}

/**
 * A runtime for as long as the component that asked for one is mounted.
 *
 * A runtime that finishes opening after the component has gone is disposed
 * rather than kept: leaving it would hold a database handle and a foreground
 * listener that nothing can ever reach again.
 *
 * `owner` is the account the walks belong to. It is part of the effect's
 * dependencies, so a phone signed into a second account opens the store again
 * for that account rather than carrying on with the first one's records; `null`
 * means nobody is signed in, which is not a database to open at all.
 */
export function useCompletionRuntime(
  api: ApiClient,
  owner: string | null,
  create: CompletionRuntimeFactory,
): CompletionRuntimeState {
  const [state, setState] = useState<CompletionRuntimeState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    let opened: CompletionRuntime | null = null;

    setState({ status: "loading" });
    if (owner === null) {
      return;
    }
    void create(api, owner).then(
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
  }, [api, create, owner]);

  return state;
}
