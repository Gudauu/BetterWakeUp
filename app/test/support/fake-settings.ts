/**
 * A settings launcher that records the press instead of leaving the test
 * machine, and can refuse the way a platform with no settings page does.
 */

import type { SettingsLauncher } from "../../src/device/settings.ts";

export interface FakeSettingsLauncher extends SettingsLauncher {
  /** How many times the app asked for the device's settings page. */
  readonly opened: number;
}

export function fakeSettings(
  options: {
    /** Set when the platform has no settings page to open. */
    readonly refuses?: boolean;
  } = {},
): FakeSettingsLauncher {
  let opened = 0;
  return {
    get opened() {
      return opened;
    },
    async open() {
      opened += 1;
      if (options.refuses === true) {
        throw new Error("no settings page on this platform");
      }
    },
  };
}
