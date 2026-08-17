/**
 * Issue 37's acceptance boundary: no secret is present in an environment
 * variable or the repository.
 *
 * The environment half is asserted against the synthesized template, and it is
 * asserted with the server's own leak detector rather than with a pattern
 * written here, so the two halves of the system cannot drift into disagreeing
 * about what counts as a secret.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  environmentSecretLeaks,
  SECRET_NAMES,
  SECRET_VALUE_PATTERNS,
  SECRET_PREFIX_VARIABLE as SERVER_PREFIX_VARIABLE,
  SECRET_PARAMETER_SEGMENTS as SERVER_SEGMENTS,
  secretParameterPrefix as serverSecretParameterPrefix,
} from "@betterwakeup/server";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ApiStack, SECRET_PREFIX_VARIABLE } from "../src/api-stack.ts";
import { PLACEHOLDER_CODE_ASSET_PATH, stackName } from "../src/app.ts";
import type { StackConfiguration } from "../src/config.ts";
import {
  SECRET_PARAMETER_SEGMENTS,
  SECRET_READ_ACTIONS,
  secretParameterPrefix,
} from "../src/secrets.ts";

const configuration: StackConfiguration = {
  stage: "dev",
  region: "us-east-1",
  account: "123456789012",
  codeAssetPath: PLACEHOLDER_CODE_ASSET_PATH,
};

function synthesize(overrides: Partial<StackConfiguration> = {}): Template {
  const app = new App();
  const merged = { ...configuration, ...overrides };
  const stack = new ApiStack(app, stackName(merged), {
    configuration: merged,
    // A pinned account, so the synthesized parameter ARNs are concrete strings
    // rather than pseudo-parameter references, which is what lets the scoping
    // assertions read them.
    env: { account: merged.account ?? "123456789012", region: merged.region },
  });
  return Template.fromStack(stack);
}

function functionEnvironment(template: Template): Record<string, string> {
  const functions = Object.values(template.findResources("AWS::Lambda::Function"));
  expect(functions).toHaveLength(1);
  const variables = (
    functions[0]?.Properties?.Environment as { Variables?: Record<string, string> } | undefined
  )?.Variables;
  return variables ?? {};
}

function secretReadStatements(template: Template): { Action: unknown; Resource: unknown }[] {
  return Object.values(template.findResources("AWS::IAM::Policy"))
    .flatMap(
      (policy) =>
        (
          policy.Properties?.PolicyDocument as {
            Statement: { Action: unknown; Resource: unknown }[];
          }
        ).Statement,
    )
    .filter((statement) => JSON.stringify(statement.Action).includes("ssm:"));
}

describe("the secret parameter names", () => {
  it("agree with the server's, name for name and in order", () => {
    // The stack states them so that synth does not depend on the application
    // package; this is what stops the two copies drifting.
    expect([...SECRET_PARAMETER_SEGMENTS]).toEqual(
      SECRET_NAMES.map((name) => SERVER_SEGMENTS[name]),
    );
    expect(secretParameterPrefix("dev")).toBe(serverSecretParameterPrefix("dev"));
    expect(SECRET_PREFIX_VARIABLE).toBe(SERVER_PREFIX_VARIABLE);
  });

  it("separate one stage's secrets from another's", () => {
    expect(secretParameterPrefix("dev")).not.toBe(secretParameterPrefix("prod"));
  });
});

describe("the function's environment", () => {
  it("carries no secret, judged by the server's own leak detector", () => {
    const environment = functionEnvironment(synthesize());
    expect(environmentSecretLeaks(environment)).toEqual([]);
  });

  it("carries the parameter path, which is a locator rather than a value", () => {
    const environment = functionEnvironment(synthesize());
    expect(environment[SECRET_PREFIX_VARIABLE]).toBe(secretParameterPrefix("dev"));
    // Every secret is reachable from it, so nothing is left needing a second
    // variable that a later change would be tempted to fill with a value.
    for (const segment of SECRET_PARAMETER_SEGMENTS) {
      expect(`${environment[SECRET_PREFIX_VARIABLE]}/${segment}`).toContain("/betterwakeup/dev/");
    }
  });

  it("names no secret parameter's value anywhere in the template", () => {
    const template = JSON.stringify(synthesize().toJSON());
    for (const pattern of SECRET_VALUE_PATTERNS) {
      expect(template).not.toMatch(pattern);
    }
  });
});

describe("the read the function is granted", () => {
  it("creates no parameter, because a created SecureString would need its value", () => {
    synthesize().resourceCountIs("AWS::SSM::Parameter", 0);
  });

  it("is exactly the two read actions, and no write or describe", () => {
    const statements = secretReadStatements(synthesize());
    expect(statements).toHaveLength(1);
    expect(statements[0]?.Action).toEqual([...SECRET_READ_ACTIONS]);
    expect(JSON.stringify(statements[0]?.Action)).not.toContain("Put");
    expect(JSON.stringify(statements[0]?.Action)).not.toContain("Describe");
  });

  it("is scoped to the four named parameters, with no wildcard", () => {
    const statements = secretReadStatements(synthesize());
    const resources = statements[0]?.Resource as unknown[];
    expect(resources).toHaveLength(SECRET_PARAMETER_SEGMENTS.length);
    const rendered = resources.map((resource) => JSON.stringify(resource));
    for (const segment of SECRET_PARAMETER_SEGMENTS) {
      // The ARN drops the leading slash of the parameter name.
      expect(
        rendered.some((value) => value.includes(`parameter/betterwakeup/dev/secrets/${segment}`)),
      ).toBe(true);
    }
    for (const value of rendered) {
      expect(value).not.toContain("*");
    }
  });

  it("cannot reach another stage's secrets", () => {
    const rendered = JSON.stringify(secretReadStatements(synthesize({ stage: "prod" }))[0]);
    expect(rendered).toContain("/betterwakeup/prod/secrets/");
    expect(rendered).not.toContain("/betterwakeup/dev/");
  });

  it("grants the schedulers no secret read of their own", () => {
    // Each trigger gets only what it needs: a schedule needs to invoke, not to
    // read. The invoke policies are asserted in the schedules suite; here the
    // claim is that only one policy in the stack mentions SSM at all.
    const template = synthesize();
    const withSsm = Object.values(template.findResources("AWS::IAM::Policy")).filter((policy) =>
      JSON.stringify(policy).includes("ssm:"),
    );
    expect(withSsm).toHaveLength(1);
    expect(JSON.stringify(withSsm[0]?.Properties?.Roles)).not.toContain("Scheduler");
  });
});

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Every tracked text file, minus the ones a scan cannot say anything useful
 * about: the lockfile is generated, and the run notes are orchestrator output.
 */
