/**
 * The app coming back to the front, as a reason to ask the server again.
 *
 * Everything home shows is tied to a wall-clock moment: today's task, the
 * deadline it is judged against, whether a recovery offer is still open, how
 * many days are done. A phone that has been in a pocket since last night is
 * showing all of that as it stood then, so the first thing a returning user
 * sees is yesterday - the one screen in the app where being out of date is
 * indistinguishable from being wrong.
 *
 * The pending-completion sync already treats a return as its "try again now"
 * (see `foregroundTrigger` in completions/native-store.ts). This is the same
 * event for the read, kept separate because sync's triggers are built inside a
 * runtime that opens a database, and a screen must be able to take this one on
 * its own.
 */

import { useEffect, useRef } from "react";
import { AppState } from "react-native";

/** Subscribes to returns, calls `fire` on each, and hands back its unsubscribe. */
export type AppReturnTrigger = (fire: () => void) => () => void;

/**
 * The real one. `active` is the only state that means the user is looking at
 * the app; `inactive` is a passing state (a call arriving, the app switcher)
 * that would otherwise fire a read on the way out as well as on the way back.
 */
export const appReturnTrigger: AppReturnTrigger = (fire) => {
  const subscription = AppState.addEventListener("change", (next) => {
    if (next === "active") {
      fire();
    }
  });
  return () => subscription.remove();
};

/**
 * Calls `onReturn` whenever the app comes back to the front, while `enabled`.
 *
 * `enabled` is how a caller says the user is somewhere a refresh is welcome. A
 * re-read that lands while someone is mid-way through another screen would pull
 * that screen out from under them, so home only asks for this while it is
 * itself what is on screen.
 *
 * `onReturn` is held in a ref: it is rebuilt on every render by every caller,
 * and resubscribing to the operating system that often would drop returns.
 */
export function useAppReturn(
  onReturn: () => void,
  options: { readonly enabled: boolean; readonly trigger?: AppReturnTrigger },
): void {
  const { enabled, trigger } = options;
  const latest = useRef(onReturn);
  latest.current = onReturn;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const subscribe = trigger ?? appReturnTrigger;
    return subscribe(() => latest.current());
  }, [enabled, trigger]);
}
