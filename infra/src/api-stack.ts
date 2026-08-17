/**
 * The application stack: one Lambda, one Function URL, one log group.
 *
 * Deliberately absent: a VPC (Neon is reached over its public endpoint, so a
 * VPC would add a NAT gateway's cost and protect nothing), an API Gateway (the
 * Function URL free tier does not expire), and any secret material: the
 * function is told the Parameter Store path its secrets hang off and granted a
 * read on exactly those four parameters, and no value ever enters its
 * environment or this template.
 */

import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import { OperationalAlarms } from "./alarms.ts";
import { CostBudget } from "./budget.ts";
import type { StackConfiguration } from "./config.ts";
import { LAMBDA_RESERVED_CONCURRENCY } from "./index.ts";
import { SweepSchedules } from "./schedules.ts";
import { SecretParameters } from "./secrets.ts";

/**
 * The environment variable naming the Parameter Store path prefix.
 *
 * A path is not a credential: knowing where a parameter lives grants nothing
 * without the IAM read above it. Passing it means one build is deployable to
 * every stage, which compiling the stage into the server would not be.
 *
 * Named for what it holds rather than for what it points at, so the server's
 * leak check needs no exception for it: an exception is the shape a real leak
 * would take. A test asserts this string equals the server's own constant.
 */
export const SECRET_PREFIX_VARIABLE = "PARAMETER_PATH_PREFIX";

/**
 * How long CloudWatch keeps this application's logs.
 *
 * Set explicitly because the default is forever: a log group with no retention
 * accrues storage for the life of the account. Three months outlives any
 * incident worth reading logs about and is well inside the free tier at this
 * volume.
 */
export const LOG_RETENTION = logs.RetentionDays.THREE_MONTHS;

/** The exported name of the Function URL, which is how the app is pointed at it. */
export const FUNCTION_URL_OUTPUT = "ApiFunctionUrl";

/**
 * The invocation budget for one request.
 *
 * Long enough for a cold start plus a Neon compute resuming from autosuspend,
 * short enough that a wedged request cannot bill for a quarter hour.
 */
export const LAMBDA_TIMEOUT = Duration.seconds(30);

/** Memory, which on Lambda also buys CPU. 512 MB is the knee for a Node API. */
export const LAMBDA_MEMORY_MB = 512;

export interface ApiStackProps extends StackProps {
  readonly configuration: StackConfiguration;
}

export class ApiStack extends Stack {
  readonly function: lambda.Function;
  readonly functionUrl: lambda.FunctionUrl;
  readonly logGroup: logs.LogGroup;
  readonly schedules: SweepSchedules;
  readonly secrets: SecretParameters;
  readonly alarms: OperationalAlarms;
  readonly budget: CostBudget;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { configuration } = props;

    // Named before the function, because the function's environment carries the
    // prefix and its role carries the read.
    this.secrets = new SecretParameters(this, "Secrets", { configuration });

    // Created here rather than left to Lambda's implicit group, which is what
    // makes the retention period ours to set and the group ours to delete.
    this.logGroup = new logs.LogGroup(this, "ApiLogs", {
      logGroupName: `/aws/lambda/betterwakeup-api-${configuration.stage}`,
      retention: LOG_RETENTION,
      removalPolicy: configuration.stage === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.function = new lambda.Function(this, "Api", {
      functionName: `betterwakeup-api-${configuration.stage}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(configuration.codeAssetPath),
      memorySize: LAMBDA_MEMORY_MB,
      timeout: LAMBDA_TIMEOUT,
      // The cost ceiling of issue 15, which holds where the database counters
      // do not. It is also a floor, so this function cannot be starved.
      reservedConcurrentExecutions: LAMBDA_RESERVED_CONCURRENCY,
      logGroup: this.logGroup,
      // Every value here is a routing or reporting decision. Nothing that
      // grants access appears in this map, and a test runs the synthesized map
      // through the server's own leak detector to keep it that way.
      environment: {
        STAGE: configuration.stage,
        NODE_OPTIONS: "--enable-source-maps",
        [SECRET_PREFIX_VARIABLE]: this.secrets.prefix,
      },
    });

    this.secrets.grantRead(this.function);

    this.functionUrl = this.function.addFunctionUrl({
      // The mobile app carries a session token and the payment provider signs
      // its deliveries, so the application authenticates every caller itself.
      // IAM authentication here would lock out both.
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // The sweep reaches this same function, and reaches it by invocation rather
    // than over the URL above: a schedule that called an HTTP route would need
    // the sweep to have one, and the architecture's rule is that it has none.
    this.schedules = new SweepSchedules(this, "SweepSchedules", {
      configuration,
      target: this.function,
    });

    // Last, because every alarm watches something above it, and because the
    // budget is about the whole stack rather than any one resource in it.
    this.alarms = new OperationalAlarms(this, "Alarms", {
      configuration,
      target: this.function,
    });
    this.budget = new CostBudget(this, "Budget", { configuration });

    new CfnOutput(this, FUNCTION_URL_OUTPUT, {
      value: this.functionUrl.url,
      description: "Public base URL of the API.",
    });
  }
}
