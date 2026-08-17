/**
 * Google Sign-In.
 *
 * The native SDK is configured from build configuration rather than from code,
 * because the client IDs differ between a development build and a store build.
 * A build with no web client ID cannot obtain an ID token at all, so Google
 * reports itself unavailable and the button is not offered: showing it and
 * failing on the tap tells the user their account is broken when the build is.
 */

import { GoogleSignin } from "@react-native-google-signin/google-signin";
import { Platform } from "react-native";
import type { GoogleClientIds } from "../config.ts";
import type { ProviderCredential, ProviderSignIn } from "./provider-sign-in.ts";

export function createGoogleSignIn(clientIds: GoogleClientIds): ProviderSignIn {
  let configured = false;

  function configure(): boolean {
    if (clientIds.webClientId === undefined) {
      return false;
    }
    if (!configured) {
      // The web client ID is what makes Google mint an ID token whose audience
      // is our own client rather than an opaque access token, which is the only
      // thing the server can verify against Google's JWKS.
      GoogleSignin.configure({
        webClientId: clientIds.webClientId,
        ...(clientIds.iosClientId === undefined ? {} : { iosClientId: clientIds.iosClientId }),
        scopes: ["profile"],
      });
      configured = true;
    }
    return true;
  }

  return {
    async isAvailable() {
      if (!configure()) {
        return false;
      }
      if (Platform.OS !== "android") {
        return true;
      }
      // Android needs Play Services present. The prompt to install them is
      // suppressed here: this call runs while a screen is deciding what to
      // render, and a dialog at that moment would be unexplained.
      try {
        return await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: false });
      } catch {
        return false;
      }
    },

    async authenticate(): Promise<ProviderCredential | null> {
      if (!configure()) {
        throw new Error("Google sign-in is not configured in this build.");
      }
      if (Platform.OS === "android") {
        await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      }

      const response = await GoogleSignin.signIn();
      if (response.type === "cancelled") {
        return null;
      }

      const idToken = response.data.idToken;
      if (idToken === null) {
        throw new Error("Google returned no ID token.");
      }

      const displayName = response.data.user.name?.trim();
      return {
        provider: "google",
        idToken,
        ...(displayName === undefined || displayName.length === 0
          ? {}
          : { displayName: displayName.slice(0, 120) }),
      };
    },
  };
}
