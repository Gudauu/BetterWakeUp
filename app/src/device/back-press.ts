/**
 * The Android back press, as a way out of whatever home opened.
 *
 * Home is a stack one screen deep, but it is a stack the app keeps in its own
 * state: everything it opens - today's task, the setup form, the pause
 * decision, the recovery offer, the card, the time zone, deleting the account -
 * is drawn in place of home rather than pushed onto the router, which holds a
 * single route. Android's own back gesture therefore never had anything to pop,
 * and its default is to leave the app: a user on the task screen who swiped
 * back was put on their home screen mid-walk.
 *
 * The `BackLink` at the top of each of those screens is the affordance this
 * mirrors. Handling the press here rather than teaching the router about eight
 * screens keeps one answer to "where does back go", and it is the same answer
 * the visible control gives.
 *
 * It is a port for the same reasons the settings launcher and the app-return
 * trigger are: a test has to be able to press back without a device, and the
 * press only ever exists on one of the two platforms the app ships on.
 */

import { useEffect, useRef } from "react";
import { BackHandler } from "react-native";

/**
 * Subscribes to back presses and hands back its unsubscribe. `handle` answers
 * whether the app dealt with the press; answering `false` leaves the operating
 * system to do what it would have done, which is to close the app.
 */
export type BackPressTrigger = (handle: () => boolean) => () => void;

/**
 * The real one, and the only place in the app that reaches for `BackHandler`.
 *
 * On iOS this subscribes to an event that never fires - there is no hardware
 * back button - so the hook needs no platform branch of its own.
 */
export const backPressTrigger: BackPressTrigger = (handle) => {
  const subscription = BackHandler.addEventListener("hardwareBackPress", handle);
  return () => subscription.remove();
};

/**
 * Calls `onBack` for each back press while `enabled`, and tells the operating
 * system the press was dealt with.
 *
 * `enabled` is how a caller says it has somewhere to go back to. Home itself
 * has not, so while home is what is on screen the press is left alone and back
 * closes the app, which is what a user at the top of an app means by it.
 *
 * `onBack` is held in a ref because callers rebuild it on every render, and
 * resubscribing that often would drop presses that land in between.
 */
export function useBackPress(
  onBack: () => void,
  options: { readonly enabled: boolean; readonly trigger?: BackPressTrigger },
): void {
  const { enabled, trigger } = options;
  const latest = useRef(onBack);
  latest.current = onBack;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const subscribe = trigger ?? backPressTrigger;
    return subscribe(() => {
      latest.current();
      return true;
    });
  }, [enabled, trigger]);
}
