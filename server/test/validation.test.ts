/**
 * Issue 11's acceptance boundary: an unknown field, a missing field, and a
 * wrong type each produce the documented error shape.
 *
 * The routes here are the real ones, mounted from the contract's endpoint
 * registry by `registerRoutes`. The handlers are stubs, because what is under
 * test is everything that happens before a handler runs and after it returns.
 * A handler that records what it was given is how the tests assert that no
 * unparsed value reaches the domain.
 */

import { IDEMPOTENCY_HEADER } from "@betterwakeup/contract";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.ts";
import type { HandlerInput } from "../src/http/routes.ts";
import { createLogger } from "../src/observability/logger.ts";
import { fakeSessionGate } from "./support/fake-session-gate.ts";

const KEY = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const CHALLENGE_ID = "0d2f6a51-6e5f-4a1e-9a63-2a6b9f1c7e40";

const CONFIGURATION = {
  requiredTaskCount: 5,
  schedule: [{ weekday: "monday", deadline: "07:30" }],
  stepTarget: 500,
  noRegretMinutes: 60,
  timeZone: "America/Los_Angeles",
  deposit: { amount: 0, currency: "USD" },
};

const PROJECTION = {
  firstTaskDate: "2026-08-17",
  projectedEndDate: "2026-09-14",
  firstTaskDeadline: "2026-08-17T14:30:00Z",
  withinMaximumDuration: true,
};

/** Silent logs: these tests are about responses, and issue 10 covers the lines. */
function silent() {
  return createLogger({ sink: () => {} });
}

/** An app with one route mounted, plus a place to see what the handler got. */
function harness() {
  const seen: HandlerInput<"createChallengeProjection">[] = [];
  const app = createApp({
    logger: silent(),
    sessionGate: fakeSessionGate(),
    handlers: {
      createChallengeProjection: (input) => {
        seen.push(input);
        return PROJECTION;
      },
      changeChallengeTimeZone: () => {
        throw new Error("not reached");
      },
    },
  });
  return { app, seen };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

describe("the validation boundary", () => {
  it("accepts a request that matches the contract and hands the handler a parsed value", async () => {
    const { app, seen } = harness();

    const response = await app.request(
      "/challenges/projections",
      post({ configuration: CONFIGURATION }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(PROJECTION);
    expect(seen[0]?.body).toEqual({ configuration: CONFIGURATION });
    expect(seen[0]?.params).toBeNull();
  });

  it("rejects an unknown field with the documented error shape", async () => {
    const { app, seen } = harness();

    const response = await app.request(
      "/challenges/projections",
      post({ configuration: CONFIGURATION, notes: "hello" }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "validation_failed",
      message: "The request body does not match the API contract.",
      details: [{ path: [], message: 'Unrecognized key: "notes"' }],
    });
    expect(seen).toHaveLength(0);
  });

  it("rejects an unknown field nested inside the request", async () => {
    const { app } = harness();

    const response = await app.request(
      "/challenges/projections",
      post({
        configuration: { ...CONFIGURATION, deposit: { amount: 0, currency: "USD", fee: 1 } },
      }),
    );

    const body = (await response.json()) as { details: { path: unknown[] }[] };
    expect(response.status).toBe(400);
    expect(body.details[0]?.path).toEqual(["configuration", "deposit"]);
  });

  it("rejects a missing field, naming where it should have been", async () => {
    const { app } = harness();
    const { stepTarget: _dropped, ...withoutStepTarget } = CONFIGURATION;

    const response = await app.request(
      "/challenges/projections",
      post({ configuration: withoutStepTarget }),
    );

    const body = (await response.json()) as {
      code: string;
      details: { path: unknown[]; message: string }[];
    };
    expect(response.status).toBe(400);
    expect(body.code).toBe("validation_failed");
    expect(body.details[0]?.path).toEqual(["configuration", "stepTarget"]);
  });

  it("rejects a field of the wrong type", async () => {
    const { app } = harness();

    const response = await app.request(
      "/challenges/projections",
      post({ configuration: { ...CONFIGURATION, stepTarget: "five hundred" } }),
    );

    const body = (await response.json()) as { details: { path: unknown[]; message: string }[] };
    expect(response.status).toBe(400);
    expect(body.details[0]?.path).toEqual(["configuration", "stepTarget"]);
    expect(body.details[0]?.message).toMatch(/expected number/i);
  });

  it("reports every failed field rather than only the first", async () => {
    const { app } = harness();

    const response = await app.request(
      "/challenges/projections",
      post({
        configuration: { ...CONFIGURATION, stepTarget: "many", timeZone: "Mars/Olympus_Mons" },
      }),
    );

    const body = (await response.json()) as { details: { path: unknown[] }[] };
    expect(body.details.map((detail) => detail.path)).toEqual([
      ["configuration", "stepTarget"],
      ["configuration", "timeZone"],
    ]);
  });

  it("rejects a body that is not JSON at all", async () => {
    const { app } = harness();

    const response = await app.request("/challenges/projections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "validation_failed",
      message: "The request body is not valid JSON.",
      details: [{ path: [], message: "expected a JSON document" }],
    });
  });

  it("rejects a JSON body sent without a JSON content type", async () => {
    const { app } = harness();

    const response = await app.request("/challenges/projections", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ configuration: CONFIGURATION }),
    });

    const body = (await response.json()) as { details: { path: unknown[] }[] };
    expect(response.status).toBe(400);
    expect(body.details[0]?.path).toEqual(["headers", "content-type"]);
  });
});

