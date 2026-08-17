/**
 * The one error model.
 *
 * Every failure the server answers with is an `AppError` carrying a contract
 * `ErrorCode`. Nothing else decides an HTTP status or invents a response body,
 * so the shape the app parses is produced in exactly one place.
 *
 * Each code also carries a classification, which is the field the architecture
 * requires in every log line under Observability. A classification groups codes
 * that mean the same thing to an operator: an alarm on `internal` should page
 * someone, and a rise in `validation` is a client that shipped a bad build.
 */

import { dispositionOf, type ErrorCode, type ErrorResponse } from "@betterwakeup/contract";

/**
 * What kind of failure this is, for logs, metrics, and alarms.
 *
 * This is deliberately coarser than the error code. The code tells the app
 * what happened; the classification tells an operator whether to care.
 */
export type ErrorClassification =
  /** The request was malformed or the evidence it carried was unusable. */
  | "validation"
  /** No usable credential: absent, expired, or not verifiable. */
  | "authentication"
  /** A valid credential belonging to someone who may not do this. */
  | "authorization"
  /** The addressed thing does not exist, or is not the caller's. */
  | "not_found"
  /** The request was well-formed but the current state forbids it. */
  | "conflict"
  /** The caller exceeded a limit and should back off. */
  | "rate_limit"
  /** The payment provider refused, which is neither our fault nor a bug. */
  | "payment"
  /** Our fault. The only classification that should ever wake anyone up. */
  | "internal";

interface CodeProperties {
  readonly status: number;
  readonly classification: ErrorClassification;
}

/**
 * Status and classification for every code in the contract.
 *
 * Exhaustive by type: adding a code to the contract without deciding what it
 * means here fails the server typecheck rather than defaulting to a 500.
 */
export const ERROR_PROPERTIES: Readonly<Record<ErrorCode, CodeProperties>> = {
  validation_failed: { status: 400, classification: "validation" },
  unauthenticated: { status: 401, classification: "authentication" },
  session_expired: { status: 401, classification: "authentication" },
  forbidden: { status: 403, classification: "authorization" },
  not_found: { status: 404, classification: "not_found" },
  rate_limited: { status: 429, classification: "rate_limit" },
  internal_error: { status: 500, classification: "internal" },

  // A reused key with a different request body is the caller's bug; a key
  // still in flight is a race the caller resolves by waiting.
  idempotency_key_reused: { status: 409, classification: "conflict" },
  idempotency_in_progress: { status: 409, classification: "conflict" },

  active_challenge_exists: { status: 409, classification: "conflict" },
  challenge_not_active: { status: 409, classification: "conflict" },
  deposit_amount_invalid: { status: 400, classification: "validation" },
  deposit_required_for_funding: { status: 409, classification: "conflict" },
  zero_deposit_required: { status: 409, classification: "conflict" },
  maximum_duration_exceeded: { status: 400, classification: "validation" },
  schedule_invalid: { status: 400, classification: "validation" },

  task_already_resolved: { status: 409, classification: "conflict" },
  deadline_passed: { status: 409, classification: "conflict" },
  completion_outside_task_window: { status: 409, classification: "conflict" },
  // The request parsed; the movement evidence in it did not support the claim.
  // 422 rather than 409 because nothing about the task's state would change it.
  movement_provenance_rejected: { status: 422, classification: "validation" },
  step_target_not_met: { status: 422, classification: "validation" },

  pause_cutoff_passed: { status: 409, classification: "conflict" },
  challenge_already_paused: { status: 409, classification: "conflict" },
  challenge_not_paused: { status: 409, classification: "conflict" },

  recovery_not_offered: { status: 409, classification: "conflict" },
  recovery_window_closed: { status: 409, classification: "conflict" },
  recovery_already_consumed: { status: 409, classification: "conflict" },

  payment_declined: { status: 402, classification: "payment" },
  payment_method_invalid: { status: 402, classification: "payment" },
  // An unverifiable signature is an unauthenticated caller claiming to be the
  // provider, not a payment failure.
  webhook_signature_invalid: { status: 401, classification: "authentication" },

  account_has_active_funded_challenge: { status: 409, classification: "conflict" },
};

export interface AppErrorOptions {
  /** Field-level failures. Meaningful only for `validation_failed`. */
  readonly details?: ErrorResponse["details"];
  /** Seconds to wait. Meaningful for `rate_limited` and idempotency waits. */
  readonly retryAfterSeconds?: number;
  /** When the current idempotency lease runs out. */
  readonly leaseExpiresAt?: string;
  /** The failure underneath this one, kept for logs and never for the client. */
  readonly cause?: unknown;
}

/**
 * A failure the server means to answer with.
 *
 * The message is for developers and logs. It is returned to the client for
 * every code except `internal_error`, where the client is told nothing beyond
 * the code, since an unexpected failure's message is the one most likely to
 * carry something that should not leave the server.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly classification: ErrorClassification;
  readonly details: ErrorResponse["details"];
  readonly retryAfterSeconds: number | undefined;
  readonly leaseExpiresAt: string | undefined;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    const properties = ERROR_PROPERTIES[code];
    this.status = properties.status;
    this.classification = properties.classification;
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.leaseExpiresAt = options.leaseExpiresAt;
  }

  /** Whether a client should attempt the same command again after this. */
  get disposition() {
    return dispositionOf(this.code);
  }

  /** The body sent to the client, exactly matching the contract's shape. */
  toResponse(): ErrorResponse {
    const response: ErrorResponse = {
      code: this.code,
      message: this.code === "internal_error" ? "An unexpected error occurred." : this.message,
    };
    if (this.details !== undefined) response.details = this.details;
    if (this.retryAfterSeconds !== undefined) response.retryAfterSeconds = this.retryAfterSeconds;
    if (this.leaseExpiresAt !== undefined) response.leaseExpiresAt = this.leaseExpiresAt;
    return response;
  }
}

/**
 * Turn anything thrown into the one error model.
 *
 * An unexpected throw becomes `internal_error` with the original kept as the
 * cause, so the log keeps the detail the client is not given.
 */
export function toAppError(thrown: unknown): AppError {
  if (thrown instanceof AppError) return thrown;
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return new AppError("internal_error", message, { cause: thrown });
}
