/**
 * The parts of the app configuration that depend on the build environment.
 *
 * `app.json` holds everything static; this file adds what a particular build
 * has been given. Expo reads `app.json` first and hands it in as `config`, so
 * nothing here restates what is already there.
 *
 * The only such thing today is Google Sign-In on iOS. Its config plugin writes
 * the reversed iOS client ID into the URL schemes and refuses anything that is
 * not one, so a build with no Google project must not add the plugin at all.
 * That matches what the app does at runtime: with no client ID configured,
 * `createGoogleSignIn` reports itself unavailable and the button is not shown.
 *
 * The scheme is derived from the iOS client ID rather than stated beside it,
 * because the two are the same string written two ways and a hand-flipped copy
 * is a build that fails on the device rather than at configuration time.
 */

import type { ConfigContext } from "expo/config";

/** The reversed iOS client ID, which is what Google's URL scheme has to be. */
const IOS_URL_SCHEME_PREFIX = "com.googleusercontent.apps.";

/** What every Google client ID ends with, and what reversing moves to the front. */
const GOOGLE_CLIENT_ID_SUFFIX = ".apps.googleusercontent.com";

/**
 * Flip the halves of an iOS client ID: `1234-abc.apps.googleusercontent.com`
 * becomes `com.googleusercontent.apps.1234-abc`. Anything that is not a Google
 * client ID yields nothing, which leaves the plugin out rather than adding it
 * with a scheme iOS would never call back on.
 */
function reverseClientId(clientId: unknown): string | undefined {
  if (typeof clientId !== "string" || !clientId.endsWith(GOOGLE_CLIENT_ID_SUFFIX)) {
    return undefined;
  }
  return `${IOS_URL_SCHEME_PREFIX}${clientId.slice(0, -GOOGLE_CLIENT_ID_SUFFIX.length)}`;
}

// The return type is the context's own config type rather than `ExpoConfig`,
// because what this function returns is the merged result of `app.json` and is
// not required to restate the fields `app.json` already carries.
export default ({ config }: ConfigContext): ConfigContext["config"] => {
  // The environment wins, so a build can be pointed at another Google project
  // without editing `app.json`; otherwise the scheme follows the client ID the
  // manifest already carries.
  const iosUrlScheme =
    process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME ??
    reverseClientId(config.extra?.googleIosClientId);
  const plugins = [...(config.plugins ?? [])];

  if (iosUrlScheme?.startsWith(IOS_URL_SCHEME_PREFIX) === true) {
    plugins.push(["@react-native-google-signin/google-signin", { iosUrlScheme }]);
  }

  return { ...config, plugins };
};
