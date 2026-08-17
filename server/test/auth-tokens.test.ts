/**
 * Issue 13's verification half: what a provider token has to satisfy before
 * it becomes an identity, and what the session token the server issues in
 * exchange is worth.
 *
 * The acceptance boundary names three rejections (expired, wrong audience,
 * wrong issuer) and one storage rule (no Apple private relay address reaches
 * an identity column). The first three are here; the fourth is checked twice,
 * once here at the boundary that discards it and once in the integration
 * suite against the column itself.
 */

import { SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { loadAuthConfig, SESSION_TTL_SECONDS } from "../src/auth/config.ts";
import { createProviderTokenVerifier } from "../src/auth/provider-tokens.ts";
import {
  hashSessionToken,
  mintSessionToken,
  verifySessionToken,
} from "../src/auth/session-token.ts";
import { AppError } from "../src/errors/app-error.ts";
import {
  APPLE_AUDIENCE,
  createProviderKeys,
  type ProviderKeys,
  TEST_SESSION_SECRET,
} from "./support/provider-tokens.ts";

let keys: ProviderKeys;

beforeAll(async () => {
  keys = await createProviderKeys();
});

function verifier() {
  return createProviderTokenVerifier({
    providers: keys.config.providers,
    keyResolvers: keys.keyResolvers,
  });
}

async function expectRejection(promise: Promise<unknown>): Promise<AppError> {
  const thrown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(AppError);
  return thrown as AppError;
}

describe("provider token verification", () => {
  it("accepts a well-formed Apple token and takes sub as the identity", async () => {
    const token = await keys.sign("apple", { subject: "apple-user-42" });
    const identity = await verifier().verify("apple", token);

    expect(identity).toEqual({
      provider: "apple",
      issuer: "https://appleid.apple.com",
      subject: "apple-user-42",
      email: null,
    });
  });

  it("accepts either spelling of Google's issuer", async () => {
    for (const issuer of ["https://accounts.google.com", "accounts.google.com"]) {
      const token = await keys.sign("google", { issuer });
      const identity = await verifier().verify("google", token);
      expect(identity.issuer).toBe(issuer);
    }
  });

  it("rejects an expired token", async () => {
    const token = await keys.sign("apple", { expiresInSeconds: -60 });
    const error = await expectRejection(verifier().verify("apple", token));

    expect(error.code).toBe("unauthenticated");
    expect(error.status).toBe(401);
    expect(error.message).toContain("expired");
  });

  it("rejects a token minted for another audience", async () => {
    const token = await keys.sign("apple", { audience: "com.someone.else" });
    const error = await expectRejection(verifier().verify("apple", token));

    expect(error.code).toBe("unauthenticated");
    expect(error.message).toContain("aud");
  });

  it("rejects a token minted by another issuer", async () => {
    const token = await keys.sign("apple", { issuer: "https://appleid.apple.com.evil.test" });
    const error = await expectRejection(verifier().verify("apple", token));

    expect(error.code).toBe("unauthenticated");
    expect(error.message).toContain("iss");
  });

  it("rejects a Google token presented as an Apple one", async () => {
    // Same signature, same shape; only the configuration it is checked
    // against differs, which is why the provider comes from the request and
    // never from the token.
    const token = await keys.sign("google");
    const error = await expectRejection(verifier().verify("apple", token));

    expect(error.code).toBe("unauthenticated");
  });

  it("rejects a token signed with a key the provider does not publish", async () => {
    const token = await keys.signWithForeignKey("apple");
    const error = await expectRejection(verifier().verify("apple", token));

    expect(error.code).toBe("unauthenticated");
  });

  it("rejects a symmetric token, which a public key would otherwise verify", async () => {
    // The published JWKS is public, so an unrestricted algorithm list turns
    // "anyone can read Apple's key" into "anyone can mint an Apple token".
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("https://appleid.apple.com")
      .setAudience(APPLE_AUDIENCE)
      .setSubject("apple-user-42")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("whatever the attacker likes"));

    const error = await expectRejection(verifier().verify("apple", forged));
    expect(error.code).toBe("unauthenticated");
  });

  it("rejects a token that carries no subject", async () => {
    const token = await keys.sign("apple", { subject: null });
    const error = await expectRejection(verifier().verify("apple", token));

    expect(error.code).toBe("unauthenticated");
    expect(error.message).toContain("subject");
  });

  it("rejects text that is not a token at all", async () => {
    const error = await expectRejection(verifier().verify("apple", "not-a-token"));
    expect(error.code).toBe("unauthenticated");
  });

  it("calls an unreachable JWKS our failure rather than the caller's", async () => {
    const failing = createProviderTokenVerifier({
      providers: keys.config.providers,
      keyResolvers: {
        apple: () => {
          throw new TypeError("fetch failed");
        },
      },
    });

    const error = await expectRejection(failing.verify("apple", await keys.sign("apple")));
    // Telling every user their credential is bad while Apple is unreachable
    // would send the whole install base through a sign-in that cannot work.
    expect(error.code).toBe("internal_error");
    expect(error.status).toBe(500);
  });
});

