/**
 * Foreground movement capture.
 *
 * The whole of the app's movement rule lives here: a capture exists only while
 * the app is in front of the user, it is torn down the instant that stops
 * being true, and any reading that arrives afterwards is discarded rather than
 * counted. Backgrounding is not a pause; it ends the window.
 *
 * Permission is re-read from the operating system at both ends of a capture.
 * Reading it at the start is what makes a revocation performed in Settings
 * visible on the next attempt; reading it again at the end is what stops a
 * window gathered under a permission the user has since taken away from being
 * offered as evidence.
 */

import type { MovementObservation } from "@betterwakeup/contract";
import { observeLiveForeground } from "./observation.ts";
import type { ForegroundState, Pedometer, PedometerSubscription } from "./pedometer.ts";

/** Why a capture ended. */
export type StopReason = "requested" | "backgrounded" | "permission-revoked";

export type CaptureState =
  /** Nothing has been captured yet. */
  | { status: "idle" }
  /** This device has no step counter, so nothing here can work. */
  | { status: "unsupported" }
  /** Motion access was refused. The screen explains; it does not retry. */
  | { status: "permission-denied" }
  /** Watching. `steps` is what has been observed since `startedAt`. */
  | { status: "recording"; startedAt: Date; steps: number }
  /**
   * The window is closed. `observation` is null when the window produced no
   * usable evidence, which is the case for a capture that never really began
   * and for one whose permission was revoked while it ran.
   */
  | {
      status: "stopped";
      reason: StopReason;
      observation: MovementObservation | null;
    };

export interface MovementCapture {
  getState(): CaptureState;
  /** Watch state changes. Returns the unsubscribe. */
  subscribe(listener: (state: CaptureState) => void): () => void;
  /** Begin a window, prompting for motion access if it has not been asked for. */
  start(): Promise<CaptureState>;
  /** End the window the user asked us to end. */
  stop(): Promise<CaptureState>;
}

export interface MovementCaptureDependencies {
  pedometer: Pedometer;
  foreground: ForegroundState;
  /** `Platform.OS`, passed in so the module needs no React Native import. */
  platform: string;
  now?: () => Date;
}

export function createMovementCapture(deps: MovementCaptureDependencies): MovementCapture {
  const now = deps.now ?? (() => new Date());

  let state: CaptureState = { status: "idle" };
  const listeners = new Set<(state: CaptureState) => void>();

  /**
   * The window currently being watched. Identity is the guard: a reading or a
   * foreground change belonging to a window that has already closed compares
   * unequal and is ignored, so a subscription that outlives its `remove()` by
   * one delivery cannot add steps to the next window or to a finished one.
   */
  interface Window {
    startedAt: Date;
    steps: number;
    steps$: PedometerSubscription;
    foreground$: PedometerSubscription;
  }
  let open: Window | null = null;

  function publish(next: CaptureState): CaptureState {
    state = next;
    for (const listener of listeners) {
      listener(next);
    }
    return next;
  }

  function closeWindow(window: Window): void {
    window.steps$.remove();
    window.foreground$.remove();
    if (open === window) {
      open = null;
    }
  }

  /**
   * End a window and decide what it produced. Permission is re-read here, and
   * a revoked one discards the observation: the steps may well be real, but
   * the app no longer has the user's word that it may look at them.
   */
  async function finish(window: Window, reason: StopReason): Promise<CaptureState> {
    const endedAt = now();
    closeWindow(window);

    const permission = await deps.pedometer.getPermission();
    if (permission !== "granted") {
      return publish({ status: "stopped", reason: "permission-revoked", observation: null });
    }

    return publish({
      status: "stopped",
      reason,
      observation: observeLiveForeground({
        startedAt: window.startedAt,
        endedAt,
        steps: window.steps,
        platform: deps.platform,
      }),
    });
  }

  async function start(): Promise<CaptureState> {
    if (open !== null) {
      return state;
    }

    if (!(await deps.pedometer.isAvailable())) {
      return publish({ status: "unsupported" });
    }

    // Asked for every time rather than cached: a permission read once at
    // launch is a permission that cannot notice being revoked.
    const standing = await deps.pedometer.getPermission();
    const permission =
      standing === "undetermined" ? await deps.pedometer.requestPermission() : standing;
    if (permission !== "granted") {
      return publish({ status: "permission-denied" });
    }

    // Between the availability check and here the user may have left. Starting
    // a window nobody is looking at would record movement the rule forbids.
    if (!deps.foreground.isForeground()) {
      return publish({ status: "stopped", reason: "backgrounded", observation: null });
    }

    const window: Window = {
      startedAt: now(),
      steps: 0,
      steps$: { remove: () => {} },
      foreground$: { remove: () => {} },
    };
    open = window;

    window.steps$ = deps.pedometer.watchStepCount((reading) => {
      if (open !== window) {
        return;
      }
      // `watchStepCount` reports steps since the subscription began, so the
      // latest delivery replaces the previous one. The maximum guards the one
      // way that can go backwards: an Android step counter that resets under
      // the subscription would otherwise shrink an already-observed window.
      window.steps = Math.max(window.steps, reading.steps);
      publish({ status: "recording", startedAt: window.startedAt, steps: window.steps });
    });

    window.foreground$ = deps.foreground.subscribe((foreground) => {
      if (open !== window || foreground) {
        return;
      }
      void finish(window, "backgrounded");
    });

    return publish({ status: "recording", startedAt: window.startedAt, steps: 0 });
  }

  async function stop(): Promise<CaptureState> {
    const window = open;
    if (window === null) {
      return state;
    }
    return finish(window, "requested");
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    stop,
  };
}
