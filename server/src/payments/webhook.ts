/**
 * The payment webhook: where a funded challenge actually begins.
 *
 * The architecture's rule is one sentence long and everything here exists to
 * keep it: a funded challenge becomes active on the provider's webhook
 * confirming the authorization succeeded, never on a client callback. A client
 * can lie about a payment or die halfway through one, so no route a client can
 * reach creates a funded challenge, and the only code that does is below.
 *
 * Four properties carry that.
 *
 * **Nothing parses an unverified payload.** The signature is checked over the
 * raw bytes by the route's signature verifier, before validation and before any
 * handler runs. What reaches this module is a verified event or nothing.
 *
 * **A delivery is applied at most once.** The provider's event ID goes into
 * `payment_provider_events` under a unique index inside the same transaction as
 * the effect, so a retried delivery loses the insert and changes nothing. The
 * duplicate is answered 200, because a provider told it failed will keep
 * retrying an event that was already applied.
 *
 * **What is materialized is what was authorized.** The configuration comes from
 * the stored funding intent, keyed by the provider's own authorization
 * identifier. Nothing in the delivery describes the challenge, so a forged or
 * mangled payload cannot change the terms even if it verified.
 *
 * **Nothing is captured.** The only ledger movement is `deposit_authorized`,
 * which records a hold. Capture happens in settlement, in issue 25, and no path
 * from here reaches it.
 */

import { challengeConfiguration, type PaymentWebhookResponse } from "@betterwakeup/contract";
import { and, eq } from "drizzle-orm";

import { hasOpenChallenge, lockAccount, materializeChallenge } from "../challenges/materialize.ts";
import { planChallenge } from "../challenges/plan.ts";
import type { Database } from "../db/client.ts";
import { fundingIntents } from "../db/schema/funding.ts";
import { ledgerEntries, ledgerTransactions, paymentProviderEvents } from "../db/schema/payments.ts";
import { AppError } from "../errors/app-error.ts";
import type { Transaction } from "../idempotency/service.ts";
import type { Logger } from "../observability/logger.ts";
import { FAKE_AUTHORIZATION_FAILED, FAKE_AUTHORIZATION_SUCCEEDED } from "./fake-provider.ts";
import type { PaymentProviderClient, ProviderWebhookEvent } from "./provider.ts";

export interface WebhookDependencies {
  readonly db: Database;
  readonly provider: PaymentProviderClient;
  /** The clock the challenge is activated and scheduled from. */
  readonly now?: (() => Date) | undefined;
}

export async function handleProviderEvent(
  deps: WebhookDependencies,
  event: ProviderWebhookEvent,
  logger: Logger,
): Promise<PaymentWebhookResponse> {
  const at = (deps.now ?? (() => new Date()))();

  return await deps.db.transaction(async (tx) => {
    const [recorded] = await tx
      .insert(paymentProviderEvents)
      .values({
        provider: deps.provider.name,
        eventId: event.id,
        type: event.type,
        payload: event.payload,
        receivedAt: at,
      })
      .onConflictDoNothing()
      .returning({ id: paymentProviderEvents.id });
    if (recorded === undefined) {
      // Recorded before, so its effect was applied before. Answering anything
      // other than success would buy an unbounded retry of work already done.
      logger.info("provider event already applied", { command: "receivePaymentWebhook" });
      return { duplicate: true };
    }

    await apply(tx, deps, event, at, logger);

    await tx
      .update(paymentProviderEvents)
      .set({ processedAt: at })
      .where(eq(paymentProviderEvents.id, recorded.id));
    return { duplicate: false };
  });
}

async function apply(
  tx: Transaction,
  deps: WebhookDependencies,
  event: ProviderWebhookEvent,
  at: Date,
  logger: Logger,
): Promise<void> {
  if (event.type !== FAKE_AUTHORIZATION_SUCCEEDED && event.type !== FAKE_AUTHORIZATION_FAILED) {
    // Providers emit far more than the product acts on. An unhandled type is
    // still recorded, so reconciliation can see everything that arrived.
    logger.info("provider event ignored", { command: "receivePaymentWebhook" });
    return;
  }

  const authorizationId = authorizationIdOf(event);
  const [intent] = await tx
    .select()
    .from(fundingIntents)
    .where(
      and(
        eq(fundingIntents.provider, deps.provider.name),
        eq(fundingIntents.providerAuthorizationId, authorizationId),
      ),
    )
    .for("update")
    .limit(1);

  if (intent === undefined) {
    // A hold this deployment never asked for. Recorded and ignored rather than
    // retried: no amount of redelivery will produce the intent it needs.
    logger.warn("provider event names no funding intent", { command: "receivePaymentWebhook" });
    return;
  }
  if (intent.status !== "pending") {
    // A second, differently-identified delivery for an intent already settled.
    // The event dedupe cannot catch this one, so the intent's own status does.
    logger.info("funding intent already settled", { command: "receivePaymentWebhook" });
    return;
  }

  if (event.type === FAKE_AUTHORIZATION_FAILED) {
    await tx
      .update(fundingIntents)
      .set({ status: "failed", settledAt: at })
      .where(eq(fundingIntents.id, intent.id));
    logger.info("deposit authorization failed", {
      command: "receivePaymentWebhook",
      result: "failed",
    });
    return;
  }

  await activate(tx, intent, at, logger);
}

