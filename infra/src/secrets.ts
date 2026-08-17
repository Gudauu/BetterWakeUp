/**
 * Where secrets live, and what is allowed to read them.
 *
 * Two things are deliberately not here.
 *
 * The parameters themselves are not created by this stack. CloudFormation
 * cannot create an `AWS::SSM::Parameter` of type `SecureString` at all, and
 * that limitation is a feature rather than an obstacle: a stack that could
 * create one would have had to be given the value, which means the value would
 * have been in a template, a context file, or a CI variable. So the stack
 * names the parameters and grants a read on them, and the values are put in
 * place out of band by whoever holds them.
 *
 * A KMS grant is also not here. SecureStrings under the account's default
 * `alias/aws/ssm` key are decryptable by any principal in the account that SSM
 * calls on behalf of, through the AWS-managed key's own policy, so a
 * `kms:Decrypt` statement would widen the role for no effect. If a
 * customer-managed key is ever adopted, that is the moment to add one, and the
 * test asserting the exact statement set is what will notice.
 *
 * The parameter names are stated here rather than imported from the server, so
 * that synthesizing the stack does not depend on the application package. A
 * test asserts the two agree, which is the only thing importing would have
 * bought.
 */

import { ArnFormat, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import type { StackConfiguration } from "./config.ts";

/** The path segment of every secret, in the order the server declares them. */
export const SECRET_PARAMETER_SEGMENTS = [
  "database-url",
  "session-signing-key",
  "payment-provider-api-key",
  "payment-webhook-secret",
] as const;

/** The Parameter Store path every secret of a stage hangs off. */
export function secretParameterPrefix(stage: string): string {
  return `/betterwakeup/${stage}/secrets`;
}

/**
 * The only SSM actions the function is granted.
 *
 * `GetParameters` is what the server actually calls; `GetParameter` is included
 * because a singular read is the obvious thing for a future caller to reach
 * for, and discovering the omission in production is worse than the negligible
 * widening. `DescribeParameters`, `PutParameter`, and anything path-shaped are
 * absent: the function reads four named values and never writes one.
 */
export const SECRET_READ_ACTIONS = ["ssm:GetParameter", "ssm:GetParameters"] as const;

export interface SecretParametersProps {
  readonly configuration: StackConfiguration;
}

/** The secret parameters this deployment expects, and the read on them. */
export class SecretParameters extends Construct {
  /** The Parameter Store path every secret hangs off. Not itself a secret. */
  readonly prefix: string;
  /** The full name of every secret parameter, in the server's declared order. */
  readonly parameterNames: string[];
  /** The ARN of every secret parameter. What the grant is scoped to. */
  readonly parameterArns: string[];

  constructor(scope: Construct, id: string, props: SecretParametersProps) {
    super(scope, id);
    this.prefix = secretParameterPrefix(props.configuration.stage);
    this.parameterNames = SECRET_PARAMETER_SEGMENTS.map((segment) => `${this.prefix}/${segment}`);
    this.parameterArns = this.parameterNames.map((name) =>
      Stack.of(this).formatArn({
        service: "ssm",
        // A parameter's ARN drops the leading slash of its name, so
        // `/betterwakeup/dev/secrets/database-url` becomes a resource of
        // `parameter/betterwakeup/dev/secrets/database-url`. Getting this wrong
        // produces a grant that denies everything at runtime while looking
        // correct in the template.
        resource: `parameter${name}`,
        arnFormat: ArnFormat.NO_RESOURCE_NAME,
      }),
    );
  }

  /**
   * Grant a principal the read on exactly these parameters.
   *
   * Scoped to the four ARNs rather than to `parameter/betterwakeup/*`, so a
   * second stage's secrets, and anything else the account ever stores, stay out
   * of this function's reach. Written as an explicit statement rather than
   * through `StringParameter.grantRead`, because that helper grants four
   * actions including `DescribeParameters` on `*`, and the point of this issue
   * is that each trigger gets only what it needs.
   */
  grantRead(grantee: iam.IGrantable): void {
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [...SECRET_READ_ACTIONS],
        resources: this.parameterArns,
      }),
    );
  }
}
