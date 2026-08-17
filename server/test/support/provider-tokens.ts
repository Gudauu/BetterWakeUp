/**
 * A stand-in for Apple's and Google's signing keys.
 *
 * The verifier takes its key resolver as an option precisely so a test can
 * hold the private half of the key the tokens are checked against. Everything
 * else about verification is the real path: real signatures, real claim
 * checks, real `jose`.
 */

import type { IdentityProvider } from "@betterwakeup/contract";
import {
  type CryptoKey,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  SignJWT,
} from "jose";

import type { AuthConfig } from "../../src/auth/config.ts";
import { PROVIDER_ENDPOINTS } from "../../src/auth/config.ts";

export const APPLE_AUDIENCE = "com.betterwakeup.app";
export const GOOGLE_AUDIENCE = "1234567890-test.apps.googleusercontent.com";

/** Long enough for `loadAuthConfig`, and obviously not a real secret. */
export const TEST_SESSION_SECRET = "test-session-secret-of-sufficient-length";

export interface IdTokenClaims {
  readonly issuer?: string;
  readonly audience?: string;
  readonly subject?: string | null;
  readonly email?: string;
  readonly emailVerified?: boolean | string;
  readonly isPrivateEmail?: boolean | string;
  /** Seconds from now. Negative mints an already-expired token. */
  readonly expiresInSeconds?: number;
}

export interface ProviderKeys {
  /** Signs a token the verifier will accept, unless a claim says otherwise. */
  sign(provider: IdentityProvider, claims?: IdTokenClaims): Promise<string>;
  /** Signs with a key the published JWKS does not contain. */
  signWithForeignKey(provider: IdentityProvider, claims?: IdTokenClaims): Promise<string>;
  readonly keyResolvers: Record<IdentityProvider, JWTVerifyGetKey>;
  readonly config: AuthConfig;
}

export async function createProviderKeys(): Promise<ProviderKeys> {
  const apple = await createKeyPair("apple-key-1");
  const google = await createKeyPair("google-key-1");
  const foreign = await createKeyPair("foreign-key-1");

  const signers: Record<IdentityProvider, KeyPair> = { apple, google };

  const config: AuthConfig = {
    providers: {
      apple: { ...PROVIDER_ENDPOINTS.apple, audiences: [APPLE_AUDIENCE] },
      google: { ...PROVIDER_ENDPOINTS.google, audiences: [GOOGLE_AUDIENCE] },
    },
    sessionSecret: TEST_SESSION_SECRET,
    sessionTtlSeconds: 3600,
  };

  const defaultAudience: Record<IdentityProvider, string> = {
    apple: APPLE_AUDIENCE,
    google: GOOGLE_AUDIENCE,
  };

  const signWith = async (
    keys: KeyPair,
    provider: IdentityProvider,
    claims: IdTokenClaims,
  ): Promise<string> => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {};
    if (claims.email !== undefined) payload.email = claims.email;
    if (claims.emailVerified !== undefined) payload.email_verified = claims.emailVerified;
    if (claims.isPrivateEmail !== undefined) payload.is_private_email = claims.isPrivateEmail;

    let token = new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid: keys.kid })
      .setIssuer(claims.issuer ?? PROVIDER_ENDPOINTS[provider].issuers[0] ?? "")
      .setAudience(claims.audience ?? defaultAudience[provider])
      .setIssuedAt(nowSeconds - 10)
      .setExpirationTime(nowSeconds + (claims.expiresInSeconds ?? 300));
    // `null` means "mint a token with no subject at all", which is different
    // from "use the default subject".
    if (claims.subject !== null) token = token.setSubject(claims.subject ?? `${provider}-sub-1`);
    return await token.sign(keys.privateKey);
  };

  return {
    sign: (provider, claims = {}) => signWith(signers[provider], provider, claims),
    signWithForeignKey: (provider, claims = {}) => signWith(foreign, provider, claims),
    keyResolvers: {
      apple: createLocalJWKSet({ keys: [apple.publicJwk] }),
      google: createLocalJWKSet({ keys: [google.publicJwk] }),
    },
    config,
  };
}

interface KeyPair {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: Record<string, unknown>;
}

async function createKeyPair(kid: string): Promise<KeyPair> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  return { kid, privateKey, publicJwk };
}
