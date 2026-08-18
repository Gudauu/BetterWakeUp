/**
 * What a build is told about Google, and when it is told nothing.
 *
 * The URL scheme is the iOS client ID written backwards, and Google's config
 * plugin refuses anything else. Deriving it rather than restating it is what
 * makes the two impossible to disagree, so the derivation is the part worth a
 * test: a wrong scheme is not a failed build, it is a sign-in that opens Google
 * and never comes back, on a device, in release.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import defineConfig from "../app.config.ts";

interface Extra {
  readonly googleIosClientId?: string;
}

function manifest(): { extra?: Extra; plugins?: unknown[] } {
  return JSON.parse(readFileSync(join(__dirname, "../app.json"), "utf8")).expo;
}

function googlePlugin(extra: Extra | undefined): [string, { iosUrlScheme: string }] | undefined {
  const base = manifest();
  // The context Expo hands in: `app.json` merged and nothing else.
  const config = defineConfig({ config: { ...base, extra } } as never);
  return config.plugins?.find(
    (plugin): plugin is [string, { iosUrlScheme: string }] =>
      Array.isArray(plugin) && String(plugin[0]).includes("google-signin"),
  );
}

const IOS_CLIENT_ID = "1234567890-abcdef.apps.googleusercontent.com";

describe("the build's Google configuration", () => {
  const saved = process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME;
    } else {
      process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME = saved;
    }
  });

  it("derives the URL scheme by flipping the halves of the iOS client ID", () => {
    delete process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME;
    expect(googlePlugin({ googleIosClientId: IOS_CLIENT_ID })?.[1].iosUrlScheme).toBe(
      "com.googleusercontent.apps.1234567890-abcdef",
    );
  });

  it("derives it for the client ID this app actually ships with", () => {
    delete process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME;
    const clientId = manifest().extra?.googleIosClientId;
    expect(clientId).toBeDefined();
    expect(googlePlugin(manifest().extra)?.[1].iosUrlScheme).toBe(
      `com.googleusercontent.apps.${clientId?.replace(".apps.googleusercontent.com", "")}`,
    );
  });

  it("lets the environment override it, so a build can face another project", () => {
    process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME = "com.googleusercontent.apps.other-project";
    expect(googlePlugin({ googleIosClientId: IOS_CLIENT_ID })?.[1].iosUrlScheme).toBe(
      "com.googleusercontent.apps.other-project",
    );
  });

  it("leaves the plugin out when there is no Google project at all", () => {
    // A build with no Google configuration is coherent rather than broken: the
    // app hides the button, so the plugin would register a callback nothing
    // ever calls.
    delete process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME;
    expect(googlePlugin(undefined)).toBeUndefined();
  });

  it("leaves it out for a client ID that is not Google's, rather than reversing it", () => {
    delete process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME;
    expect(googlePlugin({ googleIosClientId: "not-a-google-client-id" })).toBeUndefined();
  });
});
