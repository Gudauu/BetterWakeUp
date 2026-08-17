/**
 * The session token the API issues in exchange for a provider token.
 *
 * It is a signed JWT whose `jti` is the session row's identifier, and the
 * database stores a SHA-256 hash of the token string rather than the token.
 * Both halves are load-bearing:
 *
 * - The signature lets the server reject a forged or tampered token without a
 *   database round trip, which is what keeps an unauthenticated flood off the
 *   database rather than merely off the domain.
 * - The row is the authority. Expiry is on the row as well as in the token,
 *   revocation exists at all, and a database dump does not contain anything
 *   that can be presented as a session.
 *
 * A signature alone would make sign-out unimplementable; a random opaque
 * string alone would put every forged token through a query. Neither is
 * enough, so the token carries both.
 */

import { createHash } from "node:crypto";
import { errors, jwtVerify, SignJWT } from "jose";
import { SESSION_AUDIENCE, SESSION_ISSUER } from "./config.ts";

export interface SessionClaims {
  /** The session row's identifier, carried as `jti`. */
  readonly sessionId: string;
  /** The internal account identifier, carried as `sub`. */
  readonly accountId: string;
}

export interface MintedSession extends SessionClaims {
  readonly token: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface MintOptions {
  readonly secret: string;
  readonly accountId: string;
  readonly ttlSeconds: number;
  /** Injected so a test asserts an expiry rather than tolerating one. */
  readonly now?: Date;
  /** Injected only by a test that needs the row's identifier in advance. */
  readonly sessionId?: string;
}

/** Sign a new session token. The caller stores `hashSessionToken(token)`. */
export async function mintSessionToken(options: MintOptions): Promise<MintedSession> {
  const sessionId = options.sessionId ?? crypto.randomUUID();
  const now = options.now ?? new Date();
  // Second precision, because that is all `exp` and `iat` carry: keeping the
  // row's expiry to the same precision means the token and the row agree.
  const issuedAtSeconds = Math.floor(now.getTime() / 1000);
  const expiresAtSeconds = issuedAtSeconds + options.ttlSeconds;

  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setSubject(options.accountId)
    .setJti(sessionId)
    .setIssuedAt(issuedAtSeconds)
    .setExpirationTime(expiresAtSeconds)
    .sign(secretKey(options.secret));

  return {
    token,
    sessionId,
    accountId: options.accountId,
    issuedAt: new Date(issuedAtSeconds * 1000),
    expiresAt: new Date(expiresAtSeconds * 1000),
  };
}

/**
 * The outcome of checking a presented token.
 *
 * Expiry is separated from every other failure because it is the one the app
 * can act on: a session that ran out means sign in again and carry on, while a
 * token that does not verify at all means the credential the app is holding is
 * not one this server ever issued. They are both a 401, but they are not the
 * same news, and the contract has a code for each.
 *
 * A result rather than a throw, because the caller decides what an unusable
 * credential means on its path.
 */
export type SessionTokenCheck =
  | { readonly ok: true; readonly claims: SessionClaims }
  | { readonly ok: false; readonly reason: "expired" | "unusable" };

/** Check a presented token's signature, issuer, audience, and expiry. */
export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<SessionTokenCheck> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret), {
      // Closed to the one algorithm we sign with. Left open, `alg: none` and
      // an asymmetric algorithm with an attacker-chosen key both become
      // acceptable ways to mint a session.
      algorithms: ["HS256"],
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
    });
    const sessionId = payload.jti;
    const accountId = payload.sub;
    if (sessionId === undefined || accountId === undefined) {
      return { ok: false, reason: "unusable" };
    }
    return { ok: true, claims: { sessionId, accountId } };
  } catch (thrown) {
    // Only `exp` earns the expired answer. A token that fails the signature
    // and happens to also be past its own `exp` is not an expired session, it
    // is a forgery, and telling the app to sign in again would be wrong.
    if (thrown instanceof errors.JWTExpired) return { ok: false, reason: "expired" };
    return { ok: false, reason: "unusable" };
  }
}

/**
 * What the `sessions` table stores.
 *
 * A plain SHA-256 with no salt or work factor, deliberately: the token is
 * server-minted with full entropy, so there is no dictionary to run against
 * it, and the lookup is by hash and has to be a single indexed equality.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}
