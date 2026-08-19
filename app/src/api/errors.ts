/**
 * The one error the API client throws.
 *
 * Every failure, including one that never reached the server, is expressed as
 * a contract error code with the contract's own disposition attached, so the
 * pending completion store in issue 30 decides what to retry by reading
 * `disposition` rather than by matching on messages or status codes.
 */

import {
  dispositionOf,
  type ErrorCode,
  type ErrorDetail,
  type ErrorDisposition,
  type ErrorResponse,
} from "@betterwakeup/contract";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly disposition: ErrorDisposition;
  /** The HTTP status, or `null` when the request never reached the server. */
  readonly status: number | null;
  readonly details: readonly ErrorDetail[] | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly leaseExpiresAt: string | undefined;
  /**
   * The client gave up waiting rather than being told anything. A timed-out
   * request is not the same failure as one that could not be sent: the bytes
   * may well have arrived and been acted on, so nothing here may be said about
   * whether the command ran.
   */
  readonly timedOut: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      status?: number | null;
      details?: readonly ErrorDetail[] | undefined;
      retryAfterSeconds?: number | undefined;
      leaseExpiresAt?: string | undefined;
      timedOut?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiError";
    this.code = code;
    this.disposition = dispositionOf(code);
    this.status = options.status ?? null;
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.leaseExpiresAt = options.leaseExpiresAt;
    this.timedOut = options.timedOut ?? false;
  }

  /**
   * Whether the request was answered by the server, as far as this device can
   * tell. True when a status came back, false when the send itself failed, and
   * null when the client stopped waiting - a timeout is the one failure where
   * the honest answer is that nobody knows.
   */
  get reachedServer(): boolean | null {
    if (this.status !== null) {
      return true;
    }
    return this.timedOut ? null : false;
  }

  static fromResponse(status: number, body: ErrorResponse): ApiError {
    return new ApiError(body.code, body.message, {
      status,
      details: body.details,
      retryAfterSeconds: body.retryAfterSeconds,
      leaseExpiresAt: body.leaseExpiresAt,
    });
  }

  /** Whether the same command is worth attempting again unchanged. */
  get retryable(): boolean {
    return this.disposition === "retry";
  }
}
