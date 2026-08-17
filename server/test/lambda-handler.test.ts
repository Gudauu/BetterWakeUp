/**
 * Issue 10's first acceptance boundary: a synthetic scheduled event never
 * reaches Hono.
 *
 * The check is not "the sweep ran" but "Hono was not consulted", so the app
 * this handler is built around records every request it is asked to route.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { isHttpEvent, isScheduledEvent } from "../src/lambda/events.ts";
import { createHandler } from "../src/lambda/handler.ts";
import { createLogger } from "../src/observability/logger.ts";
import { functionUrlEvent, scheduledEvent } from "./support/lambda-events.ts";

function silentLogger() {
  const lines: string[] = [];
  return { logger: createLogger({ sink: (line) => lines.push(line) }), lines };
}

describe("event discrimination", () => {
  it("recognizes a Function URL event by the envelope AWS builds", () => {
    expect(isHttpEvent(functionUrlEvent({ method: "GET", path: "/challenges/current" }))).toBe(
      true,
    );
    expect(isScheduledEvent(functionUrlEvent({ method: "GET", path: "/challenges/current" }))).toBe(
      false,
    );
  });

  it("recognizes a scheduled event", () => {
    expect(isScheduledEvent(scheduledEvent())).toBe(true);
    expect(isHttpEvent(scheduledEvent())).toBe(false);
  });

  it("treats a request whose body claims to be a schedule as an HTTP event", () => {
    const forged = functionUrlEvent({
      method: "POST",
      path: "/sessions",
      body: JSON.stringify({ source: "aws.scheduler" }),
    });
    expect(isScheduledEvent(forged)).toBe(false);
    expect(isHttpEvent(forged)).toBe(true);
  });

  it("rejects shapes that are neither", () => {
    for (const value of [null, undefined, 42, "aws.scheduler", [], { source: "aws.events" }]) {
      expect(isScheduledEvent(value)).toBe(false);
      expect(isHttpEvent(value)).toBe(false);
    }
  });
});

describe("the Lambda handler", () => {
  // The Request spy below is global, so a failing assertion must not leave it
  // installed for the next test.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers a scheduled event without constructing a Request", async () => {
    // Hono's adapter builds a global Request for every HTTP event it handles.
    // If the scheduled arm ever reached it, this spy would see the call.
    const requestSpy = vi.spyOn(globalThis, "Request");
    const { logger, lines } = silentLogger();

    const result = await createHandler({ logger })(scheduledEvent(), {
      awsRequestId: "1f0e3dad-9990-4f7a-b8ed-0f2eb1b0b0f5",
    });

    expect(requestSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ tasksResolved: 0, moreWorkPending: false });
    const sweepLine = lines
      .map((line) => JSON.parse(line))
      .find((line) => line.command === "sweep");
    expect(sweepLine).toMatchObject({
      invocation: "scheduled",
      requestId: "1f0e3dad-9990-4f7a-b8ed-0f2eb1b0b0f5",
    });
  });

  it("routes an HTTP event through Hono and answers with the error model", async () => {
    const { logger } = silentLogger();

    const response = (await createHandler({ logger })(
      functionUrlEvent({ method: "GET", path: "/nowhere" }),
      { awsRequestId: "b2a1c0de-0000-4000-8000-000000000001" },
    )) as { statusCode: number; body: string };

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toMatchObject({ code: "not_found" });
  });

  it("refuses an event that is neither kind rather than guessing", async () => {
    const { logger, lines } = silentLogger();

    await expect(createHandler({ logger })({ hello: "world" })).rejects.toThrow(
      "Unrecognized invocation event.",
    );
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ level: "error", errorClassification: "internal" }),
    );
  });
});
