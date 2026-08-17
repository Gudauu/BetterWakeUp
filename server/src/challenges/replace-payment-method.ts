/**
 * `POST /challenges/:challengeId/payment-method`: the way back from a failed
 * renewal.
 *
 * A renewal fails because a card expired, was replaced, or was declined, and
 * the sweep's answer is to mark the deposit unsecured and keep the challenge
 * running. This is what the user does about it: give the product a different
 * instrument, which it authorizes off-session and puts in place of the hold it
 * could not keep alive.
 *
 * The order is the renewal path's order, for the renewal path's reason. The
 * replacement hold is taken first and the old one released only after the new
 * one is recorded, so no window exists in which the challenge is secured by
 * nothing. A hold taken and then rolled back lapses on the provider's side
 * having charged nothing, which is the cheaper of the two failure modes.
 *
 * Nothing here captures, and nothing here writes a challenge status. Replacing
 * a payment method is a statement about the deposit, exactly as a failed
 * renewal was, and a challenge's outcome is decided by its tasks.
 */

import type { ReplacePaymentMethodResponse } from "@betterwakeup/contract";
import { and, eq } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { challengeAuthorizations } from "../db/schema/authorizations.ts";
import { challenges } from "../db/schema/challenges.ts";
import { AppError } from "../errors/app-error.ts";
import { runIdempotent, type Transaction } from "../idempotency/service.ts";
import type { PaymentProviderClient } from "../payments/provider.ts";
import { loadChallengeView } from "./challenge-view.ts";

export interface ReplacePaymentMethodDependencies {
  readonly db: Database;
  readonly provider: PaymentProviderClient;
  readonly now?: (() => Date) | undefined;
}

export interface ReplacePaymentMethodCommand {
  readonly accountId: string;
  readonly challengeId: string;
  readonly idempotencyKey: string;
  readonly providerPaymentMethodId: string;
}

/** The statuses in which a deposit is still securing something. */
const SECURED_CHALLENGE_STATUSES = ["active", "recovery_pending"] as const;

export async function replacePaymentMethod(
  deps: ReplacePaymentMethodDependencies,
  command: ReplacePaymentMethodCommand,
): Promise<{ response: ReplacePaymentMethodResponse; replayed: boolean }> {
  const at = (deps.now ?? (() => new Date()))();
  let supersededHold: string | null = null;

  const outcome = await runIdempotent(
    deps.db,
    {
      accountId: command.accountId,
      key: command.idempotencyKey,
      commandType: "replacePaymentMethod",
      subject: command.challengeId,
      request: { providerPaymentMethodId: command.providerPaymentMethodId },
    },
    async (tx) => {
      const applied = await apply(tx, deps, command, at);
      supersededHold = applied.supersededHold;
      return applied.response;
    },
  );

  // After the command's own transaction committed, so a release that fails
  // leaves a stray hold rather than an unsecured challenge.
  if (supersededHold !== null) {
    try {
      await deps.provider.releaseAuthorization(supersededHold);
    } catch {
      // Reconciliation closes what the provider would not.
    }
  }

  return { response: outcome.result, replayed: outcome.replayed };
}

async function apply(
  tx: Transaction,
  deps: ReplacePaymentMethodDependencies,
  command: ReplacePaymentMethodCommand,
  at: Date,
): Promise<{ response: ReplacePaymentMethodResponse; supersededHold: string | null }> {
  // The challenge row is taken before anything is decided, so a sweep renewing
  // the same challenge's hold and this command cannot both act on it. The
  // renewal pass locks the authorization rather than the challenge, and the
  // authorization is locked below, which is what the two share.
  const [challenge] = await tx
    .select({
      id: challenges.id,
      status: challenges.status,
      depositMinorUnits: challenges.depositMinorUnits,
      depositCurrency: challenges.depositCurrency,
    })
    .from(challenges)
    .where(and(eq(challenges.id, command.challengeId), eq(challenges.accountId, command.accountId)))
    .for("update")
    .limit(1);
  if (challenge === undefined) {
    throw new AppError("not_found", "No challenge with this identifier.");
  }
  if (!SECURED_CHALLENGE_STATUSES.some((status) => status === challenge.status)) {
    throw new AppError(
      "challenge_not_active",
      "This challenge has ended, so it has no deposit to secure.",
    );
  }
  if (challenge.depositMinorUnits === 0) {
    throw new AppError(
      "deposit_required_for_funding",
      "This challenge has no deposit, so it has no payment method.",
    );
  }

  const [live] = await tx
    .select({
      id: challengeAuthorizations.id,
      providerAuthorizationId: challengeAuthorizations.providerAuthorizationId,
    })
    .from(challengeAuthorizations)
    .where(
      and(
        eq(challengeAuthorizations.challengeId, challenge.id),
        eq(challengeAuthorizations.status, "live"),
      ),
    )
    .for("update")
    .limit(1);

  // Off-session: the user is not at a payment sheet, the instrument is one the
  // provider already holds, and a hold taken this way is live when the call
  // returns. A decline surfaces as `payment_declined` from the provider, which
  // is the caller's to answer with a different card.
  const replacement = await deps.provider.authorizeDeposit({
    reference: challenge.id,
    customerReference: command.accountId,
    amount: {
      amountMinorUnits: challenge.depositMinorUnits,
      currency: challenge.depositCurrency,
    },
    paymentMethodId: command.providerPaymentMethodId,
  });

  if (live !== undefined) {
    // The old row leaves `live` before the new one enters it, so the one live
    // hold per challenge index holds at every statement boundary.
    await tx
      .update(challengeAuthorizations)
      .set({ status: "superseded", endedAt: at, updatedAt: at })
      .where(eq(challengeAuthorizations.id, live.id));
  }

  await tx.insert(challengeAuthorizations).values({
    challengeId: challenge.id,
    provider: deps.provider.name,
    providerAuthorizationId: replacement.authorizationId,
    providerPaymentMethodId: command.providerPaymentMethodId,
    amountMinorUnits: challenge.depositMinorUnits,
    currency: challenge.depositCurrency,
    status: "live",
    authorizedAt: at,
    expiresAt: replacement.expiresAt,
  });

  await tx
    .update(challenges)
    .set({ depositSecured: true, updatedAt: at })
    .where(eq(challenges.id, challenge.id));

  return {
    response: { challenge: await loadChallengeView(tx, challenge.id) },
    supersededHold: live?.providerAuthorizationId ?? null,
  };
}