type FundingIntentRow = typeof fundingIntents.$inferSelect;

/**
 * The authorization succeeded, so the challenge the user agreed to starts now.
 *
 * "Now" is the confirming instant rather than the instant the intent was
 * created: the challenge did not exist until this moment, so a user who left
 * the payment sheet open is not handed a first deadline that already passed.
 */
async function activate(
  tx: Transaction,
  intent: FundingIntentRow,
  at: Date,
  logger: Logger,
): Promise<void> {
  await lockAccount(tx, intent.accountId);

  // The funding intent refused an account that already held a challenge, and
  // the account lock is what keeps that answer true. This is the case where the
  // account acquired one between the intent and the confirmation, which the
  // zero deposit door can still do. The provider cannot be told to try again
  // later, so the intent fails: the hold is never confirmed as a challenge and
  // expires having charged nothing.
  if (await hasOpenChallenge(tx, intent.accountId)) {
    await tx
      .update(fundingIntents)
      .set({ status: "failed", settledAt: at })
      .where(eq(fundingIntents.id, intent.id));
    logger.warn("authorization confirmed for an account that already holds a challenge", {
      command: "receivePaymentWebhook",
      result: "failed",
    });
    return;
  }

  const configuration = challengeConfiguration.safeParse(intent.configuration);
  if (!configuration.success) {
    throw new AppError(
      "internal_error",
      `a stored funding intent's configuration does not match the contract: ${configuration.error.message}`,
      { cause: configuration.error },
    );
  }

  const challengeId = await materializeChallenge(tx, {
    accountId: intent.accountId,
    configuration: configuration.data,
    policyVersion: intent.policyVersion,
    plan: planChallenge(configuration.data, at),
    activatedAt: at,
  });

  await tx
    .update(fundingIntents)
    .set({ status: "authorized", challengeId, settledAt: at })
    .where(eq(fundingIntents.id, intent.id));

  await recordAuthorizedDeposit(tx, intent, challengeId, at);

  logger.info("funded challenge activated", {
    command: "receivePaymentWebhook",
    result: "activated",
    challengeId,
  });
}

/**
 * The ledger movement for a hold.
 *
 * A hold is not revenue and not a fee: it is value the user has committed and
 * value the provider is holding, so it is a debit to `user_commitment` against
 * a credit to `payment_processor`. The two sum to zero, which is what the
 * deferred balance trigger checks at commit, and no `platform_revenue` entry
 * exists anywhere on this path because nothing has been captured.
 */
async function recordAuthorizedDeposit(
  tx: Transaction,
  intent: FundingIntentRow,
  challengeId: string,
  at: Date,
): Promise<void> {
  const [transaction] = await tx
    .insert(ledgerTransactions)
    .values({
      challengeId,
      accountId: intent.accountId,
      kind: "deposit_authorized",
      occurredAt: at,
      providerReference: intent.providerAuthorizationId,
    })
    .returning({ id: ledgerTransactions.id });
  if (transaction === undefined) {
    throw new AppError("internal_error", "the ledger transaction insert returned no row");
  }

  await tx.insert(ledgerEntries).values([
    {
      transactionId: transaction.id,
      ledgerAccount: "user_commitment",
      amountMinorUnits: intent.depositMinorUnits,
      currency: intent.depositCurrency,
    },
    {
      transactionId: transaction.id,
      ledgerAccount: "payment_processor",
      amountMinorUnits: -intent.depositMinorUnits,
      currency: intent.depositCurrency,
    },
  ]);
}

/**
 * The authorization the delivery is about.
 *
 * A verified event whose payload does not name one is the provider's bug or
 * ours, never the caller's, so it is reported as internal and the transaction
 * rolls back: the event is left unrecorded, which means a redelivery after a
 * fix still applies.
 */
function authorizationIdOf(event: ProviderWebhookEvent): string {
  const data = event.payload.data;
  const authorizationId =
    typeof data === "object" && data !== null
      ? (data as Record<string, unknown>).authorizationId
      : undefined;
  if (typeof authorizationId !== "string" || authorizationId === "") {
    throw new AppError("internal_error", "a verified provider event names no authorization");
  }
  return authorizationId;
}
