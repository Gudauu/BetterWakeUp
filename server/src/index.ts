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
export { runSweep } from "./sweep/run-sweep.ts";
