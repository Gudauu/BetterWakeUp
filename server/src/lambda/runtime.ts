/**
 * The deployed Lambda composition root.
 *
 * Feature modules describe their dependencies and stay independently testable.
 * This file is the one place that turns AWS configuration into long-lived
 * process resources, mounts the HTTP handlers, and configures scheduled work.
 * Lambda reuses the resulting promise across warm invocations, so one container
 * owns one Neon connection pool and one cached Google/Apple JWKS resolver.
 */

import { loadAuthConfig } from "../auth/config.ts";
import { createAuthHandlers } from "../auth/handlers.ts";
import { createProviderTokenVerifier } from "../auth/provider-tokens.ts";
import { createSessionGate } from "../auth/session-gate.ts";
import { createChallengeHandlers } from "../challenges/handlers.ts";
import { parameterStoreSource } from "../config/parameter-store.ts";
import { SECRET_PREFIX_VARIABLE, type SecretName, secretParameterName } from "../config/secrets.ts";
import { createDatabase } from "../db/client.ts";
import { createApp } from "../http/app.ts";
import { createLogger } from "../observability/logger.ts";
import { createRateLimiter } from "../rate-limit/service.ts";
import { createSweep } from "../sweep/run-sweep.ts";
import { createHandler, type LambdaContext } from "./handler.ts";

const RUNTIME_SECRET_NAMES = [
  "databaseUrl",
  "sessionSigningKey",
] as const satisfies readonly SecretName[];

type RuntimeHandler = ReturnType<typeof createHandler>;

let runtimePromise: Promise<RuntimeHandler> | undefined;

/** The handler named by the CDK stack's `index.handler` setting. */
export async function handler(event: unknown, context?: LambdaContext): Promise<unknown> {
  runtimePromise ??= composeRuntime();
  const runtime = await runtimePromise;
  return await runtime(event, context);
}

async function composeRuntime(): Promise<RuntimeHandler> {
  const prefix = requiredEnvironment(SECRET_PREFIX_VARIABLE);
  const source = parameterStoreSource();
  const parameterNames = RUNTIME_SECRET_NAMES.map((name) => secretParameterName(prefix, name));
  const values = await source.read(parameterNames);

  const databaseUrl = requiredParameter(values, secretParameterName(prefix, "databaseUrl"));
  const sessionSecret = requiredParameter(values, secretParameterName(prefix, "sessionSigningKey"));
  const auth = loadAuthConfig({
    APPLE_AUDIENCES: process.env.APPLE_AUDIENCES,
    GOOGLE_AUDIENCES: process.env.GOOGLE_AUDIENCES,
    SESSION_SECRET: sessionSecret,
  });

  const database = createDatabase({ connectionString: databaseUrl });
  const logger = createLogger();
  const verifier = createProviderTokenVerifier({ providers: auth.providers });
  const sessionGate = createSessionGate({ db: database.db, sessionSecret: auth.sessionSecret });
  const rateLimiter = createRateLimiter({ db: database.db });
  const handlers = {
    ...createAuthHandlers({
      db: database.db,
      verifier,
      sessionSecret: auth.sessionSecret,
      sessionTtlSeconds: auth.sessionTtlSeconds,
    }),
    // No payment provider is supplied yet. The handler set therefore mounts
    // projection, zero-deposit creation, reading, and lifecycle commands while
    // leaving the funded door absent rather than pretending Stripe is wired.
    ...createChallengeHandlers({ db: database.db }),
  };
  const app = createApp({ handlers, logger, rateLimiter, sessionGate });

  return createHandler({ app, logger, sweep: createSweep({ db: database.db }) });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function requiredParameter(
  values: Readonly<Record<string, string>>,
  parameterName: string,
): string {
  const value = values[parameterName];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing secret parameter ${parameterName}.`);
  }
  return value;
}
