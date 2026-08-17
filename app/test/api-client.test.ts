import { ENDPOINT_NAMES, ENDPOINTS, type SessionView } from "@betterwakeup/contract";
import { type ApiClient, createApiClient } from "../src/api/client.ts";
import { ApiError } from "../src/api/errors.ts";
import { createMemorySessionStore } from "../src/session/session-store.ts";

const SESSION: SessionView = {
  accountId: "11111111-1111-4111-8111-111111111111",
  token: "session-token",
  expiresAt: "2026-01-01T00:00:00.000Z",
};

const CHALLENGE_ID = "22222222-2222-4222-8222-222222222222";

interface Call {
  url: string;
  init: RequestInit;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function harness(
  responder: (call: Call) => Response | Promise<Response>,
  options: { session?: SessionView | null } = {},
) {
  const calls: Call[] = [];
  const store = createMemorySessionStore(options.session === undefined ? SESSION : options.session);
  const client: ApiClient = createApiClient({
    baseUrl: "https://api.example.test/",
    sessionStore: store,
    fetch: (async (url: string, init: RequestInit) => {
      const call = { url, init };
      calls.push(call);
      return await responder(call);
    }) as unknown as typeof globalThis.fetch,
    newIdempotencyKey: () => "generated-key",
  });
  return { calls, client, store };
}

function headerOf(call: Call | undefined, name: string): string | undefined {
  if (call === undefined) {
    throw new Error("No request was made.");
  }
  return (call.init.headers as Record<string, string>)[name];
}

describe("the API client builds requests from the contract registry", () => {
  it("substitutes path parameters into the registry's own route", async () => {
    const { calls, client } = harness(() => jsonResponse(200, {}));

    // The response is asserted elsewhere; this test is about the request line.
    await client
      .request("pauseChallenge", { params: { challengeId: CHALLENGE_ID }, body: {} })
      .catch(() => undefined);

    expect(calls[0]?.url).toBe(`https://api.example.test/challenges/${CHALLENGE_ID}/pause`);
    expect(calls[0]?.init.method).toBe("POST");
  });

  it("sends the stored session as a bearer token on a session endpoint", async () => {
    const { calls, client } = harness(() => jsonResponse(200, { challenge: null }));

    await client.request("getCurrentChallenge", {});

    expect(headerOf(calls[0], "authorization")).toBe("Bearer session-token");
  });

  it("sends no authorization on the sign-in exchange", async () => {
    const { calls, client } = harness(
      () => jsonResponse(200, { session: SESSION, account: account() }),
      { session: null },
    );

    await client.request("createSession", { body: { provider: "apple", idToken: "id-token" } });

    expect(headerOf(calls[0], "authorization")).toBeUndefined();
  });

  it("refuses a session endpoint with no stored session without calling the server", async () => {
    const { calls, client } = harness(() => jsonResponse(200, {}), { session: null });

    await expect(client.request("getCurrentChallenge", {})).rejects.toMatchObject({
      code: "unauthenticated",
      status: null,
    });
    expect(calls).toHaveLength(0);
  });

  it("generates an idempotency key for a command that requires one", async () => {
    const { calls, client } = harness(() => jsonResponse(200, {}));

    await client.request("deleteAccount", {});

    expect(headerOf(calls[0], "idempotency-key")).toBe("generated-key");
  });

  it("uses the caller's idempotency key when it has one", async () => {
    const { calls, client } = harness(() => jsonResponse(200, {}));

    await client
      .request("createCompletion", {
        params: { taskId: CHALLENGE_ID },
        idempotencyKey: "record-id",
        body: completionBody(),
      })
      .catch(() => undefined);

    expect(headerOf(calls[0], "idempotency-key")).toBe("record-id");
  });

  it("sends no idempotency key on a read", async () => {
    const { calls, client } = harness(() => jsonResponse(200, { challenge: null }));

    await client.request("getCurrentChallenge", {});

    expect(headerOf(calls[0], "idempotency-key")).toBeUndefined();
  });
});

describe("the API client validates before it sends", () => {
  it("rejects a body the contract would reject, without a request", async () => {
    const { calls, client } = harness(() => jsonResponse(200, {}));

    await expect(
      client.request("createSession", {
        // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid input
        body: { provider: "apple", idToken: "" } as any,
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(calls).toHaveLength(0);
  });

  it("rejects a path parameter that is not a resource identifier", async () => {
    const { calls, client } = harness(() => jsonResponse(200, {}));

    await expect(
      client.request("resumeChallenge", { params: { challengeId: "not-a-uuid" } }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(calls).toHaveLength(0);
  });
});

describe("the API client turns every failure into one error type", () => {
  it("carries the server's code, message, and retry hint", async () => {
    const { client } = harness(() =>
      jsonResponse(429, { code: "rate_limited", message: "Slow down.", retryAfterSeconds: 12 }),
    );

    const error = await client.request("getCurrentChallenge", {}).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "rate_limited", status: 429, retryAfterSeconds: 12 });
  });

  it("takes the disposition from the contract rather than from the status", async () => {
    const { client } = harness(() =>
      jsonResponse(409, { code: "task_already_resolved", message: "Resolved." }),
    );

    const error: ApiError = await client.request("getCurrentChallenge", {}).catch((t) => t);

    expect(error.disposition).toBe("reject");
    expect(error.retryable).toBe(false);
  });

  it("treats a request that never reached the server as retryable", async () => {
    const { client } = harness(() => {
      throw new TypeError("Network request failed");
    });

    const error: ApiError = await client.request("getCurrentChallenge", {}).catch((t) => t);

    expect(error.code).toBe("internal_error");
    expect(error.status).toBeNull();
    expect(error.retryable).toBe(true);
  });

  it("treats an unreadable error body as an internal error", async () => {
    const { client } = harness(() => new Response("<html>gateway</html>", { status: 502 }));

    const error: ApiError = await client.request("getCurrentChallenge", {}).catch((t) => t);

    expect(error).toMatchObject({ code: "internal_error", status: 502 });
  });

  it("treats a success body the contract does not describe as an internal error", async () => {
    const { client } = harness(() => jsonResponse(200, { challenge: "not an object" }));

    const error: ApiError = await client.request("getCurrentChallenge", {}).catch((t) => t);

    expect(error).toMatchObject({ code: "internal_error", status: 200 });
  });

  it("reads an empty success body as the no-content response", async () => {
    const { client } = harness(() => new Response(null, { status: 204 }));

    await expect(client.request("deleteSession", {})).resolves.toEqual({});
  });
});

describe("the API client reacts to a session the server refuses", () => {
  it("clears stored session material on session_expired", async () => {
    const { client, store } = harness(() =>
      jsonResponse(401, { code: "session_expired", message: "Expired." }),
    );

    await expect(client.request("getCurrentChallenge", {})).rejects.toMatchObject({
      code: "session_expired",
    });
    await expect(store.read()).resolves.toBeNull();
  });

  it("keeps stored session material on an unrelated refusal", async () => {
    const { client, store } = harness(() =>
      jsonResponse(409, { code: "challenge_not_active", message: "Not active." }),
    );

    await expect(client.request("getCurrentChallenge", {})).rejects.toMatchObject({
      code: "challenge_not_active",
    });
    await expect(store.read()).resolves.not.toBeNull();
  });
});

describe("the registry and the client agree", () => {
  it("names every route parameter in the endpoint's params schema", () => {
    for (const name of ENDPOINT_NAMES) {
      const definition = ENDPOINTS[name];
      const inPath = [...definition.path.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1]);
      if (inPath.length === 0) {
        expect(definition.params).toBeNull();
        continue;
      }
      const shape = Object.keys(
        (definition.params as unknown as { shape: Record<string, unknown> }).shape,
      );
      expect(shape.sort()).toEqual(inPath.sort());
    }
  });
});

function account() {
  return {
    id: SESSION.accountId,
    displayName: null,
    email: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    emergencyRecoveryAvailable: true,
  };
}

function completionBody() {
  return {
    clientRecordId: "33333333-3333-4333-8333-333333333333",
    completedAt: "2026-03-01T07:00:00.000Z",
    observation: {
      startedAt: "2026-03-01T06:59:00.000Z",
      endedAt: "2026-03-01T07:00:00.000Z",
      steps: 200,
      provenance: "live-foreground" as const,
      source: "expo-pedometer-ios" as const,
    },
    appVersion: "0.1.0",
    verificationPolicyVersion: "1",
  };
}
