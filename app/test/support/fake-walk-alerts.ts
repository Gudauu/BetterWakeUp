/**
 * Alerts a test can read back instead of a phone that buzzes and talks.
 */

import type { WalkAlerts } from "../../src/movement/walk-alerts.ts";

export interface FakeWalkAlerts extends WalkAlerts {
  /** How many times the phone was asked to vibrate. */
  readonly buzzes: () => number;
  /** Every sentence handed to the screen reader, in order. */
  readonly said: () => readonly string[];
}

export function fakeWalkAlerts(): FakeWalkAlerts {
  let buzzes = 0;
  const said: string[] = [];
  return {
    vibrate: () => {
      buzzes += 1;
    },
    announce: (message) => {
      said.push(message);
    },
    buzzes: () => buzzes,
    said: () => said,
  };
}
