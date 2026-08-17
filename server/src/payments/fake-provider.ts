/**
 * The fake payment provider.
 *
 * It carries the whole funding flow until a real processor is approved, and it
 * is deliberately a full implementation of `PaymentProviderClient` rather than
 * a stub: the point of the boundary is that the domain cannot tell which side
 * of it is real, so a fake that answers only the calls today's code makes would
 * leave the interface unexercised exactly where it is least understood.
 *
 * It models three things a real processor does that a naive stub does not.
 *
 * **Authorizing is asynchronous.** `authorizeDeposit` leaves the hold
 * `pending`. It becomes `authorized` when the provider says so, which happens
 * through a webhook delivery and never through the call's return value. This is
 * what lets the server prove that a client callback alone cannot activate a
 * challenge.
 *
 * **Deliveries are signed over bytes.** The webhook signature is an HMAC over
 * the exact request body, so a payload edited in flight fails verification even
 * though it still parses. Verification is a constant-time comparison, since a
 * byte-at-a-time one leaks the expected signature to anyone willing to send
 * enough requests.
 *
 * **Deliveries repeat.** `deliveryOf` returns the same event body every time it
 * is asked for the same event, which is what makes a retried delivery testable:
 * the second one carries the same event ID and must therefore change nothing.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { AppError } from "../errors/app-error.ts";
import type {
  Authorization,
  AuthorizationStatus,
  AuthorizeDepositCommand,
  Money,
  PaymentInstrument,
  PaymentProviderClient,
  ProviderWebhookEvent,
  Settlement,
} from "./provider.ts";

/** The event types the fake emits, which the webhook handler dispatches on. */
export const FAKE_AUTHORIZATION_SUCCEEDED = "authorization.succeeded";
export const FAKE_AUTHORIZATION_FAILED = "authorization.failed";

/** How long a fresh hold lasts, matching the extended authorization window. */
const AUTHORIZATION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A signed delivery, as it arrives over HTTP. */
export interface FakeDelivery {
  /** The exact bytes to POST. Signed as-is: re-serializing invalidates it. */
  readonly body: string;
  readonly signature: string;
}

interface FakeAuthorization {
  readonly id: string;
  readonly reference: string;
  readonly customerReference: string;
  readonly amount: Money;
  readonly paymentMethodId: string;
  readonly fingerprint: string;
  state: AuthorizationStatus["state"];
  expiresAt: Date;
}

export interface FakeProviderOptions {
  /** The shared secret the provider signs deliveries with. */
  readonly webhookSecret: string;
  /** The clock, so a test can state the instant a hold was taken. */
  readonly now?: (() => Date) | undefined;
}

/**
 * An in-memory provider.
 *
 * One instance is one provider account. Tests hold the instance so they can
 * both drive the API and play the provider's part; the server only ever sees
 * the `PaymentProviderClient` half.
 */
export class FakePaymentProvider implements PaymentProviderClient {
  readonly name = "fake" as const;

  private readonly secret: string;
  private readonly now: () => Date;
  private readonly authorizations = new Map<string, FakeAuthorization>();
  /** Event bodies by event ID, so a redelivery is byte-identical to the first. */
  private readonly deliveries = new Map<string, string>();
  /** Holds whose renewal the issuer refuses, so a decline can be staged. */
  private readonly declinedRenewals = new Set<string>();
  /** Instruments the issuer refuses off-session. */
  private readonly declinedInstruments = new Set<string>();