function trackedFiles(): string[] {
  const listing = execFileSync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return listing
    .split("\0")
    .filter((path) => path !== "")
    .filter((path) => path !== "pnpm-lock.yaml")
    .filter((path) => !path.startsWith(".gnhf/"))
    .filter((path) => !/\.(png|jpg|jpeg|gif|ico|webp|ttf|otf|woff2?|pdf|zip)$/i.test(path));
}

describe("the repository", () => {
  it("contains no value shaped like a secret", () => {
    const offenders: string[] = [];
    for (const path of trackedFiles()) {
      let contents: string;
      try {
        contents = readFileSync(join(repositoryRoot, path), "utf8");
      } catch {
        continue;
      }
      for (const pattern of SECRET_VALUE_PATTERNS) {
        // The pattern definitions live in the server, so the scan and the
        // startup refusal agree on what a secret looks like.
        if (pattern.test(contents)) {
          offenders.push(`${path} matched ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("scans a meaningful number of files, so an empty listing cannot pass", () => {
    expect(trackedFiles().length).toBeGreaterThan(50);
  });

  it("would catch a secret if one were added", () => {
    // The scan is only worth its runtime if it fails on the thing it is for.
    // Assembled from pieces so that this file does not itself trip the scan
    // above, which would be a self-inflicted failure rather than a finding.
    const planted = `postgres${"ql"}://bwu:hunter2@ep-example.us-east-1.aws.neon.tech/main`;
    expect(SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(planted))).toBe(true);
  });
});
