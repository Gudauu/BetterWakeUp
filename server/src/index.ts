/**
 * The server's public surface: the Lambda handler AWS invokes, plus the pieces
 * a test or a future entry point (a container, a local dev server) composes.
 */

export type { ErrorClassification } from "./errors/app-error.ts";
export { AppError, ERROR_PROPERTIES, toAppError } from "./errors/app-error.ts";
export type { App, AppEnv } from "./http/app.ts";
export { createApp } from "./http/app.ts";
export type { ScheduledEvent } from "./lambda/events.ts";
export { isHttpEvent, isScheduledEvent } from "./lambda/events.ts";
export { createHandler, handler } from "./lambda/handler.ts";
export type { LogFields, Logger, LogLevel, LogSink } from "./observability/logger.ts";
export { createLogger } from "./observability/logger.ts";
export { scrub } from "./observability/redact.ts";
export { runSweep } from "./sweep/run-sweep.ts";
