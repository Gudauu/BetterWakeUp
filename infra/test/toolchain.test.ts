import { describe, expect, it } from "vitest";
import { LAMBDA_NODE_MAJOR } from "../src/index.js";

describe("infra package", () => {
  it("targets the Node runtime the toolchain names", () => {
    expect(LAMBDA_NODE_MAJOR).toBe(22);
  });
});
