import { describe, expect, it } from "vitest";
import { IDEMPOTENCY_HEADER } from "../src/index.ts";

describe("contract package", () => {
  it("resolves its own TypeScript sources", () => {
    expect(IDEMPOTENCY_HEADER).toBe("idempotency-key");
  });
});
