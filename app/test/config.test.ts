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
