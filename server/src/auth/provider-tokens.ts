/**
 * Verifying an Apple or Google ID token.
 *
 * The app obtains the token natively and posts it here. Four things decide
 * whether it is real, and all four are checked by `jose` against the
 * provider's published keys: the signature, the issuer, the audience, and the
 * expiry. Nothing in the token's payload is trusted before that, which is why
 * the provider is taken from the request body and used to *choose* the
 * configuration rather than read out of the token.
 *
 * Two rules are enforced beyond what a plain verify does:
 *
 * - The algorithm list is closed to the asymmetric algorithms the two
 *   providers actually sign with. Left open, a caller could present an HS256
 *   token signed with the provider's public key, which is public.
 * - An Apple private relay address is discarded here, at the boundary, rather
 *   than trusted to be handled correctly by every later writer. `sub` is the
 *   identity; the email is display text the account can live without.
 */

import type { IdentityProvider } from "@betterwakeup/contract";
import {
  createRemoteJWKSet,
  type JWTPayload,
  type JWTVerifyGetKey,
  errors as joseErrors,
  jwtVerify,
} from "jose";
import { AppError } from "../errors/app-error.ts";
import type { ProviderConfig, ProviderConfigs } from "./config.ts";

/** The only algorithms Apple and Google sign identity tokens with. */
const ACCEPTED_ALGORITHMS = ["RS256", "ES256"];

/**
 * Apple routes relay mail through this domain. The `is_private_email` claim
 * says the same thing, but only Apple sends it, and only sometimes; the domain
 * is the part that is always true when it matters.
 */
const APPLE_PRIVATE_RELAY_DOMAIN = "@privaterelay.appleid.com";

/** Who the provider says this is, reduced to what we are willing to store. */
export interface VerifiedIdentity {
  readonly provider: IdentityProvider;
  /** The `iss` claim, kept because `sub` is only unique within its issuer. */
  readonly issuer: string;
  /** The `sub` claim: the identity key, and the only claim we key on. */
  readonly subject: string;
  /**
   * A display address, or null. Null covers three cases that are the same to
   * us: the provider withheld it, the provider had not verified it, and Apple
   * gave a private relay address.
   */
  readonly email: string | null;
}

export interface ProviderTokenVerifier {
  verify(provider: IdentityProvider, idToken: string): Promise<VerifiedIdentity>;
}

export interface VerifierOptions {
  readonly providers: ProviderConfigs;
  /**
   * Key resolvers, one per provider. Defaults to the provider's published
   * JWKS. A test supplies a local key set; nothing else should.
   */
  readonly keyResolvers?: Partial<Record<IdentityProvider, JWTVerifyGetKey>>;
  /**
   * Seconds of clock skew tolerated on `exp` and `iat`. Small, because both
   * providers and Lambda run on synchronized clocks and a generous tolerance
   * is just a longer life for an expired token.
   */
  readonly clockToleranceSeconds?: number;
}

export function createProviderTokenVerifier(options: VerifierOptions): ProviderTokenVerifier {
  // Built once per verifier: the remote key set caches Apple's and Google's
  // keys and refreshes them on an unknown `kid`, so a per-request resolver
  // would fetch a JWKS on every sign-in.
  const resolvers = new Map<IdentityProvider, JWTVerifyGetKey>();

  const resolverFor = (provider: IdentityProvider, config: ProviderConfig): JWTVerifyGetKey => {
    const supplied = options.keyResolvers?.[provider];
    if (supplied !== undefined) return supplied;
    const cached = resolvers.get(provider);
    if (cached !== undefined) return cached;
    const created = createRemoteJWKSet(new URL(config.jwksUri));
    resolvers.set(provider, created);
    return created;
  };

  return {
    async verify(provider, idToken) {
      const config = options.providers[provider];
      const payload = await verifyClaims(
        idToken,
        resolverFor(provider, config),
        config,
        options.clockToleranceSeconds ?? 5,
      );

      const subject = payload.sub;
      if (subject === undefined || subject.length === 0) {
        throw unauthenticated("The provider token carries no subject.");
      }
      const issuer = typeof payload.iss === "string" ? payload.iss : "";
      if (issuer.length === 0) {
        throw unauthenticated("The provider token carries no issuer.");
      }

      return { provider, issuer, subject, email: displayableEmail(payload) };
    },
  };
}

async function verifyClaims(
  idToken: string,
  keyResolver: JWTVerifyGetKey,
  config: ProviderConfig,
  clockTolerance: number,
): Promise<JWTPayload> {
  try {
    const verified = await jwtVerify(idToken, keyResolver, {
      algorithms: ACCEPTED_ALGORITHMS,
      // `jose` treats an array as a set of acceptable values, which is what
      // both of these are: several issuer spellings, several of our clients.
      issuer: [...config.issuers],
      audience: [...config.audiences],
      clockTolerance,
    });
    return verified.payload;
  } catch (cause) {
    const refusal = describe(cause);
    // Not a token problem: the JWKS fetch failed, or something else broke.
    // That is ours, so it must not be reported as the caller's bad credential.
    if (refusal === null) {
      throw new AppError("internal_error", "The provider token could not be checked.", { cause });
    }
    throw unauthenticated(refusal, cause);
  }
}

/**
 * Why the token was refused, in terms the app's developer can act on, or null
 * when the failure was not the token's fault.
 *
 * The client is told which check failed but never anything derived from the
 * token itself, so a rejected token cannot be echoed back through the error
 * message.
 */
function describe(cause: unknown): string | null {
  if (cause instanceof joseErrors.JWTExpired) {
    return "The provider token has expired.";
  }
  if (cause instanceof joseErrors.JWTClaimValidationFailed) {
    return `The provider token's ${cause.claim} claim is not accepted.`;
  }
  if (cause instanceof joseErrors.JWSSignatureVerificationFailed) {
    return "The provider token's signature does not verify against the provider's keys.";
  }
  if (cause instanceof joseErrors.JWKSNoMatchingKey) {
    return "The provider token was signed with a key the provider does not publish.";
  }
  if (cause instanceof joseErrors.JOSEAlgNotAllowed) {
    return "The provider token is signed with an algorithm the provider does not use.";
  }
  if (cause instanceof joseErrors.JWSInvalid || cause instanceof joseErrors.JWTInvalid) {
    return "The provider token is not a well-formed JSON Web Token.";
  }
  // Deliberately not a catch-all over `JOSEError`: a JWKS that timed out or
  // came back malformed is our outage, and calling it a bad credential would
  // tell every user to sign in again while the provider is unreachable.
  return null;
}

/**
 * The email we are willing to keep, or null.
 *
 * An unverified address is display text the provider itself does not stand
 * behind, and an Apple relay address is an alias that Apple can revoke and
 * that identifies our app rather than the person. Neither is worth storing,
 * and the identity does not depend on either: the key is `sub`.
 */
function displayableEmail(payload: JWTPayload): string | null {
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  if (email.length === 0) return null;
  if (!isTrue(payload.email_verified)) return null;
  if (isTrue(payload.is_private_email)) return null;
  if (email.toLowerCase().endsWith(APPLE_PRIVATE_RELAY_DOMAIN)) return null;
  return email;
}

/** Apple sends these claims as the strings "true" and "false"; Google as booleans. */
function isTrue(value: unknown): boolean {
  return value === true || value === "true";
}

function unauthenticated(message: string, cause?: unknown): AppError {
  return new AppError("unauthenticated", message, cause === undefined ? {} : { cause });
}
