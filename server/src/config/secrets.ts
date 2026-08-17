/**
 * Where the server's secrets come from, and where they must never come from.
 *
 * The architecture asks for SSM Parameter Store SecureString entries. The
 * consequence that matters is not which AWS service holds the value, it is that
 * nothing which grants access is ever written into an environment variable, a
 * CloudFormation template, or this repository. An environment variable is
 * visible in the Lambda console, in `GetFunctionConfiguration` to anyone with
 * read access to the function, and in the synthesized template that CI prints;
 * a parameter read at runtime is visible only to a principal holding the read.
 *
 * So this module does three separate things:
 *
 * - It names the secret set. A closed list is what lets a test say "these and
 *   no others", and what lets the stack grant a read on exactly four ARNs.
 * - It loads them through a port, cached across warm invocations, so a Lambda
 *   container pays for the round trip once rather than per request.
 * - It refuses the alternative. `environmentSecretLeaks` is the executable form
 *   of issue 37's acceptance boundary, and the infrastructure tests run the
 *   synthesized function's environment map through it.
 */

/**
 * Every secret the server needs.
 *
 * Client identifiers for Apple and Google are deliberately absent: they are
 * published in the mobile app's bundle and are not credentials. Only values
 * whose disclosure would let someone else act as this server belong here.
 */
export const SECRET_NAMES = [
  /** The Neon connection string, which carries the database password. */
  "databaseUrl",
  /** The HS256 key session tokens are signed with. */
  "sessionSigningKey",
  /** The payment provider's server-side API key. */
  "paymentProviderApiKey",
  /** The shared secret provider deliveries are signed with. */
  "paymentWebhookSecret",
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];

export type Secrets = Readonly<Record<SecretName, string>>;

/**
 * The Parameter Store path segment each secret lives at.
 *
 * Written out rather than derived from the camel-case name, because these
 * strings are one half of a contract with the stack that grants the read: a
 * clever derivation changing shape would silently move every parameter.
 */
export const SECRET_PARAMETER_SEGMENTS: Readonly<Record<SecretName, string>> = {
  databaseUrl: "database-url",
  sessionSigningKey: "session-signing-key",
  paymentProviderApiKey: "payment-provider-api-key",
  paymentWebhookSecret: "payment-webhook-secret",
};

/**
 * The environment variable naming the Parameter Store path prefix.
 *
 * A path is not a secret: knowing where a parameter lives grants nothing
 * without the IAM read, and the alternative is compiling the stage into the
 * server, which would make the same build undeployable to two environments.
 *
 * Named for what it holds rather than for what it points at, so that the leak
 * check below needs no exception for it. A variable called `SECRETS_...` would
 * have forced one, and an exception is exactly the shape a real leak would take.
 */
export const SECRET_PREFIX_VARIABLE = "PARAMETER_PATH_PREFIX";

/** The prefix the stack passes, given a stage. Shared so both sides agree. */
export function secretParameterPrefix(stage: string): string {
  return `/betterwakeup/${stage}/secrets`;
}

/** The full parameter name of one secret. */
export function secretParameterName(prefix: string, name: SecretName): string {
  return `${trimTrailingSlash(prefix)}/${SECRET_PARAMETER_SEGMENTS[name]}`;
}

