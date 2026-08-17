/**
 * Scheduled tasks and the completion command.
 *
 * A task's date is a calendar date in the challenge's time zone, and its
 * deadline and pause cutoff are absolute instants the server computed from
 * that date. The app renders those instants; it never derives them.
 */

import { z } from "zod";
import { movementObservation } from "./movement.ts";
import { idempotencyKey, instant, localDate, resourceId } from "./primitives.ts";

export const taskStatus = z.enum(["scheduled", "completed", "skipped", "missed", "forgiven"]);

export const taskView = z.object({
  id: resourceId,
  date: localDate,
  deadline: instant,
  /** Deadline minus the challenge's No Regret Time. Pausing after this leaves the task live. */
  pauseCutoff: instant,
  status: taskStatus,
  /** When the server acknowledged the completion, not when the device recorded it. */
  acknowledgedAt: instant.nullable(),
});

export const createCompletionRequest = z.object({
  /**
   * The pending completion record's own ID, which is also the idempotency key
   * the request carries in its header. Sending it in the body too lets the
   * server reject a key that belongs to a different record.
   */
  clientRecordId: idempotencyKey,
  /** When the device evaluated the step target, by the device's clock. */
  completedAt: instant,
  observation: movementObservation,
  appVersion: z.string().min(1).max(40),
  /** The verification policy the app applied, so a rule change is auditable. */
  verificationPolicyVersion: z.string().min(1).max(40),
});

export const createCompletionResponse = z.object({
  task: taskView,
  /**
   * True when this response was replayed from a stored idempotent result
   * rather than produced by this request. The app treats both as acknowledged.
   */
  replayed: z.boolean(),
  /** The challenge's state after the completion, so the app needs no second call. */
  challengeStatus: z.enum(["active", "succeeded"]),
});

export type TaskStatus = z.infer<typeof taskStatus>;
export type TaskView = z.infer<typeof taskView>;
export type CreateCompletionRequest = z.infer<typeof createCompletionRequest>;
export type CreateCompletionResponse = z.infer<typeof createCompletionResponse>;
