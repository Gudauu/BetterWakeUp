/**
 * Sign in with Apple.
 *
 * Apple returns the display name only on the very first authorization for an
 * application, and never again, so it is forwarded when it is there and the
 * request omits it otherwise. It is a display string and nothing else: the
 * account is keyed on the provider `sub` the server reads out of the token.
 *
 * The email address is deliberately not forwarded at all. Apple may issue a
 * private relay address, the server discards one when it sees it, and the app
 * has no use for the value in either case.
 */

import * as AppleAuthentication from "expo-apple-authentication";
import { Platform } from "react-native";
import type { ProviderCredential, ProviderSignIn } from "./provider-sign-in.ts";

/** Apple's own code for "the user dismissed the sheet". */
const CANCELLED = "ERR_REQUEST_CANCELED";

export function createAppleSignIn(): ProviderSignIn {
  return {
    async isAvailable() {
      // The module answers false off iOS, but asking the native side on
      // Android costs a bridge call to learn something the platform already
      // says.
      if (Platform.OS !== "ios") {
        return false;
      }
      return AppleAuthentication.isAvailableAsync();
    },

    async authenticate(): Promise<ProviderCredential | null> {
      let credential: AppleAuthentication.AppleAuthenticationCredential;
      try {
        credential = await AppleAuthentication.signInAsync({
          requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME],
        });
      } catch (cause) {
        if (isCancellation(cause)) {
          return null;
        }
        throw cause;
      }

      if (credential.identityToken === null) {
        // Without a token there is nothing to verify, so this is a failure and
        // not a silent no-op that would leave the user on the same screen with
        // no explanation.
        throw new Error("Apple returned no identity token.");
      }

      const displayName = formatName(credential.fullName);
      return {
        provider: "apple",
        idToken: credential.identityToken,
        ...(displayName === undefined ? {} : { displayName }),
      };
    },
  };
}

function isCancellation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === CANCELLED
  );
}

/**
 * Apple hands back the name in parts, any of which may be absent, and the
 * contract caps the field at 120 characters. An empty result is no name rather
 * than an empty string, which the contract's `min(1)` would reject.
 */
function formatName(
  fullName: AppleAuthentication.AppleAuthenticationFullName | null,
): string | undefined {
  if (fullName === null) {
    return undefined;
  }
  const joined = [fullName.givenName, fullName.familyName]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim())
    .join(" ");
  return joined.length === 0 ? undefined : joined.slice(0, 120);
}
