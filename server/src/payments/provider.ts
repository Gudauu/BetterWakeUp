/**
 * The payment provider boundary.
 *
 * The architecture asks for a narrow interface and a fake implementation of it
 * until legal counsel and a processor approve the exact funds flow. Narrow is
 * the load-bearing word: every operation here is one the product actually
 * performs, expressed in the product's own vocabulary, so swapping the fake for
 * a real processor is a new implementation of this file's contract rather than
 * a rewrite of the domain.
 *
 * Two rules hold across every implementation.
 *
 * **Authorizing is not charging.** `authorizeDeposit` puts a hold on a card and
 * saves the instrument for later off-session use. It moves no money, costs no
 * processing fee, and is undone by `releaseAuthorization` at no cost. Money
 * moves only through `captureAuthorization` or `chargeOffSession`, and neither
 * is reachable from the funding path.
 *
 * **The provider is not the record.** Nothing here writes to the database, and
 * a provider's answer is evidence rather than truth: the ledger and the payment
 * commands are what the product acts on. That is why `getTransactionStatus`
 * exists at all, since reconciliation is a comparison between two records that
 * are allowed to disagree.
 */

/** An amount in minor units, so no part of the system needs a rounding rule. */
export interface Money {
  readonly amountMinorUnits: number;
  readonly currency: string;
}

export interface AuthorizeDepositCommand {
  /**
   * Our own identifier for what is being authorized, passed to the provider as
   * metadata and returned on its webhook. This is what lets a delivery be
   * matched to the exact terms the user accepted rather than to an amount.
   */
  readonly reference: string;
  /** Our account identifier, so the provider's customer maps back to a person. */
  readonly customerReference: string;
  readonly amount: Money;
  /**
   * An instrument the provider has already saved, when there is one.
   *
   * Absent on the funding path: the user is at a payment sheet, the instrument
   * does not exist yet, and the hold is confirmed by a webhook after the
   * device completes it. Present when the product takes a hold off-session
   * against a card the user has already given us, which is what replacing a
   * payment method on a running challenge does. An off-session hold needs no
   * device and no delivery, so the returned authorization is already live.
   */
  readonly paymentMethodId?: string | undefined;
}

export interface Authorization {
  /** The provider's identifier for the hold, and the handle for every later operation. */
  readonly authorizationId: string;
  /**
   * Opaque material the app's payment sheet needs to complete the
   * authorization on the device. Never logged and never stored.
   */
  readonly clientSecret: string;
  /**
   * When the hold lapses if it is not renewed. The renewal pass reads this off
   * the recorded authorization; the funding path only records it.
   */
  readonly expiresAt: Date;
}

/** What a provider reports about an authorization that already exists. */
export interface AuthorizationStatus {
  readonly authorizationId: string;
  readonly state: "pending" | "authorized" | "released" | "captured" | "failed";
  readonly amount: Money;
  readonly expiresAt: Date | null;
}

/**
 * The stable identifier for a payment instrument.
 *
 * Stable across authorizations and across accounts, which is what makes it
 * usable for recovery deduplication: the same card presented by a second
 * account is the same fingerprint.
 */
export interface PaymentInstrument {
  readonly paymentMethodId: string;
  readonly fingerprint: string;
}

/** A settlement the provider performed, which the ledger records against. */
export interface Settlement {
  /** The provider's transaction identifier, stored on the ledger transaction. */
  readonly reference: string;
  readonly amount: Money;
}

/** A verified webhook delivery. The payload is the provider's, not ours. */
export interface ProviderWebhookEvent {
  /** The provider's event identifier, deduplicated exactly like a client key. */
  readonly id: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

/**
 * The provider operations the product performs.
 *
 * Every method that reaches a network is async. `verifyWebhook` is not: it is
 * a signature check over bytes we already hold, and making it synchronous is
 * what keeps an unverified payload from being parsed by anything.
 */
export interface PaymentProviderClient {
  /** Matches the contract's `paymentProvider` and the database's enum. */
  readonly name: "fake";

  /** Authorize the deposit and save the instrument for later off-session use. */
  authorizeDeposit(command: AuthorizeDepositCommand): Promise<Authorization>;

  /**
   * Secure the same deposit for a further window.
   *
   * The answer may name a different authorization: a processor that cannot
   * extend a hold takes a replacement one instead, and the caller is then
   * holding two until it releases the old one. Callers must therefore read the
   * returned identifier rather than assume the one they passed in, and must
   * release the old hold only after the replacement is recorded.
   */
  renewAuthorization(authorizationId: string): Promise<Authorization>;

  /** Release a hold. Nothing is charged and no fee attaches. */
  releaseAuthorization(authorizationId: string): Promise<void>;

  /** Capture a live hold. This is the first operation that moves money. */
  captureAuthorization(authorizationId: string, amount: Money): Promise<Settlement>;

  /** Charge the saved instrument when no hold is live. */
  chargeOffSession(paymentMethodId: string, amount: Money): Promise<Settlement>;

  /**
   * Record a forfeit that could not be collected.
   *
   * The product still owes itself a record of the obligation, so an
   * uncollectable charge becomes a recorded forfeit rather than a dropped one.
   */
  recordUncollectedForfeit(reference: string, amount: Money): Promise<Settlement>;

  /** Verify a delivery's signature over its raw bytes, before anything parses it. */
  verifyWebhook(rawBody: string, signature: string | undefined): ProviderWebhookEvent;

  /** Look up what the provider believes, for reconciliation against the ledger. */
  getTransactionStatus(authorizationId: string): Promise<AuthorizationStatus>;

  /** The instrument behind an authorization, for recovery deduplication. */
  getPaymentInstrument(authorizationId: string): Promise<PaymentInstrument>;
}
