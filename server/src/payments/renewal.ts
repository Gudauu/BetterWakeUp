/**
 * Step 7 of the sweep: keeping a funded challenge's deposit secured.
 *
 * A challenge can run for a year and a hold lasts a month, so the deposit
 * behind a long challenge is secured by a succession of authorizations rather
 * than by one. This is the pass that takes each next one.
 *
 * **Renewal is driven by the hold's own window, not by a cadence.** A row is
 * due when at least half of its own `authorized_at` to `expires_at` window has
 * elapsed, which is the architecture's "roughly half the remaining window"
 * expressed against the only clock that matters: the provider's
 * `capture_before`. A hold taken for a shorter window is therefore renewed
 * sooner with no scheduling anywhere, and the half that is left is the room a
 * failing card has to be replaced in.
 *
 * **The replacement is authorized before the old hold is cancelled.** The
 * provider may answer with a different identifier, in which case the challenge
 * is briefly secured twice; the replacement is recorded and only then is the
 * old hold released. The other order has a window in which the user's deposit
 * is secured by nothing, and a crash inside that window leaves it that way.
 * The cost of this order is a stray hold if the release never happens, which
 * expires on the provider's side having charged nothing.
 *
 * **A failed renewal never fails a challenge.** This is stated in the phased
 * plan as a rule to assert directly rather than to derive, so it is also a
 * property of the code: nothing in this module writes a challenge status, a
 * task, or a settlement command. A decline marks the deposit unsecured, counts
 * the attempt, and leaves the row live and due, so the next sweep tries again
 * and the app (which reads `depositSecured` on the challenge) asks for a new
 * card. `POST /challenges/:challengeId/payment-method` is how that card gets
 * in.
 *
 * **No renewal path can capture.** Only `renewAuthorization` and
 * `releaseAuthorization` are reachable from here, neither of which moves
 * money, and no ledger row is written at all: a hold replacing a hold is not a
 * movement of value.
 *
 * Renewal continues through `recovery_pending`, because a challenge in the
 * recovery window is still running and may return to `active`; letting its
 * hold lapse would mean a user who recovers is no longer secured.
 */

import { and, eq, inArray, not, sql } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { challengeAuthorizations } from "../db/schema/authorizations.ts";
import { challenges } from "../db/schema/challenges.ts";
import type { Transaction } from "../idempotency/service.ts";
import type { Logger } from "../observability/logger.ts";
import type { PaymentProviderClient } from "./provider.ts";

/** The statuses in which a challenge still needs its deposit secured. */
const SECURED_CHALLENGE_STATUSES = ["active", "recovery_pending"] as const;

export interface RenewalPassResult {
  /** Holds replaced by a fresh one. */
  readonly authorizationsRenewed: number;
  /** Holds whose renewal the provider refused, leaving the deposit unsecured. */
  readonly renewalsFailed: number;
  /** True when the pass stopped on its ceiling rather than on running out. */
  readonly moreWorkPending: boolean;
}

export interface RenewalPassOptions {
  readonly db: Database;
  readonly provider: PaymentProviderClient;
  /** The instant the whole invocation reasons from. */
  readonly now: Date;
  /** How many holds one pass will attempt. */
  readonly batchSize: number;
  readonly logger: Logger;
  /**
   * Holds this invocation has already attempted.
   *
   * A failed renewal leaves the row due, so without this the pass would choose
   * the same declining card for its whole ceiling and never reach the next
   * challenge. Carried across passes for the same reason the overdue pass
   * carries the rows it could not lock.
   */
  readonly attempted?: Set<string> | undefined;
}

export async function runRenewalPass(options: RenewalPassOptions): Promise<RenewalPassResult> {
  const attempted = options.attempted ?? new Set<string>();
  let renewed = 0;
  let failed = 0;

  for (let taken = 0; taken < options.batchSize; taken += 1) {
    const outcome = await renewOne(options, attempted);
    if (outcome === "none") {
      return { authorizationsRenewed: renewed, renewalsFailed: failed, moreWorkPending: false };
    }
    if (outcome === "renewed") renewed += 1;
    if (outcome === "failed") failed += 1;
  }
  return { authorizationsRenewed: renewed, renewalsFailed: failed, moreWorkPending: true };
}

