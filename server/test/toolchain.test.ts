import { describe, expect, it } from "vitest";
import { IDEMPOTENCY_HEADER } from "../src/index.ts";

describe("server package", () => {
  it("resolves the shared contract package across the workspace", () => {
    expect(IDEMPOTENCY_HEADER).toBe("idempotency-key");
  });
});
