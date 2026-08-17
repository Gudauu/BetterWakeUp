/**
 * Telling the two kinds of Lambda invocation apart.
 *
 * The architecture requires this decision before anything else runs: a
 * scheduled invocation must never pass through Hono, so the sweep has no HTTP
 * surface to protect. That only holds if the discrimination cannot be
 * influenced by a request body, which is why both predicates read the envelope
 * AWS builds and never anything the caller supplies.
 */

/**
 * A scheduled invocation.
 *
 * EventBridge Scheduler sends whatever input its target is configured with, so
 * this shape is ours to fix. Issue 36 configures the rules to send exactly it.
 */
export interface ScheduledEvent {
  readonly source: "aws.scheduler";
  readonly "detail-type"?: string;
  /** The scheduled instant, as EventBridge formats it. */
  readonly time?: string;
}

/**
 * A Function URL invocation.
 *
 * A payload format 2.0 event always carries `requestContext.http.method`.
 * Nothing a client sends can add that key, because the field is written by the
 * Function URL integration around the request rather than parsed out of it.
 */
export function isHttpEvent(event: unknown): boolean {
  if (!isRecord(event)) return false;
  const requestContext = event.requestContext;
  if (!isRecord(requestContext)) return false;
  const http = requestContext.http;
  return isRecord(http) && typeof http.method === "string";
}

/**
 * Whether this invocation is the scheduled sweep.
 *
 * An HTTP event is excluded first. A request whose body happens to contain
 * `source: "aws.scheduler"` is still an HTTP event, so it reaches Hono and a
 * route, never the sweep.
 */
export function isScheduledEvent(event: unknown): event is ScheduledEvent {
  if (isHttpEvent(event)) return false;
  return isRecord(event) && event.source === "aws.scheduler";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
