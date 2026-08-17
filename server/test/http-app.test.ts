/**
 * Issue 10's second acceptance boundary: no log line contains a token, raw
 * health data, or a payment credential.
 *
 * The app has no routes until issue 11, so these tests mount their own. That
 * is the honest way to exercise the middleware stack: routes registered later
 * inherit exactly what is registered here, and a test route proves what a real
 * one will do.
 */

import { IDEMPOTENCY_HEADER } from "@betterwakeup/contract";
import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors/app-error.ts";
import { createApp } from "../src/http/app.ts";
import { createLogger } from "../src/observability/logger.ts";

/** A believable session token: three base64url segments, like every JWT. */
const SESSION_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhY2NvdW50LTEifQ.dGhpcy1pcy1hLXNpZ25hdHVyZQ";
const PROVIDER_ID_TOKEN =
  "eyJraWQiOiJhcHBsZS1rZXkifQ.eyJpc3MiOiJodHRwczovL2FwcGxlaWQuYXBwbGUuY29tIn0.cHJvdmlkZXItc2ln";
const CARD_NUMBER = "4242424242424242";
const ACCOUNT_ID = "0d2f6a51-6e5f-4a1e-9a63-2a6b9f1c7e40";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ sink: (line) => lines.push(JSON.parse(line)) });
  return { logger, lines, text: () => JSON.stringify(lines) };
}

const SECRET_BODY = JSON.stringify({
  provider: "apple",
  idToken: PROVIDER_ID_TOKEN,
  paymentMethod: { number: CARD_NUMBER, cvc: "123" },
  movement: { steps: 812, samples: [{ at: "2026-08-17T06:31:00Z", steps: 41, heartRate: 74 }] },
});

describe("request logging", () => {
  it("writes one line per request with the fields Observability requires", async () => {
    const { logger, lines } = capture();
    const app = createApp({ logger });
    app.get("/challenges/:challengeId", (c) => c.json({ ok: true }));

    const response = await app.request("/challenges/abc", {
      headers: { [IDEMPOTENCY_HEADER]: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" },
    });

    expect(response.status).toBe(200);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "info",
      message: "request handled",
      invocation: "http",
      method: "GET",
      route: "/challenges/:challengeId",
      status: 200,
      idempotencyKey: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    });
    expect(typeof lines[0]?.requestId).toBe("string");
    expect(typeof lines[0]?.durationMs).toBe("number");
  });

  it("logs the route pattern rather than the URL, so no query string is kept", async () => {
    const { logger, lines, text } = capture();
    const app = createApp({ logger });
    app.get("/tasks/:taskId", (c) => c.json({ ok: true }));

    await app.request("/tasks/9?token=super-secret-query-value");

    expect(lines[0]?.route).toBe("/tasks/:taskId");
    expect(text()).not.toContain("super-secret-query-value");
  });

  it("keeps no session token, provider token, health data, or card number", async () => {
    const { logger, text } = capture();
    const app = createApp({ logger });
    app.post("/sessions", (c) => c.json({ ok: true }));

    await app.request("/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SESSION_TOKEN}`,
        cookie: `session=${SESSION_TOKEN}`,
        "content-type": "application/json",
      },
      body: SECRET_BODY,
    });

    const logged = text();
    for (const secret of [SESSION_TOKEN, PROVIDER_ID_TOKEN, CARD_NUMBER, "Bearer", "heartRate"]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("scrubs a token an unexpected failure quoted into its message", async () => {
    const { logger, lines, text } = capture();
    const app = createApp({ logger });
    app.get("/leaky", () => {
      throw new Error(`upstream rejected token ${SESSION_TOKEN} for card ${CARD_NUMBER}`);
    });

    const response = await app.request("/leaky");

    expect(response.status).toBe(500);
    const logged = text();
    expect(logged).not.toContain(SESSION_TOKEN);
    expect(logged).not.toContain(CARD_NUMBER);
    expect(logged).toContain("[redacted:jwt]");
    // The identifiers that make the line useful survive the scrubbing.
    expect(lines[0]).toMatchObject({
      errorClassification: "internal",
      errorCode: "internal_error",
    });
  });
});

describe("the error model", () => {
  it("answers an unmatched route with the contract's error shape", async () => {
    const { logger, lines } = capture();
    const app = createApp({ logger });

    const response = await app.request("/nowhere");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "not_found",
      message: "No route for GET /nowhere.",
    });
    expect(lines[0]).toMatchObject({ level: "warn", errorClassification: "not_found" });
  });

  it("uses the code's status, and carries details and Retry-After through", async () => {
    const { logger } = capture();
    const app = createApp({ logger });
    app.post("/limited", () => {
      throw new AppError("rate_limited", "Too many completions.", { retryAfterSeconds: 30 });
    });
    app.post("/invalid", () => {
      throw new AppError("validation_failed", "Bad request.", {
        details: [{ path: ["schedule", 0, "weekday"], message: "unknown weekday" }],
      });
    });

    const limited = await app.request("/limited", { method: "POST" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("30");

    const invalid = await app.request("/invalid", { method: "POST" });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({
      code: "validation_failed",
      message: "Bad request.",
      details: [{ path: ["schedule", 0, "weekday"], message: "unknown weekday" }],
    });
  });

  it("tells the client nothing about an unexpected failure but logs the cause", async () => {
    const { logger, lines, text } = capture();
    const app = createApp({ logger });
    app.get("/broken", () => {
      throw new Error(`connection to account ${ACCOUNT_ID} refused`);
    });

    const response = await app.request("/broken");

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: "internal_error",
      message: "An unexpected error occurred.",
    });
    expect(lines[0]?.level).toBe("error");
    // The account identifier is exactly what a UUID-shaped value is for, so
    // scrubbing must leave it alone.
    expect(text()).toContain(ACCOUNT_ID);
    expect(text()).toContain("connection to account");
  });

  it("still writes the request line when the request failed", async () => {
    const { logger, lines } = capture();
    const app = createApp({ logger });
    app.get("/broken", () => {
      throw new Error("nope");
    });

    await app.request("/broken");
    await app.request("/missing");

    const handled = lines.filter((line) => line.message === "request handled");
    expect(handled.map((line) => line.status)).toEqual([500, 404]);
  });

  it("logs a rejected request at warn and our own failures at error", async () => {
    const { logger, lines } = capture();
    const app = createApp({ logger });
    app.post("/conflict", () => {
      throw new AppError("active_challenge_exists", "One challenge at a time.");
    });

    await app.request("/conflict", { method: "POST" });

    expect(lines[0]).toMatchObject({
      level: "warn",
      status: 409,
      errorCode: "active_challenge_exists",
      errorClassification: "conflict",
    });
  });
});
