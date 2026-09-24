/**
 * Whether a walk this phone observed fits inside its task's window.
 *
 * The server refuses a completion whose observation started before the walk
 * opened, however it ended, and one that finished after the deadline. Writing
 * such a walk down would put a record in the store that could only ever come
 * back refused, after the user had been told it was saved - so the phone holds
 * it to the same boundary before anything is recorded, and says why instead.
 *
 * The instants are the server's own `opensAt` and `deadline`. Nothing here
 * derives a window from the schedule, so the phone and the server cannot
 * disagree about where it starts.
 */

import type { MovementObservation, TaskView } from "@betterwakeup/contract";
import { formatTimeOfDay } from "../ui/format.ts";

/** Why a walk falls outside its window, or null when it fits. */
export type WalkOutsideWindow = "started-early" | "finished-late";

export function walkOutsideWindow(
  task: Pick<TaskView, "opensAt" | "deadline">,
  observation: Pick<MovementObservation, "startedAt" | "endedAt">,
): WalkOutsideWindow | null {
  // A walk that started before the window is refused even when it finishes
  // inside it: the steps before the opening are part of the count.
  if (Date.parse(observation.startedAt) < Date.parse(task.opensAt)) {
    return "started-early";
  }
  if (Date.parse(observation.endedAt) > Date.parse(task.deadline)) {
    return "finished-late";
  }
  return null;
}

/** What the walker is told about a walk the phone would not record. */
export function walkOutsideWindowText(
  reason: WalkOutsideWindow,
  task: Pick<TaskView, "opensAt" | "deadline">,
  timeZone: string,
): string {
  if (reason === "started-early") {
    return `This walk started before your walk opened at ${formatTimeOfDay(task.opensAt, timeZone)}, so it cannot count and nothing was recorded. Start a new walk now - it has to reach the target on its own.`;
  }
  return `This walk finished after the ${formatTimeOfDay(task.deadline, timeZone)} deadline, so it cannot count and nothing was recorded.`;
}
