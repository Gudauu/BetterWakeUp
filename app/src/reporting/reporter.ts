/**
 * The crash and synchronization reporting port.
 *
 * Everything the app reports goes through this interface, and nothing above it
 * imports Sentry. That is what lets the report a rejected completion produces
 * be asserted in a test: the reporter is a recorder, and the assertion is over
 * the exact payload that would have left the device.
 *
 * The field set is closed, exactly as the server's logger is. A report carries
 * identifiers and outcomes and nothing else, so a session token, an ID token,
 * a step count, or a payment credential cannot be attached to a report without
 * first being given a name here, which is a change a reviewer sees. Free-text
 * scrubbing (see scrub.ts) is the second net under this one, not a substitute
 * for it.
 */

/**
 * The only fields a report may carry.
 *
 * Every one of these is an identifier, a version, a count, or a classification
 * the server itself already has. None of them is health data, credential
 * material, or anything a person typed.
 */
export interface ReportFields {
  /** The pending completion record's ID, which is also its idempotency key. */
  readonly clientRecordId?: string | undefined;
  readonly challengeId?: string | undefined;
  readonly taskId?: string | undefined;
  /** The contract error code, never the server's message. */
  readonly errorCode?: string | undefined;
  /** The contract's disposition for that code: `retry` or `reject`. */
  readonly disposition?: string | undefined;
  /** How many times this record has been sent without acknowledgment. */
  readonly attempts?: number | undefined;
  readonly appVersion?: string | undefined;
  readonly verificationPolicyVersion?: string | undefined;
  /** Where in the app the failure happened, as a fixed name in the source. */
  readonly operation?: string | undefined;
}

/** How much attention a report is asking for. */
export type ReportSeverity = "info" | "warning" | "error";

export interface Report {
  /** A fixed name written in the source, never interpolated from data. */
  readonly name: string;
  readonly severity: ReportSeverity;
  readonly fields: ReportFields;
}

export interface CrashReporter {
  /** Report something that went wrong, with no exception behind it. */
  capture(report: Report): void;
  /** Report a thrown error. The error's message is scrubbed before it leaves. */
  captureException(error: unknown, report: Report): void;
}

/** A reporter that does nothing, for a build with no Sentry project. */
export const noopReporter: CrashReporter = {
  capture() {},
  captureException() {},
};

/** A reporter that keeps what it was given, for tests. */
export interface RecordingReporter extends CrashReporter {
  readonly reports: { report: Report; error?: unknown }[];
}

export function createRecordingReporter(): RecordingReporter {
  const reports: { report: Report; error?: unknown }[] = [];
  return {
    reports,
    capture(report) {
      reports.push({ report });
    },
    captureException(error, report) {
      reports.push({ report, error });
    },
  };
}
