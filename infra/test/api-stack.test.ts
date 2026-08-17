import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ApiStack, FUNCTION_URL_OUTPUT, LOG_RETENTION } from "../src/api-stack.ts";
import { defineApp, PLACEHOLDER_CODE_ASSET_PATH, stackName } from "../src/app.ts";
import { CONTEXT_KEYS, type StackConfiguration } from "../src/config.ts";
import { LAMBDA_RESERVED_CONCURRENCY } from "../src/index.ts";

const configuration: StackConfiguration = {
  stage: "dev",
  region: "us-east-1",
  account: undefined,
  codeAssetPath: PLACEHOLDER_CODE_ASSET_PATH,
};

function synthesize(overrides: Partial<StackConfiguration> = {}): Template {
  const app = new App();
  const merged = { ...configuration, ...overrides };
  const stack = new ApiStack(app, stackName(merged), {
    configuration: merged,
    env: { region: merged.region },
  });
  return Template.fromStack(stack);
}

describe("the API stack", () => {
  it("defines exactly one function, one URL, and one log group", () => {
    const template = synthesize();
    template.resourceCountIs("AWS::Lambda::Function", 1);
    template.resourceCountIs("AWS::Lambda::Url", 1);
    template.resourceCountIs("AWS::Logs::LogGroup", 1);
  });

  it("runs the function on the Node version the toolchain names", () => {
    synthesize().hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Handler: "index.handler",
    });
  });

  it("caps concurrency, so the bill is bounded even where a counter is not", () => {
    synthesize().hasResourceProperties("AWS::Lambda::Function", {
      ReservedConcurrentExecutions: LAMBDA_RESERVED_CONCURRENCY,
    });
  });

  it("puts the function in no VPC, because Neon is reached publicly", () => {
    const template = synthesize();
    template.resourceCountIs("AWS::EC2::VPC", 0);
    template.resourceCountIs("AWS::EC2::NatGateway", 0);
    const functions = template.findResources("AWS::Lambda::Function");
    for (const resource of Object.values(functions)) {
      expect(resource.Properties?.VpcConfig).toBeUndefined();
    }
  });

  it("reaches the function through a Function URL rather than API Gateway", () => {
    const template = synthesize();
    template.resourceCountIs("AWS::ApiGateway::RestApi", 0);
    template.resourceCountIs("AWS::ApiGatewayV2::Api", 0);
    // The application authenticates every caller itself: the app carries a
    // session token and the provider signs its deliveries. IAM here would
    // lock out both.
    template.hasResourceProperties("AWS::Lambda::Url", { AuthType: "NONE" });
  });

  it("publishes the URL, which is how the app is pointed at the deployment", () => {
    const outputs = synthesize().findOutputs(FUNCTION_URL_OUTPUT);
    expect(Object.keys(outputs)).toHaveLength(1);
  });

  it("gives the log group an explicit retention, because the default is forever", () => {
    synthesize().hasResourceProperties("AWS::Logs::LogGroup", {
      RetentionInDays: Number(LOG_RETENTION),
    });
    expect(Number(LOG_RETENTION)).toBeGreaterThan(0);
  });

  it("keeps production logs when the stack is deleted and discards a dev stack's", () => {
    synthesize({ stage: "prod" }).hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "Retain",
    });
    synthesize({ stage: "dev" }).hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "Delete",
    });
  });

  it("names every resource after its stage, so two deployments cannot collide", () => {
    synthesize({ stage: "prod" }).hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "betterwakeup-api-prod",
    });
  });

  it("puts nothing that grants access in an environment variable", () => {
    const template = synthesize();
    const functions = template.findResources("AWS::Lambda::Function");
    for (const resource of Object.values(functions)) {
      const variables: Record<string, unknown> = resource.Properties?.Environment?.Variables ?? {};
      // Issue 37 gives the role a Parameter Store read. Until then, and after
      // it, no credential, connection string, or signing key is a template
      // value: everything in a synthesized template is world-readable to
      // anyone who can describe the stack.
      for (const [name, value] of Object.entries(variables)) {
        expect(name).not.toMatch(/secret|token|password|key|dsn|url|credential/i);
        expect(String(value)).not.toMatch(/postgres:|postgresql:|https?:\/\//i);
      }
    }
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: Match.objectLike({ STAGE: "dev" }) },
    });
  });

  it("grants the function nothing beyond writing its own logs", () => {
    const template = synthesize();
    // The function's own policy, told apart from the schedulers' invoke
    // policies by the role it is attached to.
    const functionRoleId = Object.entries(template.findResources("AWS::IAM::Role")).find(
      ([, resource]) =>
        JSON.stringify(resource.Properties?.AssumeRolePolicyDocument).includes(
          "lambda.amazonaws.com",
        ),
    )?.[0];
    expect(functionRoleId).toBeDefined();
    const policies = Object.fromEntries(
      Object.entries(template.findResources("AWS::IAM::Policy")).filter(([, resource]) =>
        JSON.stringify(resource.Properties?.Roles).includes(String(functionRoleId)),
      ),
    );
    // Its whole grant is the basic execution role, which is log writing and
    // nothing else. Any capability added later would arrive either as a second
    // managed policy or as an inline one, and both are asserted away here.
    const functionRole = template.findResources("AWS::IAM::Role")[String(functionRoleId)];
    expect(JSON.stringify(functionRole?.Properties?.ManagedPolicyArns)).toContain(
      "AWSLambdaBasicExecutionRole",
    );
    expect(functionRole?.Properties?.ManagedPolicyArns).toHaveLength(1);
    expect(functionRole?.Properties?.Policies).toBeUndefined();
    expect(Object.keys(policies)).toHaveLength(0);
  });
});

describe("the CDK application", () => {
  it("synthesizes from context alone, with no build step", () => {
    const app = new App({
      context: { [CONTEXT_KEYS.stage]: "dev", [CONTEXT_KEYS.region]: "us-east-1" },
    });
    const assembly = defineApp(app).synth();
    expect(assembly.stacks.map((stack) => stack.stackName)).toEqual(["BetterWakeUp-Api-dev"]);
  });

  it("pins the stack to the region the context names", () => {
    const app = new App({
      context: {
        [CONTEXT_KEYS.stage]: "prod",
        [CONTEXT_KEYS.region]: "eu-central-1",
        [CONTEXT_KEYS.account]: "123456789012",
      },
    });
    const [stack] = defineApp(app).synth().stacks;
    expect(stack?.environment.region).toBe("eu-central-1");
    expect(stack?.environment.account).toBe("123456789012");
  });
});
