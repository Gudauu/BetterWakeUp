/**
 * Android's back gesture, as something a test can do.
 *
 * The real trigger is React Native's BackHandler, which only ever fires on a
 * device with a back button, so a test that wanted to press back had no way to.
 * Here a press is a call, and its answer - whether the app dealt with it or let
 * the operating system close the app - is what `press` hands back.
 */

import { act } from "@testing-library/react-native";
import type { BackPressTrigger } from "../../src/device/back-press.ts";

export interface FakeBackPress {
  readonly trigger: BackPressTrigger;
  /**
   * The user presses back. Answers whether anything in the app handled it;
   * `false` is the app closing.
   */
  press(): Promise<boolean>;
  /** How many subscribers are listening, which is how "and stops" is read. */
  listening(): number;
}

export function fakeBackPress(): FakeBackPress {
  const handlers = new Set<() => boolean>();
  return {
    trigger: (handle) => {
      handlers.add(handle);
      return () => {
        handlers.delete(handle);
      };
    },
    async press() {
      let handled = false;
      // Going back is a state change React has to be told about, and what it
      // leads to - home re-reading the challenge - is a request.
      await act(async () => {
        // Last registered first, the way the operating system calls them.
        for (const handle of [...handlers].reverse()) {
          if (handle()) {
            handled = true;
            break;
          }
        }
      });
      return handled;
    },
    listening: () => handlers.size,
  };
}
