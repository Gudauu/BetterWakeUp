/**
 * Who this deployment's tokens are allowed to be for.
 *
 * `loadAuthConfig` refuses to start without these, because an empty audience
 * list accepts every audience: a token minted for somebody else's application
 * would verify against Apple's or Google's keys and be trusted as ours. They
 * are the one part of the auth configuration that names *us* rather than the
 * provider, so they come from the deployment rather than from a constant in
 * the server.
 *
 * They live here rather than in Parameter Store because none of them is a
 * secret. A client identifier is published in the app binary and in every
 * authorization request; treating one as a credential would mean an encrypted
 * parameter, a read grant, and a startup fetch to protect a string anybody can
 * read off the wire.
 *
 * They are stated rather than read from `app/app.json`, so that synthesizing
 * the infrastructure never depends on the mobile package building. `test/
 * audiences.test.ts` reads that file and asserts every value here still
 * matches it, which is what stops the two copies drifting.
 */

/** The variable each list is delivered in, named as the server reads it. */
export const APPLE_AUDIENCE_VARIABLE = "APPLE_AUDIENCES";
export const GOOGLE_AUDIENCE_VARIABLE = "GOOGLE_AUDIENCES";

/**
 * Apple's audience is the iOS bundle identifier, which is what Sign in with
 * Apple puts in `aud` for a native sign-in. A Services ID would be added here
 * too if the web flow were ever built; there is none today.
 */
export const APPLE_AUDIENCES = ["com.betterwakeup.app"] as const;

/**
 * Google issues a client per platform and mints `aud` as whichever one asked,
 * so both are ours and both must be listed. The web client is also what the
 * native SDKs request an ID token for, so it is the audience most tokens
 * actually carry.
 *
 * Android's client is absent on purpose: it does not exist until EAS prints
 * the keystore fingerprint that creating it requires.
 */
export const GOOGLE_AUDIENCES = [
  "879900379164-ho5rifv7vlriov7vmoen4tq8h219ejol.apps.googleusercontent.com",
  "879900379164-qk8t2idvljam7sss22emvakgntl6fqva.apps.googleusercontent.com",
] as const;

/**
 * The server parses a comma-separated list, because one provider maps to
 * several client identifiers. Joining here rather than at each call site keeps
 * the separator in one place with the parser that has to agree with it.
 */
export function audienceList(audiences: readonly string[]): string {
  return audiences.join(",");
}
