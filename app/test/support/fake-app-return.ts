/**
 * The app coming back to the front, as something a test can do.
 *
 * The real trigger is React Native's AppState, which a test has no way to move
 * honestly. Here a return is a call, so "the user put the phone down and picked
 * it up again the next morning" is one line.
 */

import { act } from "@testing-library/react-native";
import type { AppReturnTrigger } from "../../src/challenges/app-return.ts";

export interface FakeAppReturn {
  readonly trigger: AppReturnTrigger;
  /** The app comes back. Settles whatever the return started. */
  fire(): Promise<void>;
  /** How many subscribers are listening, which is how "and stops" is read. */
  listening(): number;
}

export function fakeAppReturn(): FakeAppReturn {
  const listeners = new Set<() => void>();
  return {
    trigger: (fire) => {
      listeners.add(fire);
      return () => {
        listeners.delete(fire);
      };
    },
    async fire() {
      // The state a return writes is React's, so it has to be an act - and an
      // asynchronous one, because what it starts is a request.
      await act(async () => {
        for (const listener of [...listeners]) {
          listener();
        }
      });
    },
    listening: () => listeners.size,
  };
}
