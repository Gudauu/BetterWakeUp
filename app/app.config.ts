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
 */

import type { ConfigContext } from "expo/config";

/** The reversed iOS client ID, which is what Google's URL scheme has to be. */
const IOS_URL_SCHEME_PREFIX = "com.googleusercontent.apps.";

// The return type is the context's own config type rather than `ExpoConfig`,
// because what this function returns is the merged result of `app.json` and is
// not required to restate the fields `app.json` already carries.
export default ({ config }: ConfigContext): ConfigContext["config"] => {
  const iosUrlScheme = process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME;
  const plugins = [...(config.plugins ?? [])];

  if (iosUrlScheme?.startsWith(IOS_URL_SCHEME_PREFIX) === true) {
    plugins.push(["@react-native-google-signin/google-signin", { iosUrlScheme }]);
  }

  return { ...config, plugins };
};
