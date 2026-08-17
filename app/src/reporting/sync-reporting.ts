/**
 * What the sync pass reports.
 *
 * Two things are worth an operator's attention. A rejected completion is one:
 * the architecture lists rejected client completions as an alarm because they
 * mean the app and the server disagree about what a valid completion is, which
 * is a defect rather than a user's mistake. A record that keeps failing is the
 * other, but only once: an app that is simply offline defers every record on
 * every trigger, and reporting each of those would bury the first kind.
 *
 * An acknowledged completion is reported as nothing at all. It is the ordinary
 * outcome, and Sentry is not a metrics pipeline.
 *
 * Nothing here reads the movement observation, the session, or the server's
 * message. The report carries the record's identifiers, the contract error
 * code, and the attempt count.
 */

import type { CompletionSync, CompletionSyncEvent } from "../completions/sync.ts";
import type { CrashReporter, Report } from "./reporter.ts";

/**
 * How many failed attempts a record makes before it is reported once.
 *
 * Three is a record that has survived the app opening, the network returning,
 * and at least one more trigger, which is past anything a brief outage
 * explains.
 */
export const STALLED_AFTER_ATTEMPTS = 3;

/** Build the report for a sync event, or `null` when there is nothing to say. */
export function reportForSyncEvent(event: CompletionSyncEvent): Report | null {
  if (event.type === "acknowledged") {
    return null;
  }

  // `record` is the record as it stood before this attempt, so the attempt
  // just made is the one after the count it carries.
  const attempts = event.record.attempts + 1;

  if (event.type === "rejected") {
    return {
      name: "completion.rejected",
      severity: "error",
      fields: {
        clientRecordId: event.record.id,
        challengeId: event.record.challengeId,
        taskId: event.record.taskId,
        errorCode: event.error.code,
        disposition: event.error.disposition,
        attempts,
        appVersion: event.record.appVersion,
        verificationPolicyVersion: event.record.verificationPolicyVersion,
        operation: "completionSync",
      },
    };
  }

  if (attempts !== STALLED_AFTER_ATTEMPTS) {
    // Reported once, on the attempt that crosses the line. Before that it is
    // an outage; after it, a repeat of something already reported.
    return null;
  }
  return {
    name: "completion.sync_stalled",
    severity: "warning",
    fields: {
      clientRecordId: event.record.id,
      challengeId: event.record.challengeId,
      taskId: event.record.taskId,
      errorCode: event.error.code,
      disposition: event.error.disposition,
      attempts,
      appVersion: event.record.appVersion,
      verificationPolicyVersion: event.record.verificationPolicyVersion,
      operation: "completionSync",
    },
  };
}

/** Subscribe a reporter to a sync. Returns the unsubscribe. */
export function reportCompletionSync(sync: CompletionSync, reporter: CrashReporter): () => void {
  return sync.subscribe((event) => {
    const report = reportForSyncEvent(event);
    if (report !== null) {
      reporter.capture(report);
    }
  });
}