type RenewalOutcome = "none" | "renewed" | "failed" | "skipped";

/**
 * One hold.
 *
 * The provider call happens inside the transaction that holds the row's lock.
 * That is safe here for the same reason it is safe on the funding path and
 * would not be for a capture: taking a hold is reversible and free, so a
 * transaction that rolls back after a successful renewal leaves a replacement
 * hold nobody recorded, which lapses having charged nothing. The alternative,
 * recording first and calling after, leaves a row claiming a hold that may not
 * exist, which a settlement would later try to capture.
 */
async function renewOne(
  options: RenewalPassOptions,
  attempted: Set<string>,
): Promise<RenewalOutcome> {
  let supersededHold: string | null = null;

  const outcome = await options.db.transaction(async (tx): Promise<RenewalOutcome> => {
    const [claimed] = await tx
      .select({
        id: challengeAuthorizations.id,
        challengeId: challengeAuthorizations.challengeId,
        providerAuthorizationId: challengeAuthorizations.providerAuthorizationId,
        providerPaymentMethodId: challengeAuthorizations.providerPaymentMethodId,
        amountMinorUnits: challengeAuthorizations.amountMinorUnits,
        currency: challengeAuthorizations.currency,
      })
      .from(challengeAuthorizations)
      .innerJoin(challenges, eq(challenges.id, challengeAuthorizations.challengeId))
      .where(
        and(
          eq(challengeAuthorizations.status, "live"),
          inArray(challenges.status, [...SECURED_CHALLENGE_STATUSES]),
          halfSpent(options.now),
          attempted.size === 0
            ? undefined
            : not(inArray(challengeAuthorizations.id, [...attempted])),
        ),
      )
      // Only the hold is locked. The challenge is read for its status, and
      // locking it would put a renewal in front of every command the user is
      // running, which is the opposite of what a background pass may do.
      .for("update", { of: challengeAuthorizations, skipLocked: true })
      .limit(1);
    if (claimed === undefined) return "none";
    attempted.add(claimed.id);

    const at = options.now;
    let replacement: Awaited<ReturnType<PaymentProviderClient["renewAuthorization"]>>;
    try {
      replacement = await options.provider.renewAuthorization(claimed.providerAuthorizationId);
    } catch (error) {
      // The provider refused; the database is fine, so the failure is recorded
      // in this same transaction rather than by rolling back and writing it in
      // another one, which would lose the row's lock in between.
      await recordFailure(tx, options, claimed, error);
      return "failed";
    }

    if (replacement.authorizationId === claimed.providerAuthorizationId) {
      // A processor that extended the hold in place. There is nothing to
      // supersede and nothing to release.
      await tx
        .update(challengeAuthorizations)
        .set({
          authorizedAt: at,
          expiresAt: replacement.expiresAt,
          renewalAttempts: 0,
          lastError: null,
          updatedAt: at,
        })
        .where(eq(challengeAuthorizations.id, claimed.id));
    } else {
      // The old row leaves `live` before the new one enters it, so the one
      // live hold per challenge index holds at every statement boundary.
      await tx
        .update(challengeAuthorizations)
        .set({ status: "superseded", endedAt: at, updatedAt: at })
        .where(eq(challengeAuthorizations.id, claimed.id));
      await tx.insert(challengeAuthorizations).values({
        challengeId: claimed.challengeId,
        provider: options.provider.name,
        providerAuthorizationId: replacement.authorizationId,
        providerPaymentMethodId: claimed.providerPaymentMethodId,
        amountMinorUnits: claimed.amountMinorUnits,
        currency: claimed.currency,
        status: "live",
        authorizedAt: at,
        expiresAt: replacement.expiresAt,
      });
      supersededHold = claimed.providerAuthorizationId;
    }

    // A challenge whose renewal had failed is secured again. This is the only
    // column of `challenges` this module writes, and it is deliberately not a
    // status: a deposit's security and a challenge's outcome are separate
    // facts, and conflating them is exactly what the "a failed renewal must
    // never fail a challenge" rule forbids.
    await tx
      .update(challenges)
      .set({ depositSecured: true, updatedAt: at })
      .where(and(eq(challenges.id, claimed.challengeId), eq(challenges.depositSecured, false)));

    options.logger.info("authorization renewed", {
      command: "renewAuthorization",
      authorizationRenewal: "renewed",
      depositSecured: true,
      challengeId: claimed.challengeId,
      paymentProvider: options.provider.name,
    });
    return "renewed";
  });

  // Only once the replacement is committed, which is what makes this the
  // cancellation of a hold the product no longer relies on rather than the
  // removal of the one it does.
  if (supersededHold !== null) await releaseSuperseded(options, supersededHold);
  return outcome;
}

