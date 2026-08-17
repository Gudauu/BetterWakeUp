/**
 * Issue 15 without a database: what is limited, when the counter is spent, and
 * what a misconfigured mount does.
 *
 * The counting itself is a property of one SQL statement and is tested against
 * a real PostgreSQL in `test/integration/rate-limit.test.ts`, including the
 * acceptance boundary of two concurrent callers.
 */

import { ENDPOINT_NAMES, ENDPOINTS, type EndpointName } from "@betterwakeup/contract";
import { describe, expect, it } from "vitest";

import { AppError } from "../src/errors/app-error.ts";
import { createApp } from "../src/http/app.ts";
import { clientAddressFromEvent, UNKNOWN_CLIENT } from "../src/http/client-address.ts";
import { createLogger } from "../src/observability/logger.ts";
import { RATE_LIMITS } from "../src/rate-limit/policy.ts";
import { fakeRateLimiter } from "./support/fake-rate-limiter.ts";
import { fakeSessionGate, TEST_ACCOUNT_ID } from "./support/fake-session-gate.ts";

function silent() {
  return createLogger({ sink: () => {} });
}

/**
 * The endpoints the architecture names: "rate-limit session, completion,
 * pause, and payment endpoints". Read off the registry's own paths rather than
 * listed by hand, so an endpoint added on one of those paths is covered by
 * this test the day it appears.
 */
function namedByTheArchitecture(): EndpointName[] {
  return ENDPOINT_NAMES.filter((name) => {
    const path = ENDPOINTS[name].path;
    if (path.startsWith("/payments/webhooks")) return false;
    return (
      path.startsWith("/sessions") ||
      path.endsWith("/completions") ||
      path.endsWith("/pause") ||
      path.endsWith("/funding-intents") ||
      path.endsWith("/payment-method")
    );
  });
}

describe("which endpoints are limited", () => {
  it("covers every session, completion, pause, and payment path", () => {
    const named = namedByTheArchitecture();
    // If the filter ever matches nothing, the assertion below passes for the
    // wrong reason, so the set it found is pinned too.
    expect(named).toEqual([
      "createSession",
      "deleteSession",
      "createFundingIntent",
      "replacePaymentMethod",
      "pauseChallenge",
      "resumeChallenge",
      "createCompletion",
    ]);
    for (const name of named) {
      expect(RATE_LIMITS[name], `${name} declares no rate limit`).not.toBeNull();
    }
  });

  it("leaves the provider's webhook unlimited, since dropping its retries loses events", () => {
    expect(RATE_LIMITS.receivePaymentWebhook).toBeNull();
  });

  it("gives pause and resume one shared allowance, so alternating buys nothing", () => {
    expect(RATE_LIMITS.pauseChallenge?.bucket).toBe(RATE_LIMITS.resumeChallenge?.bucket);
  });

  it("counts sign-in by client, since there is no account to count yet", () => {
    expect(RATE_LIMITS.createSession?.scope).toBe("client");
  });

  it("scopes every other limit to an account, which only a session endpoint has", () => {
    for (const name of ENDPOINT_NAMES) {
      const policy = RATE_LIMITS[name];
      if (policy?.scope !== "account") continue;
      expect(ENDPOINTS[name].auth, `${name} counts an account it cannot identify`).toBe("session");
    }
  });

  it("states a positive allowance and window for every limit it declares", () => {
    for (const name of ENDPOINT_NAMES) {
      const policy = RATE_LIMITS[name];
      if (policy === null) continue;
      expect(policy.limit).toBeGreaterThan(0);
      expect(policy.windowSeconds).toBeGreaterThan(0);
    }
  });
});

describe("mounting a limited endpoint", () => {
  it("refuses to mount one with no limiter, rather than serving it unlimited", () => {
    expect(() =>
      createApp({
        logger: silent(),
        sessionGate: fakeSessionGate(),
        handlers: { deleteSession: () => ({}) },
      }),
    ).toThrow(/declares a rate limit and no rate limiter was given/);
  });

  it("mounts an unlimited endpoint with no limiter at all", () => {
    expect(() =>
      createApp({
        logger: silent(),
        sessionGate: fakeSessionGate(),
        handlers: { getCurrentChallenge: () => ({ challenge: null }) },
      }),
    ).not.toThrow();
  });
});

