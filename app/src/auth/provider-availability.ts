/**
 * What the welcome screen may offer, once the two native SDKs have been asked
 * whether they work here.
 *
 * Asking is asynchronous and can itself go wrong, which gives three answers per
 * provider rather than two: it works, it does not work here, or the question
 * could not be answered. Folding the third into the second is what this module
 * exists to stop - a provider whose check threw once would otherwise be reported
 * as permanently unavailable, and the only screen that can sign a user in would
 * be a dead end with nothing to press and nothing to retry.
 */

import type { IdentityProvider } from "@betterwakeup/contract";

/** One provider's answer to "can you work on this phone, in this build?". */
export type ProviderCheck = "available" | "unavailable" | "failed";

export type ProviderChecks = Readonly<Record<IdentityProvider, ProviderCheck>>;

/** The native modules have been asked, or are still being asked. */
export type ProviderAvailability =
  | { readonly status: "checking" }
  | { readonly status: "checked"; readonly checks: ProviderChecks };

/**
 * What the screen draws. `unknown` is separate from `unavailable` because only
 * one of them is worth pressing again: a phone that has no Apple and no Google
 * will still have none in a second, while a check that threw may well answer
 * next time.
 */
export type SignInOptions =
  | { readonly kind: "checking"; readonly message: string }
  | { readonly kind: "offered"; readonly providers: readonly IdentityProvider[] }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "unknown"; readonly message: string };

/** Asked in this order, so the button a user expects first is drawn first. */
const PROVIDERS: readonly IdentityProvider[] = ["apple", "google"];

export const CHECKING_MESSAGE = "Checking how you can sign in on this phone.";

/**
 * Said without naming a provider: which of the two is missing is not something
 * the user chose or can change, and the sentence has to hold for an iPhone too
 * old for Sign in with Apple and for an Android build shipped without a Google
 * client ID alike.
 */
export const UNAVAILABLE_MESSAGE =
  "BetterWakeUp signs you in with Apple or Google, and neither one works on this phone. Sign in with Apple needs iOS 13 or later, and Google sign-in needs Google Play services.";

/**
 * The honest wording for a question that was never answered: the app is not
 * saying sign-in is impossible here, only that it could not find out.
 */
export const UNKNOWN_MESSAGE =
  "The app could not work out how to sign you in on this phone. This is usually temporary.";

/**
 * Decide from the checks alone. A provider that answered `available` is offered
 * and nothing is said about the other one: a working button beside a sentence
 * explaining a provider the user was not going to press is noise.
 */
export function signInOptions(availability: ProviderAvailability): SignInOptions {
  if (availability.status === "checking") {
    return { kind: "checking", message: CHECKING_MESSAGE };
  }
  const { checks } = availability;
  const providers = PROVIDERS.filter((provider) => checks[provider] === "available");
  if (providers.length > 0) {
    return { kind: "offered", providers };
  }
  // Nothing can be offered, so the reason decides what the user is told. One
  // unanswered check is enough to make the whole screen a "could not tell",
  // because the provider it belongs to might be the one that works.
  if (PROVIDERS.some((provider) => checks[provider] === "failed")) {
    return { kind: "unknown", message: UNKNOWN_MESSAGE };
  }
  return { kind: "unavailable", message: UNAVAILABLE_MESSAGE };
}
