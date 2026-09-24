/**
 * The walk window, as it is chosen and as it is read back.
 *
 * `docs/product.md` defines it as how long before each deadline the walk
 * opens: movement before that does not count, on the phone or on the server.
 * The contract holds the bounds - more than 2 minutes and less than 2 hours -
 * and this module is the form's side of them: the presets offered beside the
 * stepper, a stepper that cannot leave the bounds, and the sentence that turns
 * "10 minutes" into the clock time a morning opens at.
 *
 * The reading is the configuring half only. Once a challenge runs, the server
 * states each task's own opening instant as `opensAt`, which is also bounded by
 * the previous task's deadline, and nothing here pretends to know that.
 */

import { MAXIMUM_WALK_WINDOW_MINUTES, MINIMUM_WALK_WINDOW_MINUTES } from "@betterwakeup/contract";
import { formatDuration, formatWallClock } from "../ui/format.ts";
import { earliestDeadline, skipCutoffFor } from "./no-regret.ts";

/** The product's default: ten minutes is enough to get up and walk 250 steps. */
export const DEFAULT_WALK_WINDOW_MINUTES = 10;

/** The lengths offered as one press each. The stepper reaches everything between. */
export const WALK_WINDOW_PRESETS: readonly number[] = [5, 10, 15, 30, 60];

/** The hint under the control, which is the whole of what the setting is for. */
export const WALK_WINDOW_HINT =
  "How long before each deadline your walk opens. Steps taken before then do not count, so this is when you have to be up.";

/** The contract's complaint, in the words the form uses. */
export const WALK_WINDOW_OUT_OF_RANGE = `The walk window has to be between ${MINIMUM_WALK_WINDOW_MINUTES} and ${MAXIMUM_WALK_WINDOW_MINUTES} minutes.`;

/** The nearest whole number of minutes the contract accepts. */
export function clampWalkWindow(minutes: number): number {
  if (Number.isNaN(minutes)) {
    return DEFAULT_WALK_WINDOW_MINUTES;
  }
  return Math.min(
    MAXIMUM_WALK_WINDOW_MINUTES,
    Math.max(MINIMUM_WALK_WINDOW_MINUTES, Math.round(minutes)),
  );
}

/** One press of the stepper: a minute either way, never past a bound. */
export function stepWalkWindow(minutes: number, direction: 1 | -1): number {
  return clampWalkWindow(minutes + direction);
}

/** Whether the stepper can still move that way, so the button can say it cannot. */
export function canStepWalkWindow(minutes: number, direction: 1 | -1): boolean {
  return direction === 1
    ? minutes < MAXIMUM_WALK_WINDOW_MINUTES
    : minutes > MINIMUM_WALK_WINDOW_MINUTES;
}

/**
 * The setting read back against the mornings picked so far.
 *
 * The earliest deadline is the one named, because it is the one most likely to
 * open on the day before: a 12:30 AM morning with an hour's window opens at
 * 11:30 PM the night before, and saying "11:30 PM" alone would name the wrong
 * night.
 */
export function walkWindowReading(
  minutes: number,
  schedule: readonly { readonly deadline: string }[],
): string {
  const earliest = earliestDeadline(schedule);
  const opens = earliest === null ? null : skipCutoffFor(earliest, minutes);
  if (earliest === null || opens === null) {
    return `Your walk opens ${formatDuration(minutes)} before each deadline.`;
  }
  const night = opens.daysBefore > 0 ? " the night before" : "";
  return `A ${formatWallClock(earliest)} morning opens at ${formatWallClock(opens.wallClock)}${night}. Steps before then do not count.`;
}

/** The setting as the challenge page states it. */
export function walkWindowSummary(minutes: number): string {
  return `${formatDuration(minutes)} before the deadline`;
}
