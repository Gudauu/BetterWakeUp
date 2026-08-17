/**
 * What the server needs to know before it can verify anybody.
 *
 * The issuers and JWKS locations are properties of Apple and Google, so they
 * are constants here rather than configuration nobody would ever change. The
 * audiences are properties of *our* applications (a bundle identifier, an
 * OAuth client), so they are the one part that has to come from the
 * environment, and the server refuses to start without them rather than
 * verifying tokens against an empty audience list, which accepts everything.
 */

import type { IdentityProvider } from "@betterwakeup/contract";

export interface ProviderConfig {
  /**
   * Every `iss` value the provider mints. Google issues both spellings of its
   * own name and has done for years, so a single-issuer check rejects real
   * tokens at random.
   */
  readonly issuers: readonly string[];
  /** The audiences that are us. Never empty: see `parseAudiences`. */
  readonly audiences: readonly string[];
  /** Where the provider publishes its signing keys. */
  readonly jwksUri: string;
}

export type ProviderConfigs = Readonly<Record<IdentityProvider, ProviderConfig>>;

export interface AuthConfig {
  readonly providers: ProviderConfigs;
  /** The secret the server's own session tokens are signed with. */
  readonly sessionSecret: string;
  /** How long an issued session lives. */
  readonly sessionTtlSeconds: number;
}

/** Fixed properties of each provider, independent of our deployment. */
export const PROVIDER_ENDPOINTS: Readonly<
  Record<IdentityProvider, Pick<ProviderConfig, "issuers" | "jwksUri">>
> = {
  apple: {
    issuers: ["https://appleid.apple.com"],
    jwksUri: "https://appleid.apple.com/auth/keys",
  },
  google: {
    // Google's OpenID discovery document names the URL form, and its tokens
    // have long carried the bare host as well. Both are Google.
    issuers: ["https://accounts.google.com", "accounts.google.com"],
    jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
  },
};

/**
 * Thirty days.
 *
 * Long enough that a user who opens the app for one task a day is never
 * signed out mid-challenge, and short enough that a stolen device stops
 * working within the length of the shortest challenge worth stealing. The
 * session row is the revocation point, so this bound only matters for a
 * session nobody thought to revoke.
 */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** A session token minted for one deployment must not verify against another. */
export const SESSION_ISSUER = "betterwakeup";
export const SESSION_AUDIENCE = "betterwakeup-app";

/**
 * The shortest secret worth having: 32 bytes of entropy, hex-encoded. Stated
 * as a length check because that is the part a deployment can get wrong by
 * pasting a placeholder.
 */
const MINIMUM_SESSION_SECRET_LENGTH = 32;

export interface AuthEnvironment {
  readonly APPLE_AUDIENCES?: string | undefined;
  readonly GOOGLE_AUDIENCES?: string | undefined;
  readonly SESSION_SECRET?: string | undefined;
}

/**
 * Read the deployment-specific half of the configuration.
 *
 * Every failure here is a deployment that would run but authenticate nobody
 * correctly, so each one throws with the variable named.
 */
export function loadAuthConfig(env: AuthEnvironment): AuthConfig {
  const sessionSecret = env.SESSION_SECRET ?? "";
  if (sessionSecret.length < MINIMUM_SESSION_SECRET_LENGTH) {
    throw new Error(`SESSION_SECRET must be at least ${MINIMUM_SESSION_SECRET_LENGTH} characters.`);
  }

  return {
    providers: {
      apple: {
        ...PROVIDER_ENDPOINTS.apple,
        audiences: parseAudiences("APPLE_AUDIENCES", env.APPLE_AUDIENCES),
      },
      google: {
        ...PROVIDER_ENDPOINTS.google,
        audiences: parseAudiences("GOOGLE_AUDIENCES", env.GOOGLE_AUDIENCES),
      },
    },
    sessionSecret,
    sessionTtlSeconds: SESSION_TTL_SECONDS,
  };
}

/**
 * A comma-separated list, because one provider maps to several client
 * identifiers: Apple has a bundle identifier and a service identifier, and
 * Google issues a separate client per platform.
 */
function parseAudiences(variable: string, raw: string | undefined): readonly string[] {
  const audiences = (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (audiences.length === 0) {
    throw new Error(`${variable} must list at least one audience.`);
  }
  return audiences;
}