describe("path parameters", () => {
  it("rejects a parameter that is not the shape the contract names", async () => {
    const { app } = harness();

    const response = await app.request(
      "/challenges/not-a-uuid/time-zone",
      post({ timeZone: "Europe/Berlin" }, { [IDEMPOTENCY_HEADER]: KEY }),
    );

    const body = (await response.json()) as {
      code: string;
      message: string;
      details: { path: unknown[] }[];
    };
    expect(response.status).toBe(400);
    expect(body.code).toBe("validation_failed");
    expect(body.message).toBe("The path does not match the API contract.");
    expect(body.details[0]?.path).toEqual(["challengeId"]);
  });
});

describe("the idempotency key", () => {
  it("is required on a command the contract marks idempotent", async () => {
    const { app } = harness();

    const response = await app.request(
      `/challenges/${CHALLENGE_ID}/time-zone`,
      post({ timeZone: "Europe/Berlin" }),
    );

    const body = (await response.json()) as {
      message: string;
      details: { path: unknown[]; message: string }[];
    };
    expect(response.status).toBe(400);
    expect(body.message).toBe("The request headers do not match the API contract.");
    expect(body.details[0]).toEqual({
      path: ["headers", IDEMPOTENCY_HEADER],
      message: "this command requires an idempotency key",
    });
  });

  it("is rejected when it is not the client-generated UUID the contract requires", async () => {
    const { app } = harness();

    const response = await app.request(
      `/challenges/${CHALLENGE_ID}/time-zone`,
      post({ timeZone: "Europe/Berlin" }, { [IDEMPOTENCY_HEADER]: "key-1" }),
    );

    const body = (await response.json()) as { details: { path: unknown[] }[] };
    expect(response.status).toBe(400);
    expect(body.details[0]?.path).toEqual(["headers", IDEMPOTENCY_HEADER]);
  });

  it("is absent from the handler's input on an endpoint that does not take one", async () => {
    const { app, seen } = harness();

    await app.request(
      "/challenges/projections",
      post({ configuration: CONFIGURATION }, { [IDEMPOTENCY_HEADER]: KEY }),
    );

    expect(seen[0]?.idempotencyKey).toBeUndefined();
  });
});

describe("a route that takes no body", () => {
  it("rejects one that was sent anyway", async () => {
    const app = createApp({
      logger: silent(),
      sessionGate: fakeSessionGate(),
      handlers: { deleteSession: () => ({}) },
    });

    const response = await app.request("/sessions", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ everywhere: true }),
    });

    const body = (await response.json()) as { code: string; details: { message: string }[] };
    expect(response.status).toBe(400);
    expect(body.code).toBe("validation_failed");
    expect(body.details[0]?.message).toBe("this endpoint accepts no request body");
  });

  it("accepts one sent with no body at all", async () => {
    const app = createApp({
      logger: silent(),
      sessionGate: fakeSessionGate(),
      handlers: { deleteSession: () => ({}) },
    });

    const response = await app.request("/sessions", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
  });
});

describe("responses", () => {
  it("are parsed on the way out, so a response the app cannot parse is our error", async () => {
    const app = createApp({
      logger: silent(),
      sessionGate: fakeSessionGate(),
      handlers: {
        // A handler that forgot the schema requires a first task deadline.
        createChallengeProjection: () =>
          ({ firstTaskDate: "2026-08-17", projectedEndDate: "2026-09-14" }) as never,
      },
    });

    const response = await app.request(
      "/challenges/projections",
      post({ configuration: CONFIGURATION }),
    );

    expect(response.status).toBe(500);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("internal_error");
    // The reason stays in the log; the client is told nothing about it.
    expect(body.message).toBe("An unexpected error occurred.");
  });
});

describe("the mounted surface", () => {
  it("mounts only the endpoints given a handler, and answers not_found for the rest", async () => {
    const { app } = harness();

    const response = await app.request("/challenges/current");

    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("not_found");
  });
});
