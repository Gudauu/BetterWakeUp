import { describe, expect, it } from "vitest";
import {
  CONTEXT_KEYS,
  NEON_AWS_REGIONS,
  readStackConfiguration,
  type StackConfiguration,
} from "../src/config.ts";

const defaults = { codeAssetPath: "/tmp/bundle" };

function read(context: Record<string, unknown>): StackConfiguration {
  return readStackConfiguration({ tryGetContext: (key) => context[key] }, defaults);
}

describe("stack configuration", () => {
  it("reads the stage, region, account, and code path from context", () => {
    expect(
      read({
        [CONTEXT_KEYS.stage]: "prod",
        [CONTEXT_KEYS.region]: "eu-west-2",
        [CONTEXT_KEYS.account]: "123456789012",
        [CONTEXT_KEYS.codeAssetPath]: "/build/server",
      }),
    ).toEqual({
      stage: "prod",
      region: "eu-west-2",
      account: "123456789012",
      codeAssetPath: "/build/server",
    });
  });

  it("falls back to the checked-in placeholder bundle and no pinned account", () => {
    const configuration = read({
      [CONTEXT_KEYS.stage]: "dev",
      [CONTEXT_KEYS.region]: "us-east-1",
    });
    expect(configuration.codeAssetPath).toBe(defaults.codeAssetPath);
    expect(configuration.account).toBeUndefined();
  });

  it("refuses a region Neon does not run in", () => {
    // The architecture requires the Lambda and the database to share a region,
    // and Neon offers the shorter list. A wrong value here is a cross-region
    // round trip on every query, which nothing else in the system would catch.
    expect(() =>
      read({ [CONTEXT_KEYS.stage]: "dev", [CONTEXT_KEYS.region]: "ca-central-1" }),
    ).toThrow(/Neon runs in/);
  });

  it("refuses a missing region rather than guessing one", () => {
    expect(() => read({ [CONTEXT_KEYS.stage]: "dev" })).toThrow(/bwu:region/);
  });

  it("refuses a missing or unknown stage", () => {
    expect(() => read({ [CONTEXT_KEYS.region]: "us-east-1" })).toThrow(/bwu:stage/);
    expect(() =>
      read({ [CONTEXT_KEYS.stage]: "staging", [CONTEXT_KEYS.region]: "us-east-1" }),
    ).toThrow(/bwu:stage/);
  });

  it("refuses a context value of the wrong type", () => {
    expect(() => read({ [CONTEXT_KEYS.stage]: 7, [CONTEXT_KEYS.region]: "us-east-1" })).toThrow(
      /non-empty string/,
    );
  });

  it("accepts every region it lists", () => {
    for (const region of NEON_AWS_REGIONS) {
      expect(read({ [CONTEXT_KEYS.stage]: "dev", [CONTEXT_KEYS.region]: region }).region).toBe(
        region,
      );
    }
  });
});
