/**
 * The payment provider webhook.
 *
 * The provider owns this payload's shape, so the contract fixes only what the
 * API depends on: an event ID to deduplicate against and a type to dispatch
 * on. Everything else passes through to the provider's own parser.
 */

import { z } from "zod";

/** No provider is selected yet. A fake one carries the flow until one is. */
export const paymentProvider = z.enum(["fake"]);

/** Header carrying the provider's payload signature. Verified before parsing. */
export const WEBHOOK_SIGNATURE_HEADER = "x-payment-signature";

export const paymentWebhookRequest = z.looseObject({
  /** Deduplicated exactly like a client idempotency key. */
  id: z.string().min(1),
  type: z.string().min(1),
});

export const paymentWebhookResponse = z.object({
  /** True when this event ID had already been processed, so nothing happened. */
  duplicate: z.boolean(),
});

export type PaymentProvider = z.infer<typeof paymentProvider>;
export type PaymentWebhookRequest = z.infer<typeof paymentWebhookRequest>;
export type PaymentWebhookResponse = z.infer<typeof paymentWebhookResponse>;
