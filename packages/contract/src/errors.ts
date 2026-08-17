/**
 * Error codes, and what a client is meant to do about each one.
 *
 * The app's pending completion store needs exactly this distinction: a record
 * whose error is `retry` stays pending and is attempted again, and a record
 * whose error is `reject` is retained, surfaced, and never retried silently.
 * Leaving that judgment to the app would mean two implementations of it.
 */

import { z } from "zod";
import { instant } from "./primitives.ts";

export const errorCode = z.enum([
  // Request shape and session.
  "validation_failed",
  "unauthenticated",
  "session_expired",
  "forbidden",
  "not_found",
  "rate_limited",
  "internal_error",

  // Idempotency.
  "idempotency_key_reused",
  "idempotency_in_progress",

  // Challenge lifecycle.
  "active_challenge_exists",
  "challenge_not_active",
  "deposit_amount_invalid",
  "deposit_required_for_funding",
  "zero_deposit_required",
  "maximum_duration_exceeded",
  "schedule_invalid",

  // Completion.
  "task_already_resolved",
  "deadline_passed",
  "completion_outside_task_window",
  "movement_provenance_rejected",
  "step_target_not_met",

  // Pause and time zone.
  "pause_cutoff_passed",
  "challenge_already_paused",
  "challenge_not_paused",

  // Recovery.
  "recovery_not_offered",
  "recovery_window_closed",
  "recovery_already_consumed",

  // Payments.
  "payment_declined",
  "payment_method_invalid",
  "webhook_signature_invalid",

  // Account deletion.
  "account_has_active_funded_challenge",
]);

/**
 * Whether a client should attempt the same command again.
 *
 * `retry` covers everything the server might answer differently later.
 * `reject` covers everything that will answer the same way forever, so a
 * client that keeps trying is only burning the user's battery.
 */
export const errorDisposition = z.enum(["retry", "reject"]);

export const ERROR_DISPOSITIONS: Readonly<Record<ErrorCode, ErrorDisposition>> = {
  validation_failed: "reject",
  unauthenticated: "reject",
  session_expired: "reject",
  forbidden: "reject",
  not_found: "reject",
  rate_limited: "retry",
  internal_error: "retry",

  idempotency_key_reused: "reject",
  // The first attempt still holds its lease. The same key will resolve later.
  idempotency_in_progress: "retry",

  active_challenge_exists: "reject",
  challenge_not_active: "reject",
  deposit_amount_invalid: "reject",
  deposit_required_for_funding: "reject",
  zero_deposit_required: "reject",
  maximum_duration_exceeded: "reject",
  schedule_invalid: "reject",

  task_already_resolved: "reject",
  deadline_passed: "reject",
  completion_outside_task_window: "reject",
  movement_provenance_rejected: "reject",
  step_target_not_met: "reject",

  pause_cutoff_passed: "reject",
  challenge_already_paused: "reject",
  challenge_not_paused: "reject",

  recovery_not_offered: "reject",
  recovery_window_closed: "reject",
  recovery_already_consumed: "reject",

  payment_declined: "reject",
  payment_method_invalid: "reject",
  webhook_signature_invalid: "reject",

  account_has_active_funded_challenge: "reject",
};

/**
 * One failed field. Present only for `validation_failed`, where the app has
 * something useful to do with the location of the problem.
 */
export const errorDetail = z.object({
  path: z.array(z.union([z.string(), z.int()])),
  message: z.string(),
});

export const errorResponse = z.object({
  code: errorCode,
  /** Human-readable and for developers, not for display to the user. */
  message: z.string(),
  details: z.array(errorDetail).optional(),
  /** Present on `rate_limited` and on a retryable idempotency response. */
  retryAfterSeconds: z.int().nonnegative().optional(),
  /** Present on `idempotency_in_progress`: when the current lease runs out. */
  leaseExpiresAt: instant.optional(),
});

export type ErrorCode = z.infer<typeof errorCode>;
export type ErrorDisposition = z.infer<typeof errorDisposition>;
export type ErrorDetail = z.infer<typeof errorDetail>;
export type ErrorResponse = z.infer<typeof errorResponse>;

/** Whether a client should attempt the same command again after this code. */
export function dispositionOf(code: ErrorCode): ErrorDisposition {
  return ERROR_DISPOSITIONS[code];
}
