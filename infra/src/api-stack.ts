/**
 * The application stack: one Lambda, one Function URL, one log group.
 *
 * Deliberately absent: a VPC (Neon is reached over its public endpoint, so a
 * VPC would add a NAT gateway's cost and protect nothing), an API Gateway (the
 * Function URL free tier does not expire), and any secret material (issue 37
 * puts those in Parameter Store and grants the role a read).
 */

import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import type { StackConfiguration } from "./config.ts";
import { LAMBDA_RESERVED_CONCURRENCY } from "./index.ts";

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

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { configuration } = props;

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
      // grants access appears in this map: see issue 37.
      environment: {
        STAGE: configuration.stage,
        NODE_OPTIONS: "--enable-source-maps",
      },
    });

    this.functionUrl = this.function.addFunctionUrl({
      // The mobile app carries a session token and the payment provider signs
      // its deliveries, so the application authenticates every caller itself.
      // IAM authentication here would lock out both.
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    new CfnOutput(this, FUNCTION_URL_OUTPUT, {
      value: this.functionUrl.url,
      description: "Public base URL of the API.",
    });
  }
}
