import { IDEMPOTENCY_HEADER } from "@betterwakeup/contract";
import { describe, expect, it } from "vitest";

describe("server package", () => {
  it("resolves the shared contract package across the workspace", () => {
    expect(IDEMPOTENCY_HEADER).toBe("idempotency-key");
  });
});
