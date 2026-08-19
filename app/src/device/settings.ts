/**
 * The way out of a permission the app cannot grant itself.
 *
 * Three of the app's dead ends are the operating system's to open, not the
 * app's: motion access refused before a walk, motion access revoked during one,
 * and notifications refused so no alarm can be set. In every case the app knows
 * exactly what has to change and cannot change it, and until now said so as
 * prose - "Turn it on in Settings" - which leaves a user who has just been
 * stopped from walking to go and find the right page themselves, on the one
 * morning they have least patience for it.
 *
 * `Linking.openSettings()` puts them on this app's own settings page in one
 * press, so the sentence that names the problem now carries the fix.
 *
 * It is a port for the same reason the notifier and the pedometer are: a test
 * must be able to press the button without the machine opening a settings app,
 * and a build that cannot open one has to be able to say so.
 */

import { useCallback, useState } from "react";
import { Linking } from "react-native";

/** How the app asks the operating system for its own settings page. */
export interface SettingsLauncher {
  /**
   * Opens this app's page in the device's settings. Rejects when the platform
   * has no such page, which is what the caller reports rather than leaving the
   * press looking as though nothing happened.
   */
  open(): Promise<void>;
}

/** The real one. The only place in the app that reaches for `Linking`. */
export function createConfiguredSettingsLauncher(): SettingsLauncher {
  return { open: () => Linking.openSettings() };
}

/**
 * What a screen offering the press needs to draw it: whether the request is in
 * flight, and whether the last one was refused by the platform.
 */
export interface OpenSettingsState {
  readonly open: () => void;
  readonly opening: boolean;
  readonly failed: boolean;
}

/**
 * The press, with its own outcome held.
 *
 * A refusal is remembered rather than swallowed, because the button is the only
 * thing on screen standing between the user and a walk they cannot take: a
 * press that silently did nothing would read as the app being broken on top of
 * the permission already being off.
 */
export function useOpenSettings(launcher: SettingsLauncher): OpenSettingsState {
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);

  const open = useCallback(() => {
    setOpening(true);
    void (async () => {
      try {
        await launcher.open();
        setFailed(false);
      } catch {
        setFailed(true);
      } finally {
        setOpening(false);
      }
    })();
  }, [launcher]);

  return { open, opening, failed };
}

/** The label, worded the same way wherever the press appears. */
export const OPEN_SETTINGS_LABEL = "Open Settings";

/**
 * What is said when the platform would not open its own settings. The prose
 * instruction the button replaced is the fallback, stated in full, because at
 * that point walking there by hand is the only route left.
 */
export const SETTINGS_UNAVAILABLE_TEXT =
  "This phone would not open its settings from here. Open the Settings app, find BetterWakeUp, and change it there.";
