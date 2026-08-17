/**
 * The parts of issue 14 that need no database: what the router refuses to
 * mount, what order the gate runs in, and whether the ownership rules cover
 * everything the contract addresses.
 *
 * The gate's own behaviour against real rows is in
 * `test/integration/session-gate.test.ts`, including issue 14's acceptance
 * boundary.
 */

import { ENDPOINT_NAMES, ENDPOINTS, IDEMPOTENCY_HEADER } from "@betterwakeup/contract";
import { describe, expect, it } from "vitest";
import { createSessionGate, OWNERSHIP_CHECKS } from "../src/auth/session-gate.ts";
import { AppError } from "../src/errors/app-error.ts";
import { createApp } from "../src/http/app.ts";
import { createLogger } from "../src/observability/logger.ts";
import { fakeRateLimiter } from "./support/fake-rate-limiter.ts";
import { fakeSessionGate, TEST_ACCOUNT_ID } from "./support/fake-session-gate.ts";

const TASK_ID = "5e0f1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const KEY = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function silent() {
  return createLogger({ sink: () => {} });
}

describe("mounting a protected endpoint", () => {
  it("refuses to mount a session endpoint with no gate, rather than serving it to anyone", () => {
    expect(() =>
      createApp({
        logger: silent(),
        handlers: { getCurrentChallenge: () => ({ challenge: null }) },
      }),
    ).toThrow(/requires a session and no session gate/);
  });

  it("refuses to mount the signature endpoint until something can check a signature", () => {
    expect(() =>
      createApp({
        logger: silent(),
        sessionGate: fakeSessionGate(),
        handlers: { receivePaymentWebhook: () => ({ duplicate: false }) },
      }),
    ).toThrow(/requires a signature verifier/);
  });

  it("mounts the endpoints the contract marks as needing no credential", () => {
    expect(() =>
      createApp({
        logger: silent(),
        rateLimiter: fakeRateLimiter(),
        handlers: {
          createSession: () => {
            throw new Error("not reached");
          },
        },
      }),
    ).not.toThrow();
  });
});

describe("the order the gate runs in", () => {
  /** An app whose gate refuses everyone, so nothing past it can run. */
  function refusing() {
    return createApp({
      logger: silent(),
      rateLimiter: fakeRateLimiter(),
      sessionGate: {
        authenticate: async () => {
          throw new AppError("unauthenticated", "This endpoint requires a session token.");
        },
        assertOwnership: async () => {
          throw new Error("not reached");
        },
      },
      handlers: {
        createCompletion: () => {
          throw new Error("not reached");
        },
      },
    });
  }

  it("answers a missing credential before it says anything about the body", async () => {
    const response = await refusing().request(`/tasks/${TASK_ID}/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", [IDEMPOTENCY_HEADER]: KEY },
      body: JSON.stringify({ nonsense: true }),
    });

    expect(response.status).toBe(401);
    // Not 400. A caller with no session learns nothing about which fields the
    // command takes, which is the whole reason authentication runs first.
    expect(((await response.json()) as { code: string }).code).toBe("unauthenticated");
  });

  it("answers a missing credential before it complains about a missing idempotency key", async () => {
    const response = await refusing().request(`/tasks/${TASK_ID}/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(401);
  });
});

describe("what a handler is given", () => {
  it("receives the authenticated caller, already checked for ownership", async () => {
    let seen: { accountId: string } | null = null;
    const app = createApp({
      logger: silent(),
      sessionGate: fakeSessionGate(),
      handlers: {
        getCurrentChallenge: ({ session }) => {
          seen = session;
          return { challenge: null };
        },
      },
    });

    const response = await app.request("/challenges/current", {
      headers: { authorization: "Bearer anything" },
    });

    expect(response.status).toBe(200);
    expect(seen).toEqual({
      sessionId: "3a5b2d1c-9e4f-4a7b-8c6d-2f1e0a9b8c7d",
      accountId: TEST_ACCOUNT_ID,
    });
  });

  it("names the account on the request log line once the caller is known", async () => {
    const lines: string[] = [];
    const app = createApp({
      logger: createLogger({ sink: (line) => lines.push(line) }),
      sessionGate: fakeSessionGate(),
      handlers: { getCurrentChallenge: () => ({ challenge: null }) },
    });

    await app.request("/challenges/current", { headers: { authorization: "Bearer anything" } });

    const request = lines.map((line) => JSON.parse(line) as Record<string, unknown>).at(-1);
    expect(request?.message).toBe("request handled");
    expect(request?.accountId).toBe(TEST_ACCOUNT_ID);
  });
});

describe("the ownership rules", () => {
  it("covers every path parameter of every endpoint that carries a session", () => {
    const uncovered: string[] = [];
    for (const name of ENDPOINT_NAMES) {
      const endpoint = ENDPOINTS[name];
      if (endpoint.auth !== "session" || endpoint.params === null) continue;
      const parsed = endpoint.params.safeParse({});
      // Every missing required key is a parameter this endpoint addresses.
      for (const issue of parsed.success ? [] : parsed.error.issues) {
        const parameter = String(issue.path[0]);
        if (!(parameter in OWNERSHIP_CHECKS)) uncovered.push(`${name}.${parameter}`);
      }
    }

    expect(uncovered).toEqual([]);
  });

  it("refuses a path parameter no rule covers rather than waving it through", async () => {
    // A database that would throw if it were touched: the refusal happens
    // before any query, which is the point.
    const gate = createSessionGate({
      db: {
        select: () => {
          throw new Error("not reached");
        },
      } as never,
      sessionSecret: "0".repeat(32),
    });

    await expect(
      gate.assertOwnership(
        { sessionId: "s", accountId: TEST_ACCOUNT_ID },
        { organizationId: TASK_ID },
      ),
    ).rejects.toMatchObject({ code: "internal_error" });
  });
});
