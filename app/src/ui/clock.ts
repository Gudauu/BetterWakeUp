/**
 * The clock, as a thing a screen can render.
 *
 * Several of this app's sentences are only true for a few minutes: how long is
 * left before this morning's deadline, how long is left to decide on a recovery
 * offer, and whether either window has closed. Read at render time they are
 * correct exactly once - the moment the screen was drawn - and a phone left
 * face-up on a kitchen counter then shows "12 minutes left" for the rest of the
 * hour, and goes on offering a walk the server has already stopped accepting.
 *
 * So the clock is state, and this hook is what moves it. Every screen whose
 * wording depends on the current instant reads it from here, so a countdown on
 * one screen cannot tick while the same countdown on another stands still.
 */

import { useEffect, useRef, useState } from "react";

/**
 * How often the clock is re-read. Everything the app counts down is worded in
 * whole minutes, so half a minute is fine enough that a reading is never more
 * than one tick stale, and coarse enough not to wake a sleeping screen twice a
 * second for a sentence that changes sixty times an hour.
 */
export const CLOCK_INTERVAL_MS = 30_000;

/**
 * The current instant, re-read on a timer.
 *
 * `now` is the caller's way of reading the clock, which a test states so that
 * what a screen says is a fact of the test rather than of the day it is run on.
 * A stated clock that keeps answering the same instant produces no re-renders
 * at all: the tick only publishes an instant that differs from the one on
 * screen, so a fixed clock leaves its screen exactly as still as it was.
 */
export function useClock(now?: () => Date): Date {
  const read = now ?? (() => new Date());
  const [clock, setClock] = useState<Date>(read);
  // Held in a ref so a caller passing a fresh arrow on every render does not
  // tear the interval down and build it again between two ticks.
  const readRef = useRef(read);
  readRef.current = read;

  useEffect(() => {
    const timer = setInterval(() => {
      const next = readRef.current();
      setClock((previous) => (previous.getTime() === next.getTime() ? previous : next));
    }, CLOCK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  return clock;
}
