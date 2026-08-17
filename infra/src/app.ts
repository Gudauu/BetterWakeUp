/**
 * The CDK entry point, named by `cdk.json`.
 *
 * It does two things: read the deployment's decisions out of context, and put
 * one stack in the tree. Anything else belongs in a stack.
 */

import { fileURLToPath } from "node:url";
import type { App } from "aws-cdk-lib";
import { ApiStack } from "./api-stack.ts";
import { readStackConfiguration, type StackConfiguration } from "./config.ts";

/**
 * The code the function is given when nobody supplied a built bundle.
 *
 * Checked in so `cdk synth` and the assertion tests run with no build step.
 * Issue 39's pipeline passes the real bundle through `bwu:codeAssetPath`.
 */
export const PLACEHOLDER_CODE_ASSET_PATH = fileURLToPath(
  new URL("../lambda-bundle-placeholder", import.meta.url),
);

export function stackName(configuration: StackConfiguration): string {
  return `BetterWakeUp-Api-${configuration.stage}`;
}

export function defineApp(app: App): App {
  const configuration = readStackConfiguration(app.node, {
    codeAssetPath: PLACEHOLDER_CODE_ASSET_PATH,
  });

  new ApiStack(app, stackName(configuration), {
    configuration,
    env: {
      region: configuration.region,
      ...(configuration.account === undefined ? {} : { account: configuration.account }),
    },
  });

  return app;
}
