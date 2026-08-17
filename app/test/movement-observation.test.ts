import { readFileSync } from "node:fs";
import { join } from "node:path";
import { movementSourceFor, observeLiveForeground } from "../src/movement/observation.ts";

/** A module's code with its comments removed, so a claim is about the code. */
function readModule(relative: string): string {
  return readFileSync(join(__dirname, relative), "utf8")
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/\/\/.*$/gm, "");
}

const WINDOW = {
  startedAt: new Date("2026-03-01T06:00:00.000Z"),
  endedAt: new Date("2026-03-01T06:04:00.000Z"),
  steps: 1200,
  platform: "ios",
};

describe("source names the platform the reading came off", () => {
  it.each([
    ["ios", "expo-pedometer-ios"],
    ["android", "expo-pedometer-android"],
  ])("maps %s to %s", (platform, source) => {
    expect(movementSourceFor(platform)).toBe(source);
  });

  it.each(["web", "windows", "macos", ""])("refuses to name a source for %s", (platform) => {
    expect(() => movementSourceFor(platform)).toThrow(/no pedometer source/);
  });
});

describe("provenance is stated, never inferred and never defaulted", () => {
  it("labels a watched window live-foreground", () => {
    expect(observeLiveForeground(WINDOW).provenance).toBe("live-foreground");
  });

  it("ignores a provenance supplied by its caller", () => {
    // A caller that has learned to pass one gets nothing for it: the value is
    // a property of the channel, so there is no argument that can change it.
    const smuggled = { ...WINDOW, provenance: "historical-query" } as never;

    expect(observeLiveForeground(smuggled).provenance).toBe("live-foreground");
  });

  it("states its provenance once, as a literal, in the only module that names one", () => {
    const code = readModule("../src/movement/observation.ts");

    expect(code.match(/provenance/g)).toEqual(["provenance"]);
    expect(code).toContain('provenance: "live-foreground"');
    expect(code).not.toContain("historical-query");
  });

  it("is the only module in the app that names a provenance at all", () => {
    for (const module of ["../src/movement/capture.ts", "../src/movement/native-pedometer.ts"]) {
      expect(readModule(module)).not.toContain("provenance");
    }
  });

  it("emits the exact contract shape and nothing else", () => {
    expect(observeLiveForeground(WINDOW)).toEqual({
      startedAt: "2026-03-01T06:00:00.000Z",
      endedAt: "2026-03-01T06:04:00.000Z",
      steps: 1200,
      provenance: "live-foreground",
      source: "expo-pedometer-ios",
    });
  });
});

describe("a window the contract would reject fails here", () => {
  it("refuses a window that ends before it starts", () => {
    expect(() =>
      observeLiveForeground({ ...WINDOW, endedAt: new Date("2026-03-01T05:59:59.000Z") }),
    ).toThrow();
  });

  it("refuses a negative step count", () => {
    expect(() => observeLiveForeground({ ...WINDOW, steps: -1 })).toThrow();
  });

  it("refuses a fractional step count", () => {
    expect(() => observeLiveForeground({ ...WINDOW, steps: 12.5 })).toThrow();
  });

  it("accepts a zero-length window with no steps", () => {
    const observation = observeLiveForeground({ ...WINDOW, endedAt: WINDOW.startedAt, steps: 0 });

    expect(observation.startedAt).toBe(observation.endedAt);
    expect(observation.steps).toBe(0);
  });
});
