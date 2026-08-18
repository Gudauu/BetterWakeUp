/**
 * A step counter a person can drive by hand.
 *
 * Today's task is the one screen that cannot be exercised by opening the app:
 * it wants a device with a pedometer and a walk long enough to reach the step
 * target, so on a simulator it is a dead end and on a phone it costs a walk per
 * attempt. This is the way out. It satisfies the same `Pedometer` port the real
 * one does, reports itself available and granted, and delivers exactly the
 * steps something asks it to deliver.
 *
 * It is a development affordance and not a fake in the test sense: the capture,
 * the store, the sync and the server above it are all the real ones, and only
 * the readings are typed in rather than walked. A build that enables it says so
 * on the task screen, because a screen that silently counts invented steps
 * would be indistinguishable from a broken one.
 *
 * The steps are cumulative per subscription, the way `watchStepCount` is on
 * both platforms, so the capture's "latest reading replaces the previous one"
 * rule is exercised rather than bypassed.
 */

import type { ForegroundState, Pedometer, StepCountReading } from "./pedometer.ts";

/** The handle a screen uses to put steps into the open window. */
export interface MovementSimulation {
  /** Steps delivered to the window that is open now, or zero if none is. */
  stepsSoFar(): number;
  /** Deliver `count` more steps to whatever window is open. */
  addSteps(count: number): void;
}

export interface SimulatedMovement {
  readonly pedometer: Pedometer;
  readonly foreground: ForegroundState;
  readonly simulation: MovementSimulation;
}

interface Watcher {
  steps: number;
  listener: (reading: StepCountReading) => void;
}

export function createSimulatedMovement(): SimulatedMovement {
  // A capture holds one subscription at a time, but a set rather than a single
  // slot is what makes `remove()` mean removed: a window the capture has closed
  // must stop receiving steps even though this pedometer is the one handing
  // them out.
  const watchers = new Set<Watcher>();

  const pedometer: Pedometer = {
    isAvailable: async () => true,
    getPermission: async () => "granted",
    requestPermission: async () => "granted",
    watchStepCount(listener) {
      const watcher: Watcher = { steps: 0, listener };
      watchers.add(watcher);
      return {
        remove() {
          watchers.delete(watcher);
        },
      };
    },
  };

  /**
   * Always in front of the user. Backgrounding a simulator build to test the
   * foreground rule is not what this exists for, and reading the real
   * `AppState` here would drag React Native into a module that needs none.
   */
  const foreground: ForegroundState = {
    isForeground: () => true,
    subscribe: () => ({ remove: () => {} }),
  };

  const simulation: MovementSimulation = {
    stepsSoFar() {
      let most = 0;
      for (const watcher of watchers) {
        most = Math.max(most, watcher.steps);
      }
      return most;
    },
    addSteps(count) {
      if (count <= 0) {
        return;
      }
      for (const watcher of watchers) {
        watcher.steps += count;
        watcher.listener({ steps: watcher.steps });
      }
    },
  };

  return { pedometer, foreground, simulation };
}
