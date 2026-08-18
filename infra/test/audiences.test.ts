/**
 * The audiences are written down twice on purpose: once in the mobile package,
 * which is what mints the tokens, and once here, which is what the server is
 * told to accept. Two copies that disagree is a sign-in that fails only on a
 * real device against a real provider, which is the most expensive place to
 * find it, so both directions are asserted here instead.
 *
 * The names are asserted by feeding the synthesized environment to the
 * server's own reader rather than by comparing strings: a variable this stack
 * spells differently from the server would otherwise pass a string comparison
 * against itself.
 */

import { readFileSync } from "node:fs";
import { loadAuthConfig } from "@betterwakeup/server";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ApiStack } from "../src/api-stack.ts";
import { defineApp, PLACEHOLDER_CODE_ASSET_PATH, stackName } from "../src/app.ts";
import {
  APPLE_AUDIENCE_VARIABLE,
  APPLE_AUDIENCES,
  audienceList,
  GOOGLE_AUDIENCE_VARIABLE,
  GOOGLE_AUDIENCES,
} from "../src/audiences.ts";
import {
  CONTEXT_KEYS,
  DEFAULT_MONTHLY_BUDGET_USD,
  type StackConfiguration,
} from "../src/config.ts";

const configuration: StackConfiguration = {
  stage: "dev",
  region: "us-east-1",
  account: undefined,
  codeAssetPath: PLACEHOLDER_CODE_ASSET_PATH,
  alertEmail: undefined,
  monthlyBudgetUsd: DEFAULT_MONTHLY_BUDGET_USD,
};

interface AppManifest {
  readonly expo: {
    readonly ios: { readonly bundleIdentifier: string };
    readonly android: { readonly package: string };
    readonly extra: {
      readonly googleWebClientId?: string;
      readonly googleIosClientId?: string;
    };
  };
}

function appManifest(): AppManifest["expo"] {
  const path = new URL("../../app/app.json", import.meta.url);
  return (JSON.parse(readFileSync(path, "utf8")) as AppManifest).expo;
}

function functionEnvironment(): Record<string, string> {
  const app = new App();
  const stack = new ApiStack(app, stackName(configuration), {
    configuration,
    env: { region: configuration.region },
  });
  const functions = Object.values(Template.fromStack(stack).findResources("AWS::Lambda::Function"));
  expect(functions).toHaveLength(1);
  return (
    (functions[0]?.Properties?.Environment as { Variables?: Record<string, string> } | undefined)
      ?.Variables ?? {}
  );
}

describe("the audiences this stack tells the server to accept", () => {
  it("name the bundle identifier the app actually ships under", () => {
    // Apple puts the bundle identifier in `aud` for a native sign-in, so this
    // is the same string on both sides rather than a related one.
    expect([...APPLE_AUDIENCES]).toContain(appManifest().ios.bundleIdentifier);
  });

  it("name every Google client the app is configured with", () => {
    const { googleWebClientId, googleIosClientId } = appManifest().extra;
    // Absent means the app hides the Google button, which is coherent; present
    // and unlisted means the button works and the server rejects the token.
    for (const clientId of [googleWebClientId, googleIosClientId]) {
      if (clientId !== undefined) {
        expect([...GOOGLE_AUDIENCES]).toContain(clientId);
      }
    }
  });

  it("list no audience the app does not use, so a stale client cannot sign in", () => {
    const { googleWebClientId, googleIosClientId } = appManifest().extra;
    expect([...GOOGLE_AUDIENCES].sort()).toEqual(
      [googleWebClientId, googleIosClientId].filter((id) => id !== undefined).sort(),
    );
  });
});

describe("the function's audience variables", () => {
  it("are the ones the server reads, judged by the server's own reader", () => {
    const config = loadAuthConfig({
      ...functionEnvironment(),
      // Not in the template, and never will be: it is a secret and arrives
      // from Parameter Store. Supplied here only so the reader gets that far.
      SESSION_SECRET: "0".repeat(48),
    });
    expect([...config.providers.apple.audiences]).toEqual([...APPLE_AUDIENCES]);
    expect([...config.providers.google.audiences]).toEqual([...GOOGLE_AUDIENCES]);
  });

  it("carry every stage's function the same audiences, because the app is one app", () => {
    const environment = functionEnvironment();
    expect(environment[APPLE_AUDIENCE_VARIABLE]).toBe(audienceList(APPLE_AUDIENCES));
    expect(environment[GOOGLE_AUDIENCE_VARIABLE]).toBe(audienceList(GOOGLE_AUDIENCES));
  });

  it("reach the function the whole application defines, not only a hand-built stack", () => {
    const app = defineApp(
      new App({
        context: { [CONTEXT_KEYS.stage]: "dev", [CONTEXT_KEYS.region]: "us-east-1" },
      }),
    );
    const [stack] = app.node.children.filter((child) => child instanceof ApiStack);
    expect(stack).toBeInstanceOf(ApiStack);
    Template.fromStack(stack as ApiStack).hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          [APPLE_AUDIENCE_VARIABLE]: audienceList(APPLE_AUDIENCES),
          [GOOGLE_AUDIENCE_VARIABLE]: audienceList(GOOGLE_AUDIENCES),
        }),
      },
    });
  });
});