describe("who is counted", () => {
  it("spends the account's allowance on a session endpoint", async () => {
    const limiter = fakeRateLimiter();
    const app = createApp({
      logger: silent(),
      sessionGate: fakeSessionGate(),
      rateLimiter: limiter,
      handlers: { deleteSession: () => ({}) },
    });

    await app.request("/sessions", {
      method: "DELETE",
      headers: { authorization: "Bearer anything" },
    });

    expect(limiter.consumed).toEqual([
      { policy: RATE_LIMITS.deleteSession, subject: TEST_ACCOUNT_ID },
    ]);
  });

  it("spends the source address's allowance on sign-in", async () => {
    const limiter = fakeRateLimiter();
    const app = createApp({
      logger: silent(),
      rateLimiter: limiter,
      clientAddress: () => "203.0.113.7",
      handlers: {
        createSession: () => {
          throw new AppError("unauthenticated", "not reached");
        },
      },
    });

    await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "apple", idToken: "x" }),
    });

    expect(limiter.consumed).toEqual([
      { policy: RATE_LIMITS.createSession, subject: "203.0.113.7" },
    ]);
  });
});

describe("the order the limit runs in", () => {
  /** A limiter that refuses everyone, so nothing past it can run. */
  function refusing() {
    return {
      consumed: [],
      consume: async () => {
        throw new AppError("rate_limited", "Too many requests. Try again shortly.", {
          retryAfterSeconds: 42,
        });
      },
    };
  }

  it("counts a sign-in before the body is parsed, so a flood costs one statement", async () => {
    const app = createApp({
      logger: silent(),
      rateLimiter: refusing(),
      handlers: {
        createSession: () => {
          throw new Error("not reached");
        },
      },
    });

    // A body that would fail validation. The limit answers first, which is the
    // point: a refused caller must not be able to make the server parse.
    const response = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonsense: true }),
    });

    expect(response.status).toBe(429);
    expect((await response.json()) as { code: string }).toMatchObject({ code: "rate_limited" });
    expect(response.headers.get("Retry-After")).toBe("42");
  });

  it("authenticates before spending an account's allowance", async () => {
    const limiter = refusing();
    const app = createApp({
      logger: silent(),
      rateLimiter: limiter,
      sessionGate: {
        authenticate: async () => {
          throw new AppError("unauthenticated", "This endpoint requires a session token.");
        },
        assertOwnership: async () => {},
      },
      handlers: { deleteSession: () => ({}) },
    });

    const response = await app.request("/sessions", { method: "DELETE" });

    // 401 rather than 429: an anonymous caller cannot spend somebody's
    // account allowance, because it has not been shown to be anybody.
    expect(response.status).toBe(401);
  });
});

describe("the source address", () => {
  it("is the one AWS wrote into the envelope", () => {
    const c = { env: { event: { requestContext: { http: { sourceIp: "198.51.100.4" } } } } };
    expect(clientAddressFromEvent(c as never)).toBe("198.51.100.4");
  });

  it("ignores a forwarding header, which a Function URL caller sets itself", () => {
    const c = {
      env: {
        event: {
          headers: { "x-forwarded-for": "1.2.3.4" },
          requestContext: { http: { sourceIp: "198.51.100.4" } },
        },
      },
    };
    expect(clientAddressFromEvent(c as never)).toBe("198.51.100.4");
  });

  it("falls back to one shared subject rather than to no limit at all", () => {
    expect(clientAddressFromEvent({ env: {} } as never)).toBe(UNKNOWN_CLIENT);
    expect(clientAddressFromEvent({ env: { event: { requestContext: {} } } } as never)).toBe(
      UNKNOWN_CLIENT,
    );
  });
});