describe("the email a verified token yields", () => {
  it("keeps a verified address", async () => {
    const token = await keys.sign("google", { email: "person@example.com", emailVerified: true });
    const identity = await verifier().verify("google", token);
    expect(identity.email).toBe("person@example.com");
  });

  it("accepts Apple's string form of email_verified", async () => {
    const token = await keys.sign("apple", { email: "person@example.com", emailVerified: "true" });
    const identity = await verifier().verify("apple", token);
    expect(identity.email).toBe("person@example.com");
  });

  it("drops an address the provider has not verified", async () => {
    const token = await keys.sign("google", { email: "person@example.com", emailVerified: false });
    const identity = await verifier().verify("google", token);
    expect(identity.email).toBeNull();
  });

  it("drops an Apple private relay address by its domain", async () => {
    const token = await keys.sign("apple", {
      email: "abc123def@privaterelay.appleid.com",
      emailVerified: "true",
    });
    const identity = await verifier().verify("apple", token);
    expect(identity.email).toBeNull();
  });

  it("drops an address Apple flags as private even off the relay domain", async () => {
    const token = await keys.sign("apple", {
      email: "person@example.com",
      emailVerified: "true",
      isPrivateEmail: "true",
    });
    const identity = await verifier().verify("apple", token);
    expect(identity.email).toBeNull();
  });
});

describe("session tokens", () => {
  const accountId = "6f1f8a2e-2f9e-4a3e-9a4b-9c2f0f2c1d33";

  it("round-trips the account and session it was minted for", async () => {
    const minted = await mintSessionToken({
      secret: TEST_SESSION_SECRET,
      accountId,
      ttlSeconds: 3600,
    });

    expect(await verifySessionToken(minted.token, TEST_SESSION_SECRET)).toEqual({
      ok: true,
      claims: { accountId, sessionId: minted.sessionId },
    });
  });

  it("expires exactly ttlSeconds after the instant it was minted", async () => {
    const now = new Date("2026-03-01T08:00:00.000Z");
    const minted = await mintSessionToken({
      secret: TEST_SESSION_SECRET,
      accountId,
      ttlSeconds: 60,
      now,
    });

    expect(minted.expiresAt.toISOString()).toBe("2026-03-01T08:01:00.000Z");
  });

  it("refuses a token signed with another secret", async () => {
    const minted = await mintSessionToken({
      secret: TEST_SESSION_SECRET,
      accountId,
      ttlSeconds: 3600,
    });

    expect(await verifySessionToken(minted.token, `${TEST_SESSION_SECRET}-other`)).toEqual({
      ok: false,
      reason: "unusable",
    });
  });

  it("refuses a token whose payload was edited", async () => {
    const minted = await mintSessionToken({
      secret: TEST_SESSION_SECRET,
      accountId,
      ttlSeconds: 3600,
    });
    const [header, payload, signature] = minted.token.split(".");
    const edited = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    edited.sub = "00000000-0000-4000-8000-000000000000";
    const tampered = [
      header,
      Buffer.from(JSON.stringify(edited), "utf8").toString("base64url"),
      signature,
    ].join(".");

    expect(await verifySessionToken(tampered, TEST_SESSION_SECRET)).toEqual({
      ok: false,
      reason: "unusable",
    });
  });

  it("reports an expired token as expired, which is the one refusal the app can act on", async () => {
    const minted = await mintSessionToken({
      secret: TEST_SESSION_SECRET,
      accountId,
      ttlSeconds: 60,
      now: new Date(Date.now() - 10 * 60 * 1000),
    });

    expect(await verifySessionToken(minted.token, TEST_SESSION_SECRET)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("hashes to something stable that is not the token", async () => {
    const minted = await mintSessionToken({
      secret: TEST_SESSION_SECRET,
      accountId,
      ttlSeconds: 60,
    });
    const hash = hashSessionToken(minted.token);

    expect(hash).toBe(hashSessionToken(minted.token));
    expect(hash).toHaveLength(64);
    expect(minted.token).not.toContain(hash);
  });
});

describe("auth configuration", () => {
  const complete = {
    APPLE_AUDIENCES: "com.betterwakeup.app, com.betterwakeup.service",
    GOOGLE_AUDIENCES: "google-client-id",
    SESSION_SECRET: TEST_SESSION_SECRET,
  };

  it("reads a comma-separated audience list per provider", () => {
    const config = loadAuthConfig(complete);

    expect(config.providers.apple.audiences).toEqual([
      "com.betterwakeup.app",
      "com.betterwakeup.service",
    ]);
    expect(config.providers.google.jwksUri).toBe("https://www.googleapis.com/oauth2/v3/certs");
    expect(config.sessionTtlSeconds).toBe(SESSION_TTL_SECONDS);
  });

  it("refuses to start with no audience, which would accept every audience", () => {
    expect(() => loadAuthConfig({ ...complete, APPLE_AUDIENCES: "  ,  " })).toThrow(
      /APPLE_AUDIENCES/,
    );
  });

  it("refuses a session secret short enough to be a placeholder", () => {
    expect(() => loadAuthConfig({ ...complete, SESSION_SECRET: "changeme" })).toThrow(
      /SESSION_SECRET/,
    );
  });
});
