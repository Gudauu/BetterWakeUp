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
  options: { session?: SessionView | null; timeoutMs?: number } = {},
) {
  const calls: Call[] = [];
  const store = createMemorySessionStore(options.session === undefined ? SESSION : options.session);
  const invalidated: true[] = [];
  const client: ApiClient = createApiClient({
    baseUrl: "https://api.example.test/",
    sessionStore: store,
    onSessionInvalid: () => invalidated.push(true),
    fetch: (async (url: string, init: RequestInit) => {
      const call = { url, init };
      calls.push(call);
      return await responder(call);
    }) as unknown as typeof globalThis.fetch,
    newIdempotencyKey: () => "generated-key",
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return { calls, client, store, invalidated };
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
    const { calls, client } = harness(() =>
      jsonResponse(200, { challenge: null, lastEnded: null }),
    );

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
    const { calls, client } = harness(() =>
      jsonResponse(200, { challenge: null, lastEnded: null }),
    );

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
    const { client } = harness(() =>
      jsonResponse(200, { challenge: "not an object", lastEnded: null }),
    );

    const error: ApiError = await client.request("getCurrentChallenge", {}).catch((t) => t);

    expect(error).toMatchObject({ code: "internal_error", status: 200 });
  });

  it("reads an empty success body as the no-content response", async () => {
    const { client } = harness(() => new Response(null, { status: 204 }));

    await expect(client.request("deleteSession", {})).resolves.toEqual({});
  });
});

describe("the API client stops waiting for a request that never comes back", () => {
  it("gives up after its own deadline and says nobody knows whether it landed", async () => {
    const { client } = harness((call) => neverAnswers(call), { timeoutMs: 5 });

    const error: ApiError = await client.request("getCurrentChallenge", {}).catch((t) => t);

    expect(error.code).toBe("internal_error");
    expect(error.status).toBeNull();
    expect(error.timedOut).toBe(true);
    // The one failure where the device cannot say whether the server heard it.
    expect(error.reachedServer).toBeNull();
    expect(error.retryable).toBe(true);
  });

  it("distinguishes a send that failed, which proves the command never ran", async () => {
    const { client } = harness(() => {
      throw new TypeError("Network request failed");
    });

    const error: ApiError = await client.request("getCurrentChallenge", {}).catch((t) => t);

    expect(error.timedOut).toBe(false);
    expect(error.reachedServer).toBe(false);
  });

  it("passes its deadline to fetch so the socket is closed rather than left open", async () => {
    const aborted: boolean[] = [];
    const { client } = harness(
      (call) => {
        call.init.signal?.addEventListener("abort", () => aborted.push(true));
        return neverAnswers(call);
      },
      { timeoutMs: 5 },
    );

    await client.request("getCurrentChallenge", {}).catch(() => undefined);

    expect(aborted).toEqual([true]);
  });

  it("still ends a request the caller itself abandoned, and calls that no answer at all", async () => {
    const caller = new AbortController();
    const { client } = harness((call) => neverAnswers(call), { timeoutMs: 60_000 });

    const pending = client.request("getCurrentChallenge", { signal: caller.signal });
    caller.abort();
    const error: ApiError = await pending.catch((t) => t);

    // A screen that went away is not a slow server, so this is the ordinary
    // "did not reach" answer rather than a timeout.
    expect(error.timedOut).toBe(false);
  });

  it("reports a body that stops mid-read as an answer the server did give", async () => {
    const { client } = harness(
      () =>
        ({
          status: 200,
          ok: true,
          text: () => Promise.reject(new TypeError("Network request failed")),
        }) as unknown as Response,
    );

    const error: ApiError = await client.request("getCurrentChallenge", {}).catch((t) => t);

    expect(error.code).toBe("internal_error");
    expect(error.status).toBe(200);
    expect(error.reachedServer).toBe(true);
  });
});

/** A server that accepts the connection and then says nothing at all. */
function neverAnswers(call: Call): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const give = () => reject(new DOMException("Aborted", "AbortError"));
    // `fetch` rejects at once for a signal that was already aborted when it was
    // handed over, which is the case when the caller gave up first.
    if (call.init.signal?.aborted === true) {
      give();
      return;
    }
    call.init.signal?.addEventListener("abort", give);
  });
}

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

  it("tells the caller so, which is what moves the app to signed out", async () => {
    const { client, invalidated } = harness(() =>
      jsonResponse(401, { code: "unauthenticated", message: "No." }),
    );

    await expect(client.request("deleteSession", {})).rejects.toMatchObject({
      code: "unauthenticated",
    });
    expect(invalidated).toHaveLength(1);
  });

  it("keeps the stored session when it was sign-in that was refused", async () => {
    // `POST /sessions` answers `unauthenticated` for a provider token it could
    // not verify. That says nothing about whatever is in secure storage, and
    // discarding it would sign the user out for somebody else's failed tap.
    const { client, store, invalidated } = harness(() =>
      jsonResponse(401, { code: "unauthenticated", message: "Bad provider token." }),
    );

    await expect(
      client.request("createSession", { body: { provider: "apple", idToken: "nope" } }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(store.read()).resolves.not.toBeNull();
    expect(invalidated).toHaveLength(0);
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
