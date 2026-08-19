/**
 * A screen reader a test can read back instead of a device that talks.
 */

import type { ScreenReader } from "../../src/ui/screen-change.ts";

export interface FakeScreenReader extends ScreenReader {
  /** Every sentence said out loud, in order. */
  readonly said: () => readonly string[];
}

export function fakeScreenReader(): FakeScreenReader {
  const said: string[] = [];
  return {
    announce: (message) => {
      said.push(message);
    },
    said: () => said,
  };
}
