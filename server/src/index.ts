/**
 * The server's public surface: the Lambda handler AWS invokes, plus the pieces
 * a test or a future entry point (a container, a local dev server) composes.
 */

export type { AuthConfig, ProviderConfig, ProviderConfigs } from "./auth/config.ts";
export {
  loadAuthConfig,
  PROVIDER_ENDPOINTS,
  SESSION_AUDIENCE,
  SESSION_ISSUER,
  SESSION_TTL_SECONDS,
} from "./auth/config.ts";
export { createAuthHandlers } from "./auth/handlers.ts";
export type { ProviderTokenVerifier, VerifiedIdentity } from "./auth/provider-tokens.ts";
export { createProviderTokenVerifier } from "./auth/provider-tokens.ts";
export type {
  AuthenticatedSession,
  SessionGate,
  SessionGateDependencies,
} from "./auth/session-gate.ts";
export { createSessionGate, OWNERSHIP_CHECKS } from "./auth/session-gate.ts";
export type { MintedSession, SessionClaims, SessionTokenCheck } from "./auth/session-token.ts";
export { hashSessionToken, mintSessionToken, verifySessionToken } from "./auth/session-token.ts";
export type { SignInDependencies } from "./auth/sign-in.ts";
export { signIn } from "./auth/sign-in.ts";
// `config/parameter-store.ts` is deliberately not re-exported here: it is the
// one module importing the AWS SDK, and re-exporting it would pull the SDK into
// every consumer of this index, including the infrastructure tests. Import it
// by path from the composition root that actually needs it.
export type { EnvironmentLeak, SecretName, SecretSource, Secrets } from "./config/secrets.ts";
export {
  assertNoSecretsInEnvironment,
  cachedSecretLoader,
  environmentSecretLeaks,
  loadSecrets,
  MissingSecretsError,
  RUNTIME_ENVIRONMENT_PREFIXES,
  SECRET_NAMES,
  SECRET_PARAMETER_SEGMENTS,
  SECRET_PREFIX_VARIABLE,
  SECRET_VALUE_PATTERNS,
  SECRET_VARIABLE_MARKERS,
  secretParameterName,
  secretParameterNames,
  secretParameterPrefix,
} from "./config/secrets.ts";
export type { ErrorClassification } from "./errors/app-error.ts";
export { AppError, ERROR_PROPERTIES, toAppError } from "./errors/app-error.ts";
export type { App, AppEnv } from "./http/app.ts";
export { createApp } from "./http/app.ts";
export type { ScheduledEvent } from "./lambda/events.ts";
export { isHttpEvent, isScheduledEvent } from "./lambda/events.ts";
export { createHandler, handler } from "./lambda/handler.ts";
export type { LogFields, Logger, LogLevel, LogSink } from "./observability/logger.ts";
export { createLogger } from "./observability/logger.ts";
export { scrub } from "./observability/redact.ts";
export type { SweepDependencies, SweepResult, SweepRunner } from "./sweep/run-sweep.ts";
export { createSweep, unconfiguredSweep } from "./sweep/run-sweep.ts";
