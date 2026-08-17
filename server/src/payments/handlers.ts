/**
 * The payment webhook endpoint and the signature check in front of it.
 *
 * The verifier is deliberately separate from the handler and runs earlier: the
 * route table takes it as the endpoint's authentication, in the same position
 * the session gate occupies for a client command. That ordering is the point.
 * An unsigned or mis-signed delivery is refused before validation parses a
 * field of it, so the only payload the domain ever sees is one the provider
 * proved it sent.
 *
 * The verified event travels on the request context rather than being verified
 * twice. Verifying again in the handler would mean the handler could be mounted
 * without a verifier and still appear to work, which is exactly the failure the
 * route table's mount-time refusal exists to prevent.
 */

import { WEBHOOK_SIGNATURE_HEADER } from "@betterwakeup/contract";
import type { Context } from "hono";

import { AppError } from "../errors/app-error.ts";
import type { AppEnv } from "../http/app.ts";
import type { EndpointHandlers } from "../http/routes.ts";
import type { PaymentProviderClient } from "./provider.ts";
import { handleProviderEvent, type WebhookDependencies } from "./webhook.ts";

/**
 * The signature check the route table runs before anything else.
 *
 * It reads the raw body, because a signature is over bytes and not over a
 * parsed document: re-serializing a payload changes bytes a provider signed.
 */
export function createWebhookSignatureVerifier(
  provider: PaymentProviderClient,
): (c: Context<AppEnv>) => Promise<void> {
  return async (c) => {
    // A delivery addressed to a provider this deployment does not run is
    // refused as unverifiable, since there is no key to check it against.
    const addressed = c.req.param("provider");
    if (addressed !== provider.name) {
      throw new AppError(
        "webhook_signature_invalid",
        "This deployment cannot verify a delivery from that provider.",
      );
    }
    const event = provider.verifyWebhook(
      await c.req.text(),
      c.req.header(WEBHOOK_SIGNATURE_HEADER),
    );
    c.set("providerEvent", event);
  };
}

export function createPaymentHandlers(deps: WebhookDependencies): EndpointHandlers {
  return {
    receivePaymentWebhook: async ({ context, logger }) => {
      const event = context.get("providerEvent");
      if (event === undefined) {
        // The verifier is what puts it there, and the route table refuses to
        // mount this endpoint without one, so an absence here is our bug.
        throw new AppError("internal_error", "the payment webhook ran with no verified event");
      }
      return await handleProviderEvent(
        deps,
        event,
        logger.child({ paymentProvider: deps.provider.name, paymentEventId: event.id }),
      );
    },
  };
}