/** Every parameter name, in the order `SECRET_NAMES` declares. */
export function secretParameterNames(prefix: string): string[] {
  return SECRET_NAMES.map((name) => secretParameterName(prefix, name));
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * The slice of Parameter Store this module uses.
 *
 * A port rather than a direct SDK call, for the same reason the payment
 * provider is one: the resolution rules below (all four required, reported
 * together, cached once) are the part worth testing, and they are not testable
 * against a service that needs credentials.
 */
export interface SecretSource {
  /** Resolve parameter names to values. A name it cannot resolve is omitted. */
  read(parameterNames: readonly string[]): Promise<Readonly<Record<string, string>>>;
}

export class MissingSecretsError extends Error {
  readonly missing: readonly SecretName[];

  constructor(missing: readonly SecretName[], prefix: string) {
    // The message names the parameters, never a value, because it is the one
    // thing about secrets that reaches a log.
    super(
      `Missing secret parameters under ${prefix}: ${missing
        .map((name) => SECRET_PARAMETER_SEGMENTS[name])
        .join(", ")}.`,
    );
    this.name = "MissingSecretsError";
    this.missing = missing;
  }
}

/**
 * Load every secret at once.
 *
 * All four in one call rather than lazily one at a time: a server that starts,
 * serves sign-in, and only discovers at the first payment that its provider key
 * was never set has turned a deployment mistake into a production incident.
 * Every missing parameter is reported together for the same reason.
 */
export async function loadSecrets(source: SecretSource, prefix: string): Promise<Secrets> {
  const resolved = await source.read(secretParameterNames(prefix));
  const values: Partial<Record<SecretName, string>> = {};
  const missing: SecretName[] = [];

  for (const name of SECRET_NAMES) {
    const value = resolved[secretParameterName(prefix, name)];
    if (typeof value !== "string" || value === "") {
      missing.push(name);
      continue;
    }
    values[name] = value;
  }

  if (missing.length > 0) {
    throw new MissingSecretsError(missing, trimTrailingSlash(prefix));
  }
  return values as Secrets;
}

/**
 * A loader that reads once per container.
 *
 * The promise is cached rather than the result, so two concurrent requests in a
 * cold container make one call instead of two. A rejected load is not cached:
 * caching it would make a transient Parameter Store failure permanent for the
 * life of the container, which is exactly the failure a retry would have fixed.
 */
export function cachedSecretLoader(source: SecretSource, prefix: string): () => Promise<Secrets> {
  let pending: Promise<Secrets> | undefined;
  return () => {
    if (pending === undefined) {
      pending = loadSecrets(source, prefix).catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  };
}

/**
 * Environment variable prefixes belonging to the runtime rather than to us.
 *
 * The Lambda runtime sets `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`
 * itself, from the execution role. Those are credentials, but they are not
 * credentials this repository placed anywhere, and refusing to start because
 * AWS supplied them would make the check unusable. The check is about what the
 * deployment configures.
 */
export const RUNTIME_ENVIRONMENT_PREFIXES = ["AWS_", "LAMBDA_", "_"] as const;

/**
 * Environment variable names that carry a secret by convention.
 *
 * Matched on the name rather than the value because a name is what a reviewer
 * and a template diff both see, and because a placeholder value today becomes a
 * real one the day somebody fills it in.
 */
export const SECRET_VARIABLE_MARKERS = [
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "APIKEY",
  "API_KEY",
  "PRIVATE_KEY",
  "CREDENTIAL",
  "SESSION_KEY",
  "SIGNING_KEY",
  "DATABASE_URL",
  "CONNECTION_STRING",
  "ACCESS_TOKEN",
] as const;

/**
 * Value shapes that are a secret whatever the variable is called.
 *
 * A connection string with credentials in it stays a leak when somebody names
 * the variable `PG` or `NEON`, so the value is checked as well as the name.
 */
export const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  // A PostgreSQL URL carrying a username and password.
  /\bpostgres(?:ql)?:\/\/[^\s:/@]+:[^\s/@]+@/i,
  // Provider-style live and test keys.
  /\b(?:sk|rk|whsec)_(?:live|test)_[A-Za-z0-9]{8,}/,
  // A PEM private key of any flavour.
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
  // An AWS long-lived access key identifier.
  /\bAKIA[0-9A-Z]{16}\b/,
] as const;

export interface EnvironmentLeak {
  readonly variable: string;
  /** Why it is a leak: the variable's name, or the shape of its value. */
  readonly reason: "name" | "value";
}

/**
 * Every configured environment variable that carries, or is named as if it
 * carries, a secret.
 *
 * This is issue 37's acceptance boundary in executable form. The server calls
 * it at startup and the infrastructure tests call it against the synthesized
 * template's environment map, so one definition covers both halves of "no
 * secret is present in an environment variable".
 */
export function environmentSecretLeaks(
  environment: Readonly<Record<string, string | undefined>>,
): EnvironmentLeak[] {
  const leaks: EnvironmentLeak[] = [];
  for (const [variable, value] of Object.entries(environment)) {
    if (RUNTIME_ENVIRONMENT_PREFIXES.some((prefix) => variable.startsWith(prefix))) {
      continue;
    }
    const normalized = variable.toUpperCase();
    if (SECRET_VARIABLE_MARKERS.some((marker) => normalized.includes(marker))) {
      leaks.push({ variable, reason: "name" });
      continue;
    }
    if (typeof value === "string" && SECRET_VALUE_PATTERNS.some((p) => p.test(value))) {
      leaks.push({ variable, reason: "value" });
    }
  }
  return leaks;
}

/**
 * Refuse to run with a secret in the environment.
 *
 * Failing at startup rather than warning: a server that keeps running has
 * already been deployed with the leak, and the variable it is reading is the
 * one somebody will keep using.
 */
export function assertNoSecretsInEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const leaks = environmentSecretLeaks(environment);
  if (leaks.length === 0) {
    return;
  }
  // Names only. Printing the value would put the secret in CloudWatch, which is
  // the same disclosure this check exists to prevent.
  throw new Error(
    `Secrets must be read from Parameter Store, not the environment. Offending variables: ${leaks
      .map((leak) => `${leak.variable} (${leak.reason})`)
      .join(", ")}.`,
  );
}