  constructor(options: FakeProviderOptions) {
    this.secret = options.webhookSecret;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * A hold.
   *
   * With no instrument named this is the funding path: the hold starts
   * `pending` and the device confirms it through a delivery. With one it is
   * off-session, which needs no device, so the hold is live when the call
   * returns and no delivery follows.
   */
  async authorizeDeposit(command: AuthorizeDepositCommand): Promise<Authorization> {
    const offSession = command.paymentMethodId !== undefined;
    if (offSession && this.declinedInstruments.has(command.paymentMethodId ?? "")) {
      throw new AppError("payment_declined", "This instrument was declined.");
    }
    const id = `auth_${randomUUID()}`;
    const authorization: FakeAuthorization = {
      id,
      reference: command.reference,
      customerReference: command.customerReference,
      amount: command.amount,
      paymentMethodId: command.paymentMethodId ?? `pm_${randomUUID()}`,
      // A real fingerprint is a property of the card rather than of the
      // instrument record, so two intents from one test card share one.
      fingerprint: `fp_${command.customerReference}`,
      state: offSession ? "authorized" : "pending",
      expiresAt: new Date(this.now().getTime() + AUTHORIZATION_DAYS * DAY_MS),
    };
    this.authorizations.set(id, authorization);
    return {
      authorizationId: id,
      clientSecret: `${id}_secret_${randomUUID()}`,
      expiresAt: authorization.expiresAt,
    };
  }

  /**
   * A replacement hold on the same instrument.
   *
   * The fake mints a new identifier rather than extending the old hold,
   * because that is the harder of the two behaviors a real processor can have
   * and the one the caller has to be written for: for as long as it takes to
   * record the replacement, the challenge is secured twice. The old hold stays
   * live until it is released, so a caller that forgets to release it leaves a
   * stray hold rather than an unsecured challenge.
   */
  async renewAuthorization(authorizationId: string): Promise<Authorization> {
    const authorization = this.require(authorizationId);
    if (authorization.state !== "authorized") {
      throw new AppError("payment_declined", "Only a live authorization can be renewed.");
    }
    if (this.declinedRenewals.has(authorizationId)) {
      throw new AppError("payment_declined", "The card was declined on renewal.");
    }
    const replacement: FakeAuthorization = {
      ...authorization,
      id: `auth_${randomUUID()}`,
      state: "authorized",
      expiresAt: new Date(this.now().getTime() + AUTHORIZATION_DAYS * DAY_MS),
    };
    this.authorizations.set(replacement.id, replacement);
    return {
      authorizationId: replacement.id,
      clientSecret: `${replacement.id}_secret_renewed`,
      expiresAt: replacement.expiresAt,
    };
  }

  async releaseAuthorization(authorizationId: string): Promise<void> {
    const authorization = this.require(authorizationId);
    authorization.state = "released";
  }

  async captureAuthorization(authorizationId: string, amount: Money): Promise<Settlement> {
    const authorization = this.require(authorizationId);
    if (authorization.state !== "authorized") {
      throw new AppError("payment_declined", "This authorization is not live.");
    }
    authorization.state = "captured";
    return { reference: `cap_${authorizationId}`, amount };
  }

  async chargeOffSession(paymentMethodId: string, amount: Money): Promise<Settlement> {
    return { reference: `chg_${paymentMethodId}`, amount };
  }

  async recordUncollectedForfeit(reference: string, amount: Money): Promise<Settlement> {
    return { reference: `unc_${reference}`, amount };
  }

  verifyWebhook(rawBody: string, signature: string | undefined): ProviderWebhookEvent {
    if (signature === undefined || !this.signatureMatches(rawBody, signature)) {
      throw new AppError("webhook_signature_invalid", "The webhook signature does not verify.");
    }
    const parsed: unknown = JSON.parse(rawBody);
    if (typeof parsed !== "object" || parsed === null) {
      throw new AppError("webhook_signature_invalid", "The webhook payload is not an object.");
    }
    const event = parsed as Record<string, unknown>;
    if (typeof event.id !== "string" || typeof event.type !== "string") {
      throw new AppError("webhook_signature_invalid", "The webhook payload names no event.");
    }
    return { id: event.id, type: event.type, payload: event };
  }

  async getTransactionStatus(authorizationId: string): Promise<AuthorizationStatus> {
    const authorization = this.require(authorizationId);
    return {
      authorizationId,
      state: authorization.state,
      amount: authorization.amount,
      expiresAt: authorization.expiresAt,
    };
  }

  async getPaymentInstrument(authorizationId: string): Promise<PaymentInstrument> {
    const authorization = this.require(authorizationId);
    return {
      paymentMethodId: authorization.paymentMethodId,
      fingerprint: authorization.fingerprint,
    };
  }

  /**
   * The issuer refuses to renew this hold, from now on.
   *
   * A decline is a standing condition rather than a single failure: an expired
   * card declines every attempt, which is what makes "the renewal is retried
   * and the challenge keeps running" testable rather than a one-shot fluke.
   */
  declineRenewalsOf(authorizationId: string): void {
    this.declinedRenewals.add(authorizationId);
  }

  /** The issuer refuses off-session charges on this instrument. */
  declineInstrument(paymentMethodId: string): void {
    this.declinedInstruments.add(paymentMethodId);
  }

  /** The signature the provider would send for these exact bytes. */
  sign(rawBody: string): string {
    return createHmac("sha256", this.secret).update(rawBody).digest("hex");
  }

  /**
   * The provider's own part: the delivery it sends once the device completed,
   * or failed, the authorization.
   *
   * Asking twice for the same authorization and outcome yields the same event
   * ID and the same bytes, which is a redelivery rather than a second event.
   */
  deliver(authorizationId: string, outcome: "succeeded" | "failed"): FakeDelivery {
    const authorization = this.require(authorizationId);
    authorization.state = outcome === "succeeded" ? "authorized" : "failed";

    const id = `evt_${outcome}_${authorizationId}`;
    const existing = this.deliveries.get(id);
    if (existing !== undefined) {
      return { body: existing, signature: this.sign(existing) };
    }

    const body = JSON.stringify({
      id,
      type: outcome === "succeeded" ? FAKE_AUTHORIZATION_SUCCEEDED : FAKE_AUTHORIZATION_FAILED,
      occurredAt: this.now().toISOString(),
      data: {
        authorizationId,
        reference: authorization.reference,
        paymentMethodId: authorization.paymentMethodId,
        amountMinorUnits: authorization.amount.amountMinorUnits,
        currency: authorization.amount.currency,
        expiresAt: authorization.expiresAt.toISOString(),
      },
    });
    this.deliveries.set(id, body);
    return { body, signature: this.sign(body) };
  }

  private signatureMatches(rawBody: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(rawBody), "utf8");
    const given = Buffer.from(signature, "utf8");
    // `timingSafeEqual` throws on a length mismatch, which is itself a leak of
    // nothing useful here: the expected length is fixed and public.
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private require(authorizationId: string): FakeAuthorization {
    const authorization = this.authorizations.get(authorizationId);
    if (authorization === undefined) {
      throw new AppError("not_found", "No authorization with this identifier.");
    }
    return authorization;
  }
}
