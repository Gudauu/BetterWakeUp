/**
 * What the stack has to be told, and what it refuses to be told.
 *
 * Everything here is a deployment decision rather than a code decision, so it
 * arrives as CDK context (`cdk.json`, or `-c key=value`) rather than as a
 * constant. The point of reading it through one function is that a missing or
 * nonsensical value fails at synth, where somebody is watching, instead of at
 * deploy or in production.
 */

/**
 * The AWS regions Neon runs in.
 *
 * The architecture requires the Lambda and the database to share a region, and
 * the database's region is the constrained half: Neon offers a shorter list
 * than AWS does. Naming the list here turns "same region as Neon" from a note
 * in a document into a synth-time refusal.
 */
export const NEON_AWS_REGIONS = [
  "ap-northeast-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "eu-central-1",
  "eu-west-2",
  "sa-east-1",
  "us-east-1",
  "us-east-2",
  "us-west-2",
] as const;

export type NeonAwsRegion = (typeof NEON_AWS_REGIONS)[number];

/** Deployment environments this application is defined for. */
export const STAGES = ["dev", "prod"] as const;

export type Stage = (typeof STAGES)[number];

export interface StackConfiguration {
  /** Which deployment this is. Part of every stack and resource name. */
  readonly stage: Stage;
  /** The region holding both the Lambda and the Neon project. */
  readonly region: NeonAwsRegion;
  /** The AWS account, when the caller pinned one. */
  readonly account: string | undefined;
  /**
   * The directory that becomes the function's code.
   *
   * A path rather than an in-repository build step: bundling the server is
   * issue 39's deploy pipeline, and until it exists this points at a checked-in
   * placeholder so the stack still synthesizes and can be asserted against.
   */
  readonly codeAssetPath: string;
}

/** The context keys this application reads. Prefixed so nothing collides. */
export const CONTEXT_KEYS = {
  stage: "bwu:stage",
  region: "bwu:region",
  account: "bwu:account",
  codeAssetPath: "bwu:codeAssetPath",
} as const;

export interface ContextReader {
  tryGetContext(key: string): unknown;
}

function readString(context: ContextReader, key: string): string | undefined {
  const value = context.tryGetContext(key);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Context ${key} must be a non-empty string.`);
  }
  return value.trim();
}

export function readStackConfiguration(
  context: ContextReader,
  defaults: { readonly codeAssetPath: string },
): StackConfiguration {
  const stage = readString(context, CONTEXT_KEYS.stage);
  if (stage === undefined) {
    throw new Error(`Context ${CONTEXT_KEYS.stage} is required (one of ${STAGES.join(", ")}).`);
  }
  if (!isStage(stage)) {
    throw new Error(`Context ${CONTEXT_KEYS.stage} must be one of ${STAGES.join(", ")}.`);
  }

  const region = readString(context, CONTEXT_KEYS.region);
  if (region === undefined) {
    // Not defaulted. The region is the one setting that must agree with a
    // decision made outside this repository, and a wrong guess is a
    // cross-region database round trip on every query.
    throw new Error(
      `Context ${CONTEXT_KEYS.region} is required and must be a region Neon runs in.`,
    );
  }
  if (!isNeonRegion(region)) {
    throw new Error(
      `Context ${CONTEXT_KEYS.region} must be a region Neon runs in: ${NEON_AWS_REGIONS.join(", ")}.`,
    );
  }

  return {
    stage,
    region,
    account: readString(context, CONTEXT_KEYS.account),
    codeAssetPath: readString(context, CONTEXT_KEYS.codeAssetPath) ?? defaults.codeAssetPath,
  };
}

function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

function isNeonRegion(value: string): value is NeonAwsRegion {
  return (NEON_AWS_REGIONS as readonly string[]).includes(value);
}
