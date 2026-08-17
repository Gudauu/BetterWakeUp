import { describe, expect, it } from "vitest";
import { LAMBDA_NODE_MAJOR, LAMBDA_RESERVED_CONCURRENCY } from "../src/index.js";

describe("infra package", () => {
  it("targets the Node runtime the toolchain names", () => {
    expect(LAMBDA_NODE_MAJOR).toBe(22);
  });

  it("caps concurrency, so the bill is bounded even where a counter is not", () => {
    // Zero would disable the function entirely rather than limit it, which is
    // the mistake this number is most likely to be given by accident.
    expect(LAMBDA_RESERVED_CONCURRENCY).toBeGreaterThan(0);
    expect(LAMBDA_RESERVED_CONCURRENCY).toBeLessThanOrEqual(50);
  });
});
