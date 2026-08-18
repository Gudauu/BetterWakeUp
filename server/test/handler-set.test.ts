/**
 * What the deployed function actually serves.
 *
 * The app builds its requests from the contract's client endpoint list, so any
 * name on that list the deployment does not mount is an app screen that answers
 * `not_found` against the real API. The whole surface was mounted route by
 * route in its own issue and each was proved through its own suite, but nothing
 * checked that the composition root had picked all of them up, and it had not:
 * the completion endpoint the daily task screen posts to and the deletion
 * endpoint the delete-account screen calls were both absent from the deployed
 * handler set. This is the check that keeps them there.
 *
 * The dependencies here are stubs on purpose: composing the set touches none of
 * them, and a test that needed a database to ask which routes exist would be
 * checking something else.
 */

import { CLIENT_ENDPOINT_NAMES, type ClientEndpointName } from "@betterwakeup/contract";
import { describe, expect, it } from "vitest";

import type { ProviderTokenVerifier } from "../src/auth/provider-tokens.ts";
import type { Database } from "../src/db/index.ts";
import { createHandlerSet } from "../src/lambda/handler-set.ts";
import type { PaymentProviderClient } from "../src/payments/provider.ts";

/**
 * The two endpoints that authorize or re-secure a deposit. They are mounted
 * only where a payment provider is configured, which is the deployment's
 * choice rather than an oversight, so they are named here as the one expected
 * gap and everything else on the client list must be present.
 */
const PROVIDER_ENDPOINTS: readonly ClientEndpointName[] = [
  "createFundingIntent",
  "replacePaymentMethod",
];

const unusedDatabase = {} as Database;
const unusedVerifier = {} as ProviderTokenVerifier;
const unusedProvider = { name: "fake" } as PaymentProviderClient;

function mounted(provider?: PaymentProviderClient): string[] {
  const handlers = createHandlerSet({
    db: unusedDatabase,
    verifier: unusedVerifier,
    sessionSecret: "0123456789abcdef0123456789abcdef",
    sessionTtlSeconds: 3600,
    ...(provider === undefined ? {} : { provider }),
  });
  return Object.keys(handlers).sort();
}

describe("the deployed handler set", () => {
  it("mounts every endpoint the app can call except the two the provider gates", () => {
    const expected = CLIENT_ENDPOINT_NAMES.filter(
      (name) => !PROVIDER_ENDPOINTS.includes(name),
    ).sort();

    expect(mounted()).toEqual(expected);
  });

  it("mounts the funded doors once a payment provider is configured", () => {
    expect(mounted(unusedProvider)).toEqual([...CLIENT_ENDPOINT_NAMES].sort());
  });

  it("never mounts the payment webhook, which no client calls", () => {
    expect(mounted(unusedProvider)).not.toContain("receivePaymentWebhook");
  });
});
