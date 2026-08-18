/**
 * What a build was told about itself.
 *
 * The Google client IDs are the part worth a test: absent and blank have to be
 * the same answer, because an EAS profile that declares a variable it has no
 * value for would otherwise configure the SDK with an empty audience and fail
 * on the tap instead of hiding the button.
 */

import { loadAppConfig } from "../src/config.ts";

const VARIABLES = [
  "EXPO_PUBLIC_API_BASE_URL",
  "EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID",
  "EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID",
  "EXPO_PUBLIC_SENTRY_DSN",
  "EXPO_PUBLIC_SIMULATE_MOVEMENT",
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of VARIABLES) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  // Jest has no application manifest, so the base URL comes from the
  // environment the way an EAS build supplies it.
  process.env.EXPO_PUBLIC_API_BASE_URL = "https://api.example.test";
});

afterEach(() => {
  for (const name of VARIABLES) {
    const value = saved.get(name);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe("the Google client IDs", () => {
  it("are absent in a build that was given none", () => {
    expect(loadAppConfig().google).toEqual({ webClientId: undefined, iosClientId: undefined });
  });

  it("are read from the build's environment", () => {
    process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = "web-client-id";
    process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID = "ios-client-id";

    expect(loadAppConfig().google).toEqual({
      webClientId: "web-client-id",
      iosClientId: "ios-client-id",
    });
  });

  it("treat a declared but empty variable as none at all", () => {
    process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = "";

    expect(loadAppConfig().google.webClientId).toBeUndefined();
  });
});

describe("the Sentry DSN", () => {
  it("is absent in a build with no Sentry project, which turns reporting off", () => {
    expect(loadAppConfig().sentryDsn).toBeUndefined();
  });

  it("is read from the build's environment", () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@o0.ingest.example.test/1";

    expect(loadAppConfig().sentryDsn).toBe("https://key@o0.ingest.example.test/1");
  });
});

describe("movement simulation", () => {
  it("is off in a build that said nothing about it, which is every store build", () => {
    expect(loadAppConfig().simulateMovement).toBe(false);
  });

  it("is on for the two spellings a build profile can turn it on with", () => {
    process.env.EXPO_PUBLIC_SIMULATE_MOVEMENT = "true";
    expect(loadAppConfig().simulateMovement).toBe(true);

    process.env.EXPO_PUBLIC_SIMULATE_MOVEMENT = "1";
    expect(loadAppConfig().simulateMovement).toBe(true);
  });

  it("stays off for a variable that spells out being off", () => {
    // The trap this exists for: an environment variable is a string, so a
    // truthiness check would read "false" as on.
    process.env.EXPO_PUBLIC_SIMULATE_MOVEMENT = "false";
    expect(loadAppConfig().simulateMovement).toBe(false);

    process.env.EXPO_PUBLIC_SIMULATE_MOVEMENT = "0";
    expect(loadAppConfig().simulateMovement).toBe(false);
  });
});
