/**
 * The provider boundary, without a database.
 *
 * These are the properties the funding flow depends on and cannot establish
 * for itself: that a signature is over bytes, that a hold starts unconfirmed,
 * and that a redelivery is the same event rather than a second one.
 */

import { describe, expect, it } from "vitest";

import { AppError } from "../src/errors/app-error.ts";
import {
  FAKE_AUTHORIZATION_FAILED,
  FAKE_AUTHORIZATION_SUCCEEDED,
  FakePaymentProvider,
} from "../src/payments/fake-provider.ts";

const NOW = new Date("2026-01-05T00:00:00Z");

function provider() {
  return new FakePaymentProvider({ webhookSecret: "shhh", now: () => NOW });
}

async function authorized() {
  const fake = provider();
  const authorization = await fake.authorizeDeposit({
    reference: "intent-1",
    customerReference: "account-1",
    amount: { amountMinorUnits: 5000, currency: "USD" },
  });
  return { fake, authorization };
}

describe("authorizing a deposit", () => {
  it("leaves the hold unconfirmed until the provider says otherwise", async () => {
    const { fake, authorization } = await authorized();

    expect(await fake.getTransactionStatus(authorization.authorizationId)).toMatchObject({
      state: "pending",
      amount: { amountMinorUnits: 5000, currency: "USD" },
    });
  });

  it("reports when the hold expires, so renewal has something to work from", async () => {
    const { authorization } = await authorized();

    expect(authorization.expiresAt.getTime()).toBe(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
  });

  it("saves an instrument whose fingerprint is stable across authorizations", async () => {
    const fake = provider();
    const command = {
      reference: "intent-1",
      customerReference: "account-1",
      amount: { amountMinorUnits: 5000, currency: "USD" },
    };
    const first = await fake.authorizeDeposit(command);
    const second = await fake.authorizeDeposit({ ...command, reference: "intent-2" });

    const one = await fake.getPaymentInstrument(first.authorizationId);
    const two = await fake.getPaymentInstrument(second.authorizationId);
    // Two holds, two instrument records, one card. Recovery deduplication is
    // built on the fingerprint for exactly this reason.
    expect(one.paymentMethodId).not.toBe(two.paymentMethodId);
    expect(one.fingerprint).toBe(two.fingerprint);
  });
});

describe("verifying a delivery", () => {
  it("accepts the provider's own signature over the exact bytes", async () => {
    const { fake, authorization } = await authorized();
    const delivery = fake.deliver(authorization.authorizationId, "succeeded");

    expect(fake.verifyWebhook(delivery.body, delivery.signature)).toMatchObject({
      type: FAKE_AUTHORIZATION_SUCCEEDED,
    });
  });

  it("refuses a payload edited in flight, even though it still parses", async () => {
    const { fake, authorization } = await authorized();
    const delivery = fake.deliver(authorization.authorizationId, "succeeded");
    const tampered = delivery.body.replace(FAKE_AUTHORIZATION_SUCCEEDED, FAKE_AUTHORIZATION_FAILED);

    expect(JSON.parse(tampered)).toMatchObject({ type: FAKE_AUTHORIZATION_FAILED });
    expect(() => fake.verifyWebhook(tampered, delivery.signature)).toThrow(
      expect.objectContaining({ code: "webhook_signature_invalid" }),
    );
  });

  it("refuses a delivery with no signature at all", async () => {
    const { fake, authorization } = await authorized();
    const delivery = fake.deliver(authorization.authorizationId, "succeeded");

    expect(() => fake.verifyWebhook(delivery.body, undefined)).toThrow(AppError);
  });

  it("refuses a signature signed with another secret", async () => {
    const { fake, authorization } = await authorized();
    const delivery = fake.deliver(authorization.authorizationId, "succeeded");
    const impostor = new FakePaymentProvider({ webhookSecret: "not-the-secret", now: () => NOW });

    expect(() => fake.verifyWebhook(delivery.body, impostor.sign(delivery.body))).toThrow(
      expect.objectContaining({ code: "webhook_signature_invalid" }),
    );
  });
});

describe("redelivery", () => {
  it("repeats the same event rather than emitting a second one", async () => {
    const { fake, authorization } = await authorized();

    const first = fake.deliver(authorization.authorizationId, "succeeded");
    const second = fake.deliver(authorization.authorizationId, "succeeded");

    expect(second).toEqual(first);
    expect(fake.verifyWebhook(second.body, second.signature).id).toBe(
      fake.verifyWebhook(first.body, first.signature).id,
    );
  });
});

describe("the operations the funding flow never reaches", () => {
  it("cannot capture a hold the provider has not confirmed", async () => {
    const { fake, authorization } = await authorized();

    await expect(
      fake.captureAuthorization(authorization.authorizationId, {
        amountMinorUnits: 5000,
        currency: "USD",
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "payment_declined" }));
  });

  it("releases a confirmed hold without charging anything", async () => {
    const { fake, authorization } = await authorized();
    fake.deliver(authorization.authorizationId, "succeeded");

    await fake.releaseAuthorization(authorization.authorizationId);

    expect(await fake.getTransactionStatus(authorization.authorizationId)).toMatchObject({
      state: "released",
    });
  });

  it("renews only a live hold, and moves its expiry", async () => {
    const { fake, authorization } = await authorized();

    await expect(fake.renewAuthorization(authorization.authorizationId)).rejects.toThrow(AppError);
    fake.deliver(authorization.authorizationId, "succeeded");
    const renewed = await fake.renewAuthorization(authorization.authorizationId);

    expect(renewed.expiresAt.getTime()).toBe(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
  });
});
