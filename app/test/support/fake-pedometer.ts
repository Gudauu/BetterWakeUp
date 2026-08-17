/**
 * A pedometer and a foreground state a test drives by hand.
 *
 * Both keep their subscriptions after `remove()` so a test can deliver a
 * reading to a subscription the capture believes it has cancelled, which is
 * the only way to prove the backgrounded-app rule is enforced by the capture
 * rather than by the platform being polite.
 */

import type {
  ForegroundState,
  MovementPermission,
  Pedometer,
  StepCountReading,
} from "../../src/movement/pedometer.ts";

export interface FakePedometer extends Pedometer {
  available: boolean;
  permission: MovementPermission;
  /** What `requestPermission` answers; defaults to granting. */
  onRequest: MovementPermission;
  requests: number;
  /** Deliver a cumulative step count to every listener ever registered. */
  deliver(steps: number): void;
  /** How many subscriptions are currently live. */
  liveSubscriptions(): number;
}

export function createFakePedometer(overrides: Partial<FakePedometer> = {}): FakePedometer {
  const listeners: Array<(reading: StepCountReading) => void> = [];
  let live = 0;

  const fake: FakePedometer = {
    available: true,
    permission: "granted",
    onRequest: "granted",
    requests: 0,
    isAvailable: async () => fake.available,
    getPermission: async () => fake.permission,
    async requestPermission() {
      fake.requests += 1;
      fake.permission = fake.onRequest;
      return fake.permission;
    },
    watchStepCount(listener) {
      listeners.push(listener);
      live += 1;
      let removed = false;
      return {
        remove() {
          if (!removed) {
            removed = true;
            live -= 1;
          }
        },
      };
    },
    deliver(steps) {
      for (const listener of listeners) {
        listener({ steps });
      }
    },
    liveSubscriptions: () => live,
    ...overrides,
  };

  return fake;
}

export interface FakeForeground extends ForegroundState {
  /** Move the app to the background or back, notifying every listener. */
  set(foreground: boolean): void;
}

export function createFakeForeground(initial = true): FakeForeground {
  let foreground = initial;
  const listeners: Array<(foreground: boolean) => void> = [];

  return {
    isForeground: () => foreground,
    subscribe(listener) {
      listeners.push(listener);
      return { remove: () => {} };
    },
    set(next) {
      foreground = next;
      for (const listener of listeners) {
        listener(next);
      }
    },
  };
}
