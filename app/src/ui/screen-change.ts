/**
 * Saying where the user has just arrived.
 *
 * Home is a stack one screen deep drawn by swapping what it renders: opening
 * today's walk is a `setRoute`, not a navigation the operating system knows
 * about. A sighted user sees the whole screen replaced and needs nothing said.
 * A screen-reader user gets nothing at all - the control they just activated
 * has been unmounted, so the reader's focus falls off it with no announcement,
 * and the next swipe starts from wherever the platform decides. Nothing says
 * which screen is now up, and the "Back to home" control that gets them out is
 * one they have to hunt for.
 *
 * A real router announces the screen it pushed. This app has no router, so the
 * announcement is made here: one sentence naming the screen, and - for anything
 * sitting on top of home - where the way back is.
 *
 * The port exists for the reason the walk alerts' does: what is said, and above
 * all that it is said on a change rather than on arrival, is worth testing
 * without a device.
 */

import { useEffect, useRef } from "react";
import { AccessibilityInfo } from "react-native";

/** How the app says something to whatever is reading the screen aloud. */
export interface ScreenReader {
  /** Said out loud, if anything on the device is reading the screen aloud. */
  announce(message: string): void;
}

/**
 * The reader this build uses. `announceForAccessibility` comes from React
 * Native itself and is a no-op when nothing is reading the screen, so there is
 * no module to import lazily and nothing to fail on a device with the reader
 * turned off.
 */
export function createConfiguredScreenReader(): ScreenReader {
  return {
    announce: (message) => AccessibilityInfo.announceForAccessibility(message),
  };
}

/** A screen the user can be on, as far as saying so out loud is concerned. */
export interface ScreenChange {
  /**
   * What the screen is called. Said first, because "where am I" is the whole
   * question a lost reader focus raises.
   */
  readonly name: string;
  /**
   * Whether this screen sits on top of home. Every one that does carries the
   * same `BackLink`, so the way out can be named without the rule knowing which
   * screen it is.
   */
  readonly overHome: boolean;
}

/**
 * What is said on arriving at a screen.
 *
 * A screen over home gets its exit named as well: the reader has just lost its
 * place, and the control the user most likely wants next is the one this app
 * puts at the top of every such screen. Home itself gets no such clause - it is
 * the bottom of the app and has nowhere to go back to.
 */
export function screenChangeText(screen: ScreenChange): string {
  return screen.overHome
    ? `${screen.name}. Back to home is at the top of the screen.`
    : `${screen.name}.`;
}

/**
 * Says the screen out loud whenever it changes, and never on arrival.
 *
 * The first screen is not announced: the reader is already about to read it
 * from the top, and talking over that is worse than saying nothing. Only a
 * swap - which the reader has no other way of noticing - is worth a sentence.
 */
export function useScreenChangeAnnouncement(screen: ScreenChange, reader: ScreenReader): void {
  const { name, overHome } = screen;
  // Seeded with where the user already is, so mounting is not a change.
  const said = useRef(name);

  useEffect(() => {
    if (said.current === name) {
      return;
    }
    said.current = name;
    reader.announce(screenChangeText({ name, overHome }));
  }, [name, overHome, reader]);
}
