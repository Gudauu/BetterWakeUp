/**
 * The gate every command passes through: who is calling, and is the thing they
 * addressed theirs.
 *
 * Both halves are here rather than in the handlers because a handler that
 * forgets one of them is not a broken feature, it is a way to read or change
 * somebody else's challenge. `registerRoutes` runs the gate for every endpoint
 * the contract marks `auth: "session"`, so the check exists once and a new
 * endpoint inherits it by being in the registry.
 *
 * The ownership answer is `not_found`, never `forbidden`. A 403 for a task that
 * belongs to someone else and a 404 for a task that does not exist are
 * distinguishable, and the difference is an oracle: an attacker holding a valid
 * session can walk identifiers and learn which ones name real tasks. Both
 * answers are therefore the same answer, and the resource simply does not exist
 * as far as this caller is concerned.
 */

import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { challenges, scheduledTasks } from "../db/schema/challenges.ts";
import { sessions } from "../db/schema/identity.ts";
import { AppError } from "../errors/app-error.ts";
import { hashSessionToken, verifySessionToken } from "./session-token.ts";

/** The caller, once the gate has established there is one. */
export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly accountId: string;
}

export interface SessionGate {
  /** Resolve the caller, or throw the 401 that says why there isn't one. */
  authenticate(authorization: string | undefined): Promise<AuthenticatedSession>;
  /**
   * Assert the caller owns every resource the path addresses. Throws
   * `not_found` for a resource that is absent and for one that is someone
   * else's, which are deliberately the same outcome.
   */
  assertOwnership(session: AuthenticatedSession, params: unknown): Promise<void>;
}

export interface SessionGateDependencies {
  readonly db: Pick<Database, "select">;
  readonly sessionSecret: string;
  /** Injected so a test asserts an expiry boundary rather than tolerating it. */
  readonly now?: () => Date;
}

/**
 * How a path parameter is proved to belong to the caller.
 *
 * Keyed by the parameter name the contract uses, so the registry and the
 * ownership rules cannot drift: a route that introduces a new addressed
 * resource has a parameter name with no entry here, and `assertOwnership`
 * refuses rather than waving it through. A test walks the registry and asserts
 * every session endpoint's parameters are covered.
 */
type OwnershipCheck = (
  deps: SessionGateDependencies,
  accountId: string,
  id: string,
) => Promise<boolean>;

export const OWNERSHIP_CHECKS: Readonly<Record<string, OwnershipCheck>> = {
  challengeId: async (deps, accountId, id) => {
    const rows = await deps.db
      .select({ id: challenges.id })
      .from(challenges)
      .where(and(eq(challenges.id, id), eq(challenges.accountId, accountId)))
      .limit(1);
    return rows.length === 1;
  },
  // A task is owned through its challenge. There is no account column on a
  // task, and adding one would be a second answer to the same question that a
  // migration could get out of step with the first.
  taskId: async (deps, accountId, id) => {
    const rows = await deps.db
      .select({ id: scheduledTasks.id })
      .from(scheduledTasks)
      .innerJoin(challenges, eq(challenges.id, scheduledTasks.challengeId))
      .where(and(eq(scheduledTasks.id, id), eq(challenges.accountId, accountId)))
      .limit(1);
    return rows.length === 1;
  },
};

export function createSessionGate(deps: SessionGateDependencies): SessionGate {
  const now = deps.now ?? (() => new Date());

  return {
    async authenticate(authorization) {
      const token = bearerToken(authorization);
      if (token === undefined) {
        throw new AppError("unauthenticated", "This endpoint requires a session token.");
      }

      // The signature first, and only then the database. A flood of forged
      // tokens costs one HMAC each and never reaches a connection, which is
      // the whole reason the token is signed as well as stored.
      const checked = await verifySessionToken(token, deps.sessionSecret, { now: now() });
      if (!checked.ok) {
        throw checked.reason === "expired"
          ? new AppError("session_expired", "This session has expired. Sign in again.")
          : new AppError("unauthenticated", "The session token is not valid.");
      }

      const rows = await deps.db
        .select({
          id: sessions.id,
          accountId: sessions.accountId,
          expiresAt: sessions.expiresAt,
          revokedAt: sessions.revokedAt,
        })
        .from(sessions)
        .where(eq(sessions.tokenHash, hashSessionToken(token)))
        .limit(1);

      const row = rows[0];
      // No row is a session that was signed out and swept, or an account that
      // was deleted and took its sessions with it by cascade. Either way the
      // signature proves the token was ours and the row proves it no longer is.
      if (row === undefined) {
        throw new AppError("unauthenticated", "This session is no longer valid.");
      }
      if (row.revokedAt !== null) {
        throw new AppError("unauthenticated", "This session was signed out.");
      }
      // The row is the authority on expiry, not the token: a session can be cut
      // short, and the token's own `exp` cannot be edited to follow.
      if (row.expiresAt.getTime() <= now().getTime()) {
        throw new AppError("session_expired", "This session has expired. Sign in again.");
      }
      // The token is found by hash, so the claims should describe the row it
      // found. Disagreement means a token minted against a different row's
      // contents, which is nothing this server does.
      if (row.id !== checked.claims.sessionId || row.accountId !== checked.claims.accountId) {
        throw new AppError("unauthenticated", "The session token does not match its session.");
      }

      return { sessionId: row.id, accountId: row.accountId };
    },

    async assertOwnership(session, params) {
      if (params === null || typeof params !== "object") return;

      for (const [name, value] of Object.entries(params as Record<string, unknown>)) {
        const check = OWNERSHIP_CHECKS[name];
        // Refusing is the only safe answer to a parameter nobody taught this
        // gate to check. Waving it through would make the next addressed
        // resource unowned by omission, which is exactly the failure the gate
        // exists to make impossible.
        if (check === undefined || typeof value !== "string") {
          throw new AppError(
            "internal_error",
            `No ownership rule covers the path parameter "${name}".`,
          );
        }
        if (await check(deps, session.accountId, value)) continue;
        throw new AppError("not_found", `No ${describe(name)} with this identifier.`);
      }
    },
  };
}

function describe(parameterName: string): string {
  return parameterName === "taskId" ? "task" : "challenge";
}

/**
 * The `Authorization: Bearer <token>` value, or undefined for anything else.
 *
 * The scheme is matched case-insensitively because RFC 7235 says it is, and no
 * other scheme is accepted: `Basic` credentials against this API would be a
 * client sending a password to an endpoint that has never had one.
 */
function bearerToken(authorization: string | undefined): string | undefined {
  if (authorization === undefined) return undefined;
  const match = /^Bearer[ \t]+(?<token>\S+)$/i.exec(authorization.trim());
  return match?.groups?.token;
}
