import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENDPOINTS } from "../src/index.ts";
import { GENERATED_SCHEMA_PATH, renderContractJsonSchema } from "../src/json-schema.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const endpoints = Object.values(ENDPOINTS);

describe("endpoint registry", () => {
  it("covers every operation the architecture names, and no others", () => {
    const routes = endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).sort();
    expect(routes).toEqual(
      [
        "POST /sessions",
        "DELETE /sessions",
        "DELETE /accounts",
        "POST /challenges/projections",
        "POST /challenges",
        "POST /challenges/funding-intents",
        "POST /challenges/:challengeId/payment-method",
        "GET /challenges/current",
        "POST /challenges/:challengeId/time-zone",
        "POST /challenges/:challengeId/pause",
        "DELETE /challenges/:challengeId/pause",
        "POST /challenges/:challengeId/recovery",
        "POST /challenges/:challengeId/abandonment",
        "DELETE /challenges/:challengeId",
        "POST /tasks/:taskId/completions",
        "POST /payments/webhooks/:provider",
      ].sort(),
    );
  });

  it("exposes no route for the overdue sweep, which is scheduled only", () => {
    expect(endpoints.some((endpoint) => endpoint.path.includes("sweep"))).toBe(false);
  });

  it("has no draft challenge resource", () => {
    expect(endpoints.some((endpoint) => endpoint.path.includes("draft"))).toBe(false);
  });

  it("requires an idempotency key on every state-changing client command", () => {
    const commands = endpoints.filter(
      (endpoint) => endpoint.method !== "GET" && endpoint.auth === "session",
    );
    const withoutKey = commands
      .filter((endpoint) => !endpoint.idempotent)
      .map((endpoint) => `${endpoint.method} ${endpoint.path}`);

    // Sign-out revokes one session token, and the projection persists nothing.
    expect(withoutKey).toEqual(["DELETE /sessions", "POST /challenges/projections"]);
  });

  it("leaves sign-in and the payment webhook outside the session requirement", () => {
    const unauthenticated = endpoints
      .filter((endpoint) => endpoint.auth !== "session")
      .map((endpoint) => `${endpoint.auth} ${endpoint.path}`)
      .sort();
    expect(unauthenticated).toEqual(["none /sessions", "signature /payments/webhooks/:provider"]);
  });

  it("ends a challenge with a body-less command and answers with how it ended", () => {
    const { abandonChallenge } = ENDPOINTS;
    expect(abandonChallenge.request.safeParse({}).success).toBe(true);
    expect(abandonChallenge.request.safeParse({ reason: "bored" }).success).toBe(false);
    expect(
      abandonChallenge.response.safeParse({
        ended: {
          id: "5f0e1a8e-8f4b-4c9a-9d6b-2f1c3e4d5a6b",
          status: "abandoned",
          endedAt: "2026-01-06T16:00:00.000Z",
          requiredTaskCount: 30,
          completedTaskCount: 4,
          deposit: { amount: 2000, currency: "USD" },
          depositOutcome: "charged",
        },
      }).success,
    ).toBe(true);
  });

  it("deletes a challenge with no body and no answer beyond success", () => {
    const { deleteChallenge } = ENDPOINTS;
    expect(deleteChallenge.request).toBeNull();
    expect(deleteChallenge.response.safeParse({}).success).toBe(true);
  });

  it("gives every endpoint a response schema", () => {
    for (const endpoint of endpoints) {
      expect(endpoint.response).toBeDefined();
    }
  });
});

describe("generated JSON Schema", () => {
  it("matches the checked-in artifact", async () => {
    const checkedIn = await readFile(resolve(packageRoot, GENERATED_SCHEMA_PATH), "utf8");
    expect(checkedIn).toBe(renderContractJsonSchema());
  });

  it("describes each endpoint in the registry", () => {
    const document = JSON.parse(renderContractJsonSchema()) as {
      endpoints: Record<string, unknown>;
    };
    expect(Object.keys(document.endpoints).sort()).toEqual(Object.keys(ENDPOINTS).sort());
  });
});
