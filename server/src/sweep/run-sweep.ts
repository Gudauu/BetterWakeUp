/**
 * The scheduled sweep's entry point.
 *
 * Issue 23 fills in the eight-step pass described under "Scheduled evaluation"
 * in the architecture. This exists now so the handler's discrimination has a
 * real destination, and so the invocation arm is logged from the first commit
 * rather than acquiring logging later.
 */

import type { ScheduledEvent } from "../lambda/events.ts";
import type { Logger } from "../observability/logger.ts";

export interface SweepResult {
  /** How many overdue tasks this pass resolved. */
  readonly tasksResolved: number;
  /** Whether work remained when the pass stopped. */
  readonly moreWorkPending: boolean;
}

export async function runSweep(_event: ScheduledEvent, logger: Logger): Promise<SweepResult> {
  logger.info("sweep invoked", { command: "sweep", result: "not_implemented" });
  return await Promise.resolve({ tasksResolved: 0, moreWorkPending: false });
}
