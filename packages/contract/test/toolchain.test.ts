import { describe, expect, it } from "vitest";
import { IDEMPOTENCY_HEADER } from "../src/index.js";

describe("contract package", () => {
  it("resolves its own TypeScript sources", () => {
    expect(IDEMPOTENCY_HEADER).toBe("idempotency-key");
  });
});
