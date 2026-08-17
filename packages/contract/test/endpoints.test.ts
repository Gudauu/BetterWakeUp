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