/**
 * The old hold, once the replacement is committed.
 *
 * Outside the transaction and after it, because the record is what the product
 * acts on: a release that fails leaves a hold the provider expires by itself,
 * whereas rolling the replacement back over a failed release would leave the
 * challenge unsecured for a reason that has nothing to do with the user's card.
 */
async function releaseSuperseded(
  options: RenewalPassOptions,
  authorizationId: string,
): Promise<void> {
  try {
    await options.provider.releaseAuthorization(authorizationId);
  } catch {
    // Named, not swallowed: reconciliation is what closes a hold the provider
    // refused to release, and it needs to know one exists.
    options.logger.warn("superseded authorization was not released", {
      command: "renewAuthorization",
      authorizationRenewal: "unchanged",
      result: "release_failed",
      paymentProvider: options.provider.name,
    });
  }
}

/**
 * A decline.
 *
 * Everything here is about the deposit and nothing about the challenge: the
 * hold stays live and due so the next sweep retries it, the attempt is counted
 * so an alarm can tell one decline from a card that will never work again, and
 * the challenge is marked unsecured, which is the flag the app reads to ask for
 * a new card.
 */
async function recordFailure(
  tx: Transaction,
  options: RenewalPassOptions,
  claimed: { readonly id: string; readonly challengeId: string },
  error: unknown,
): Promise<void> {
  const at = options.now;
  const reason = error instanceof Error ? error.message : "the provider refused the renewal";

  await tx
    .update(challengeAuthorizations)
    .set({
      renewalAttempts: sql`${challengeAuthorizations.renewalAttempts} + 1`,
      lastError: reason,
      updatedAt: at,
    })
    .where(eq(challengeAuthorizations.id, claimed.id));
  await tx
    .update(challenges)
    .set({ depositSecured: false, updatedAt: at })
    .where(eq(challenges.id, claimed.challengeId));

  // The user has to be told, and the app learns it from `depositSecured` on
  // the challenge it already polls. A push notification is the mobile phase's
  // to send; this line is what a deployment alarms on in the meantime.
  options.logger.warn("authorization renewal failed", {
    command: "renewAuthorization",
    authorizationRenewal: "failed",
    depositSecured: false,
    challengeId: claimed.challengeId,
    paymentProvider: options.provider.name,
    errorCode: "payment_declined",
    errorClassification: "payment",
  });
}

/**
 * Half of the hold's own window has passed.
 *
 * Comparing against the midpoint of the row's window rather than against a
 * fixed number of days is what makes this work for a provider whose holds last
 * a week and one whose holds last a month, and it is why the row carries both
 * ends of its window.
 */
function halfSpent(now: Date) {
  return sql`${now} >= ${challengeAuthorizations.authorizedAt} + (${challengeAuthorizations.expiresAt} - ${challengeAuthorizations.authorizedAt}) / 2`;
}
