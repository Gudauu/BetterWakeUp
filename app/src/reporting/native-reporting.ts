/**
 * The one module that imports Sentry.
 *
 * Everything above it holds a `CrashReporter`, so the decision about what a
 * report may contain is made in code that runs under a test, and this file
 * carries only the wiring: initialize the SDK, hand it the scrubber as its
 * last gate, and turn a `Report` into a Sentry message.
 *
 * A build with no DSN gets the no-op reporter. Reporting is not something the
 * app needs in order to work, and a development build without a Sentry project
 * should be a build without reporting rather than a build that crashes at
 * launch or logs a warning on every failure.
 */

import * as Sentry from "@sentry/react-native";
import type { CrashReporter, Report, ReportSeverity } from "./reporter.ts";
import { noopReporter } from "./reporter.ts";
import { scrubPayload, scrubText } from "./scrub.ts";

export interface SentryReporterOptions {
  readonly dsn: string | undefined;
  readonly appVersion: string;
  /** Which deployment this build talks to, so reports can be told apart. */
  readonly environment: string;
}

const LEVELS: Record<ReportSeverity, Sentry.SeverityLevel> = {
  info: "info",
  warning: "warning",
  error: "error",
};

/**
 * Fields go on as tags rather than as extra data, because a tag is searchable
 * and every field here is an identifier or a classification an operator wants
 * to filter by. `undefined` fields are left off entirely.
 */
function tagsOf(report: Report): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(report.fields)) {
    if (value !== undefined) {
      tags[key] = String(value);
    }
  }
  return tags;
}

export function createSentryReporter(options: SentryReporterOptions): CrashReporter {
  if (options.dsn === undefined || options.dsn.length === 0) {
    return noopReporter;
  }

  Sentry.init({
    dsn: options.dsn,
    release: options.appVersion,
    environment: options.environment,
    // Nothing about the person: no IP address, no device name, no user.
    sendDefaultPii: false,
    // Breadcrumbs the SDK collects on its own quote request bodies and view
    // hierarchies, which is exactly where health data would hide.
    maxBreadcrumbs: 0,
    // The last gate inside the process. Every payload, including one the SDK
    // built for an unhandled crash, is walked before it is sent.
    beforeSend: (event) => scrubPayload(event) as typeof event,
    beforeBreadcrumb: () => null,
  });

  return {
    capture(report) {
      Sentry.captureMessage(report.name, { level: LEVELS[report.severity], tags: tagsOf(report) });
    },
    captureException(error, report) {
      // The message is the one part of a thrown error that routinely quotes
      // the value that caused it, so it is scrubbed here as well as in
      // `beforeSend`.
      if (error instanceof Error) {
        error.message = scrubText(error.message);
      }
      Sentry.captureException(error, {
        level: LEVELS[report.severity],
        tags: { ...tagsOf(report), report: report.name },
      });
    },
  };
}
