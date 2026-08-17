/**
 * Structured JSON logging.
 *
 * One line per event, one JSON object per line, which is what CloudWatch Logs
 * Insights can query without a parser.
 *
 * The field set is closed. `LogFields` names every field the architecture asks
 * for under Observability and nothing else, so a caller cannot reach for
 * `logger.info("...", { idToken })` and have it compile. That is the primary
 * defence against logging a session token, a provider ID token, raw health
 * data, or a payment credential; `scrub` is the secondary one, covering the
 * free text of messages we did not write.
 */

import type { ErrorCode } from "@betterwakeup/contract";
import type { ErrorClassification } from "../errors/app-error.ts";
import { scrub } from "./redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Every field a log line may carry.
 *
 * Identifiers only. There is deliberately no `data`, `payload`, `extra`, or
 * `Record<string, unknown>` escape hatch: one would make every rule in this
 * module advisory.
 *
 * Every field spells out `| undefined` because the repository sets
 * `exactOptionalPropertyTypes`. A caller usually reads a field from somewhere
 * that may not have it, such as a header, and forcing each of those to a
 * conditional spread would make log statements harder to read than the code
 * they describe. The writer drops undefined values rather than emitting nulls.
 */
export interface LogFields {
  /** The Lambda request ID, or the invocation ID for a scheduled run. */
  readonly requestId?: string | undefined;
  readonly accountId?: string | undefined;
  readonly challengeId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  /** The command being attempted, such as `createCompletion`. */
  readonly command?: string | undefined;
  /** What the command did, such as `accepted`, `replayed`, or `rejected`. */
  readonly result?: string | undefined;
  /** The payment provider's own event identifier, never a credential. */
  readonly paymentProvider?: string | undefined;
  readonly paymentEventId?: string | undefined;
  /** The outcome of an authorization renewal attempt. */
  readonly authorizationRenewal?: "renewed" | "unchanged" | "failed" | undefined;
  /** Whether the deposit is currently secured by a live authorization. */
  readonly depositSecured?: boolean | undefined;
  readonly errorClassification?: ErrorClassification | undefined;
  readonly errorCode?: ErrorCode | undefined;

  // HTTP and invocation shape.
  readonly method?: string | undefined;
  /** The matched route pattern, never the raw URL, which can carry a query. */
  readonly route?: string | undefined;
  readonly status?: number | undefined;
  readonly durationMs?: number | undefined;
  /** Which arm of the handler took the event: `http` or `scheduled`. */
  readonly invocation?: "http" | "scheduled" | undefined;
}

/** Where a finished line goes. Injected so tests read lines rather than stdout. */
export type LogSink = (line: string) => void;

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly sink?: LogSink;
  /** A clock, so a test can assert a whole line rather than most of one. */
  readonly now?: () => Date;
  readonly base?: LogFields;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger carrying these fields on every line it writes. */
  child(fields: LogFields): Logger;
}

const defaultSink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? readLevelFromEnvironment();
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());
  const base = options.base ?? {};

  const write = (lineLevel: LogLevel, message: string, fields: LogFields | undefined): void => {
    if (LEVEL_ORDER[lineLevel] < LEVEL_ORDER[level]) return;
    const line: Record<string, unknown> = {
      timestamp: now().toISOString(),
      level: lineLevel,
      message: scrub(message),
    };
    for (const [key, value] of Object.entries({ ...base, ...fields })) {
      if (value === undefined) continue;
      line[key] = typeof value === "string" ? scrub(value) : value;
    }
    sink(JSON.stringify(line));
  };

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    child: (fields) => createLogger({ ...options, level, sink, now, base: { ...base, ...fields } }),
  };
}

function readLevelFromEnvironment(): LogLevel {
  const configured = process.env.LOG_LEVEL;
  return configured !== undefined && configured in LEVEL_ORDER ? (configured as LogLevel) : "info";
}
