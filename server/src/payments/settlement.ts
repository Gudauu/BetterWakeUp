/**
 * Step 6 of the sweep: executing the settlement commands the earlier steps
 * created.
 *
 * The architecture separates creating a settlement from executing one, and this
 * is the second half. A command is due when its `execute_after` has passed and
 * it is still `pending`, which is what makes the twenty-four hour recovery
 * window a column rather than a scheduler entry: Emergency Recovery cancels the
 * command, and a cancelled command is never selected here.
 *
 * Four rules carry the module.
 *
 * **A success costs nothing.** A `release_authorization` command releases the
 * hold and writes an `authorization_released` movement whose entries take
 * `user_commitment` and `payment_processor` back to zero. Processing fees attach
 * to a capture, so a challenge that succeeded, or one that expired after a
 * year-long pause, moves no money and incurs no fee at all.
 *
 * **Collection is a retried command, not a call that either works or throws.**
 * A declined capture counts the attempt, records the reason, and leaves the
 * command `pending` so the next invocation tries again. Only after
 * `MAX_COLLECTION_ATTEMPTS` does it stop, and stopping is not silence: the
 * forfeit is recorded as `uncollected` in the ledger and the command settles
 * `failed` with an error line a deployment alarms on. Nothing is ever lost by
 * being undone; it is lost by being forgotten, so the terminal state is a row.
 *
 * **The hold is not the collection mechanism.** A capture acts on the live
 * authorization when there is one and charges the saved instrument off-session
 * when there is not, which is what makes every renewal failure survivable: a
 * hold that lapsed does not make a forfeit uncollectable, it only makes it a
 * charge instead of a capture.
 *
 * **The provider is called at most once per attempt, and a crash cannot capture
 * twice.** The provider call happens inside the transaction holding the
 * command's lock, so a crash between the call and the commit leaves the command
 * `pending` and the money captured. The next attempt's capture is refused by the
 * provider, and the refusal is what triggers the one reconciliation call this
 * module makes: a hold the provider reports as already captured is recorded as
 * captured rather than retried, which is why a double capture is not reachable
 * from here.
 */

import { and, asc, desc, eq, inArray, isNotNull, lte, ne, not } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { challengeAuthorizations } from "../db/schema/authorizations.ts";
import { challenges } from "../db/schema/challenges.ts";
import { paymentCommands } from "../db/schema/payments.ts";
import { AppError } from "../errors/app-error.ts";
import type { Transaction } from "../idempotency/service.ts";
import type { Logger } from "../observability/logger.ts";
import { recordLedgerMovement } from "./ledger.ts";
import type { Money, PaymentProviderClient, Settlement } from "./provider.ts";

/**
 * How many times a collection is attempted before it is recorded as
 * uncollected.
 *
 * Five daily-ish sweeps is several days of retries, which is long enough for a
 * temporary decline (an issuer's fraud hold, a balance that arrives with a
 * paycheck) and short enough that an uncollectable forfeit is recorded while
 * anybody still remembers the challenge.
 */
export const MAX_COLLECTION_ATTEMPTS = 5;

/** The challenge statuses a capture is still the right answer for. */
const COLLECTABLE_CHALLENGE_STATUSES = ["failed", "recovery_pending"] as const;

export interface SettlementPassResult {
  /** Holds released because a challenge succeeded or expired. Nothing charged. */
  readonly authorizationsReleased: number;
  /** Forfeits collected, whether by capturing a hold or by charging a card. */
  readonly forfeitsCollected: number;
  /** Forfeits recorded as uncollected after every attempt was refused. */
  readonly forfeitsUncollected: number;
  /** Commands that were no longer the right thing to do, so were cancelled. */
  readonly settlementsCancelled: number;
  /** Commands whose attempt failed and which stay pending for the next pass. */
  readonly collectionsRetrying: number;
  /** True when the pass stopped on its ceiling rather than on running out. */
  readonly moreWorkPending: boolean;
}

export interface SettlementPassOptions {
  readonly db: Database;
  readonly provider: PaymentProviderClient;
  /** The instant the whole invocation reasons from. */
  readonly now: Date;
  /** How many commands one pass will execute. */
  readonly batchSize: number;
  readonly logger: Logger;
  /**
   * Commands this invocation has already attempted.
   *
   * A refused collection stays `pending` and stays due, so without this the
   * pass would spend its whole ceiling on one declining card. Carried across
   * passes for the same reason the overdue pass carries the rows it could not
   * lock.
   */
  readonly attempted?: Set<string> | undefined;
}

type Outcome =
  | "none"
  | "released"
  | "collected"
  | "uncollected"
  | "cancelled"
  | "retrying"
  /** Somebody held a row this command needed. Nothing was written. */
  | "passed_over";

export async function runSettlementPass(
  options: SettlementPassOptions,
): Promise<SettlementPassResult> {
  const attempted = options.attempted ?? new Set<string>();
  const totals = {
    authorizationsReleased: 0,
    forfeitsCollected: 0,
    forfeitsUncollected: 0,
    settlementsCancelled: 0,
    collectionsRetrying: 0,
  };

  for (let taken = 0; taken < options.batchSize; taken += 1) {
    const outcome = await options.db.transaction(
      async (tx) => await settleOne(tx, options, attempted),
    );
    if (outcome === "none") return { ...totals, moreWorkPending: false };
    if (outcome === "released") totals.authorizationsReleased += 1;
    if (outcome === "collected") totals.forfeitsCollected += 1;
    if (outcome === "uncollected") totals.forfeitsUncollected += 1;
    if (outcome === "cancelled") totals.settlementsCancelled += 1;
    if (outcome === "retrying") totals.collectionsRetrying += 1;
  }
  return { ...totals, moreWorkPending: true };
}

interface DueCommand {
  readonly id: string;
  readonly kind: (typeof paymentCommands.$inferSelect)["kind"];
  readonly attempts: number;
  readonly challengeId: string;
  readonly accountId: string;
  readonly challengeStatus: (typeof challenges.$inferSelect)["status"];
  readonly depositMinorUnits: number;
  readonly depositCurrency: string;
}

/**
 * One due command.
 *
 * Only the command row is locked, and it is locked with `skip locked` like
 * everything else the sweep takes. That one row is enough to make this mutually
 * exclusive with Emergency Recovery, which cancels the capture: recovery takes
 * the challenge first and the command second, so a recovery running against a
 * command this pass holds waits for it and then finds the command settled,
 * which is exactly the closed window its own rules describe.
 */
async function settleOne(
  tx: Transaction,
  options: SettlementPassOptions,
  attempted: Set<string>,
): Promise<Outcome> {
  const [command] = await tx
    .select({
      id: paymentCommands.id,
      kind: paymentCommands.kind,
      attempts: paymentCommands.attempts,
      challengeId: challenges.id,
      accountId: challenges.accountId,
      challengeStatus: challenges.status,
      depositMinorUnits: challenges.depositMinorUnits,
      depositCurrency: challenges.depositCurrency,
    })
    .from(paymentCommands)
    .innerJoin(challenges, eq(challenges.id, paymentCommands.challengeId))
    .where(
      and(
        eq(paymentCommands.status, "pending"),
        lte(paymentCommands.executeAfter, options.now),
        attempted.size === 0 ? undefined : not(inArray(paymentCommands.id, [...attempted])),
      ),
    )
    .orderBy(asc(paymentCommands.executeAfter))
    .for("update", { of: paymentCommands, skipLocked: true })
    .limit(1);
  if (command === undefined) return "none";
  attempted.add(command.id);

  if (command.kind === "release_authorization") return await release(tx, options, command);
  if (command.kind === "capture") return await collect(tx, options, command);

  // `authorize`, `renew_authorization`, and `charge_off_session` are not
  // commands anything creates: authorizing and renewing happen in the
  // transaction that records their result, and an off-session charge is how a
  // capture is performed rather than a command of its own. A row of one of
  // those kinds is somebody's future work reaching this pass early, so it is
  // left pending and named rather than guessed at.
  options.logger.error("a settlement command of an unexecutable kind is due", {
    command: "settlement",
    result: command.kind,
    challengeId: command.challengeId,
    paymentProvider: options.provider.name,
    errorCode: "internal_error",
    errorClassification: "internal",
  });
  return "retrying";
}

/**
 * The release path: a challenge that succeeded, or one that expired after a
 * year of pause.
 *
 * A command whose challenge has no live hold is cancelled rather than confirmed.
 * There is no provider reference to record, which the schema requires of a
 * confirmed command, and there is nothing that could have been released: the
 * hold was superseded, already released, or never taken.
 */
async function release(
  tx: Transaction,
  options: SettlementPassOptions,
  command: DueCommand,
): Promise<Outcome> {
  const hold = await liveHold(tx, command.challengeId);
  if (hold === "locked") return "passed_over";
  if (hold === undefined) {
    await settle(tx, options, command, "cancelled", null, "no live authorization to release");
    return "cancelled";
  }

  try {
    await options.provider.releaseAuthorization(hold.providerAuthorizationId);
  } catch (error) {
    return await retryOrGiveUp(tx, options, command, error, "release");
  }

  await endHold(tx, options, hold.id, "released");
  await recordLedgerMovement(tx, {
    challengeId: command.challengeId,
    accountId: command.accountId,
    kind: "authorization_released",
    occurredAt: options.now,
    providerReference: hold.providerAuthorizationId,
    currency: hold.currency,
    entries: [
      // The mirror image of the movement the hold opened, so a released deposit
      // leaves every ledger account at zero and no fee anywhere.
      { ledgerAccount: "user_commitment", amountMinorUnits: -hold.amountMinorUnits },
      { ledgerAccount: "payment_processor", amountMinorUnits: hold.amountMinorUnits },
    ],
  });
  await settle(tx, options, command, "confirmed", hold.providerAuthorizationId, null);

  options.logger.info("authorization released", {
    command: "settlement",
    result: "released",
    challengeId: command.challengeId,
    paymentProvider: options.provider.name,
    depositSecured: false,
  });
  return "released";
}

/**
 * The capture path: the forfeit.
 *
 * The challenge status is read again under the command's lock, because a
 * capture is only ever the right answer for a challenge that is failing. A
 * challenge that came back (Emergency Recovery, which also cancels this
 * command) or that has succeeded is not charged, and the command is cancelled
 * rather than left due forever.
 */
async function collect(
  tx: Transaction,
  options: SettlementPassOptions,
  command: DueCommand,
): Promise<Outcome> {
  if (!COLLECTABLE_CHALLENGE_STATUSES.some((status) => status === command.challengeStatus)) {
    await settle(
      tx,
      options,
      command,
      "cancelled",
      null,
      `the challenge is ${command.challengeStatus}`,
    );
    return "cancelled";
  }

  const found = await liveHold(tx, command.challengeId);
  if (found === "locked") return "passed_over";
  const hold = found;
  const amount: Money = {
    amountMinorUnits: hold?.amountMinorUnits ?? command.depositMinorUnits,
    currency: hold?.currency ?? command.depositCurrency,
  };

  let settlement: Settlement;
  let kind: "forfeit_captured" | "forfeit_charged";
  try {
    if (hold !== undefined) {
      settlement = await captureOrReconcile(options, hold, amount);
      kind = "forfeit_captured";
    } else {
      const instrument = await savedInstrument(tx, command.challengeId);
      if (instrument === null) {
        // No hold and no saved card. No number of retries produces one, so this
        // is uncollectable now rather than after five attempts at nothing.
        return await recordUncollected(tx, options, command, amount, "no instrument to charge");
      }
      settlement = await options.provider.chargeOffSession(instrument, amount);
      kind = "forfeit_charged";
    }
  } catch (error) {
    return await retryOrGiveUp(tx, options, command, error, "collect", amount);
  }

  if (hold !== undefined) await endHold(tx, options, hold.id, "captured");
  await recordLedgerMovement(tx, {
    challengeId: command.challengeId,
    accountId: command.accountId,
    kind,
    occurredAt: options.now,
    providerReference: settlement.reference,
    currency: amount.currency,
    entries: [
      // The commitment is discharged and the same value becomes revenue, in
      // full: there is no charity recipient in the system and no split.
      { ledgerAccount: "user_commitment", amountMinorUnits: -amount.amountMinorUnits },
      { ledgerAccount: "platform_revenue", amountMinorUnits: amount.amountMinorUnits },
    ],
  });
  await settle(tx, options, command, "confirmed", settlement.reference, null);
  await failChallengeIfRecovering(tx, options, command);

  options.logger.info("forfeit collected", {
    command: "settlement",
    result: kind === "forfeit_captured" ? "captured" : "charged",
    challengeId: command.challengeId,
    paymentProvider: options.provider.name,
  });
  return "collected";
}

/**
 * The capture, with the one reconciliation call this module makes.
 *
 * A provider that refuses the capture may be refusing because it already
 * performed it: the previous attempt captured and then crashed before its
 * commit. Asking what the provider believes is the difference between recording
 * money that moved and charging the user twice, and it is why the interface
 * carries `getTransactionStatus` at all. The authorization identifier stands in
 * for the settlement reference in that case, because the capture that produced
 * one was rolled back with it.
 */
async function captureOrReconcile(
  options: SettlementPassOptions,
  hold: LiveHold,
  amount: Money,
): Promise<Settlement> {
  try {
    return await options.provider.captureAuthorization(hold.providerAuthorizationId, amount);
  } catch (error) {
    const status = await options.provider.getTransactionStatus(hold.providerAuthorizationId);
    if (status.state !== "captured") throw error;
    options.logger.warn("a capture was already performed at the provider", {
      command: "settlement",
      result: "reconciled",
      challengeId: hold.challengeId,
      paymentProvider: options.provider.name,
    });
    return { reference: hold.providerAuthorizationId, amount };
  }
}

/**
 * A refused attempt.
 *
 * The command stays `pending` and stays due, so the next invocation tries again,
 * until the attempt count says the card is not going to work. Then, and only for
 * a collection, the forfeit is recorded as uncollected: a release that keeps
 * failing leaves a hold the provider expires by itself, which costs nothing and
 * is not an obligation anybody is owed.
 */
async function retryOrGiveUp(
  tx: Transaction,
  options: SettlementPassOptions,
  command: DueCommand,
  error: unknown,
  what: "release" | "collect",
  amount?: Money,
): Promise<Outcome> {
  const reason = error instanceof Error ? error.message : "the provider refused the command";
  const attempts = command.attempts + 1;

  if (what === "collect" && attempts >= MAX_COLLECTION_ATTEMPTS && amount !== undefined) {
    return await recordUncollected(tx, options, command, amount, reason);
  }

  await tx
    .update(paymentCommands)
    .set({ attempts, lastError: reason, updatedAt: options.now })
    .where(eq(paymentCommands.id, command.id));

  options.logger.warn("a settlement attempt was refused", {
    command: "settlement",
    result: "retrying",
    challengeId: command.challengeId,
    paymentProvider: options.provider.name,
    errorCode: "payment_declined",
    errorClassification: "payment",
  });
  return "retrying";
}

/**
 * The terminal state that alarms.
 *
 * The provider records the obligation, the ledger records it as an uncollected
 * forfeit rather than as revenue, and the command settles `failed`. The line is
 * an error rather than a warning because nothing downstream will retry it: this
 * is the last thing that happens to this money.
 */
async function recordUncollected(
  tx: Transaction,
  options: SettlementPassOptions,
  command: DueCommand,
  amount: Money,
  reason: string,
): Promise<Outcome> {
  const settlement = await options.provider.recordUncollectedForfeit(command.challengeId, amount);

  await recordLedgerMovement(tx, {
    challengeId: command.challengeId,
    accountId: command.accountId,
    kind: "forfeit_uncollected",
    occurredAt: options.now,
    providerReference: settlement.reference,
    currency: amount.currency,
    entries: [
      // The commitment is discharged either way; what differs is where it went.
      // `uncollected_forfeit` is the account whose running sum is the money the
      // product recorded as owed and never received.
      { ledgerAccount: "user_commitment", amountMinorUnits: -amount.amountMinorUnits },
      { ledgerAccount: "uncollected_forfeit", amountMinorUnits: amount.amountMinorUnits },
    ],
  });
  await settle(tx, options, command, "failed", settlement.reference, reason);
  await failChallengeIfRecovering(tx, options, command);

  options.logger.error("a forfeit could not be collected", {
    command: "settlement",
    result: "uncollected",
    challengeId: command.challengeId,
    paymentProvider: options.provider.name,
    errorCode: "payment_declined",
    errorClassification: "payment",
  });
  return "uncollected";
}

/**
 * The recovery window, closed by the settlement that ends it.
 *
 * A challenge in `recovery_pending` is one whose offer nobody took, and the
 * capture becoming due is exactly the instant that offer expired: the sweep set
 * `execute_after` to the end of the window when it created the command. So the
 * challenge fails here rather than in a separate pass with its own clock, which
 * is what keeps "the offer expired" and "the money moved" from ever disagreeing.
 *
 * The challenge is locked with `skip locked` like everything else, and a
 * challenge somebody holds simply keeps its status: the command has settled, so
 * the concurrent writer is a recovery that is about to find its window closed.
 */
async function failChallengeIfRecovering(
  tx: Transaction,
  options: SettlementPassOptions,
  command: DueCommand,
): Promise<void> {
  if (command.challengeStatus !== "recovery_pending") return;

  const [locked] = await tx
    .select({ id: challenges.id })
    .from(challenges)
    .where(and(eq(challenges.id, command.challengeId), eq(challenges.status, "recovery_pending")))
    .for("update", { skipLocked: true })
    .limit(1);
  if (locked === undefined) return;

  await tx
    .update(challenges)
    .set({ status: "failed", terminalAt: options.now, updatedAt: options.now })
    .where(and(eq(challenges.id, command.challengeId), eq(challenges.status, "recovery_pending")));
}

interface LiveHold {
  readonly id: string;
  readonly challengeId: string;
  readonly providerAuthorizationId: string;
  readonly amountMinorUnits: number;
  readonly currency: string;
}

/**
 * The hold securing this challenge, locked, or a reason there is none to act on.
 *
 * `locked` and `undefined` are different answers and conflating them would be a
 * money bug: a hold the renewal pass is holding is a hold that exists, and
 * treating it as absent would charge the saved card off-session while a live
 * authorization sat there waiting to be captured. So the lock is taken with
 * `skip locked` like every other lock in the sweep, and a hold somebody else
 * holds leaves the command for the next invocation instead.
 */
async function liveHold(
  tx: Transaction,
  challengeId: string,
): Promise<LiveHold | "locked" | undefined> {
  const [row] = await tx
    .select({
      id: challengeAuthorizations.id,
      challengeId: challengeAuthorizations.challengeId,
      providerAuthorizationId: challengeAuthorizations.providerAuthorizationId,
      amountMinorUnits: challengeAuthorizations.amountMinorUnits,
      currency: challengeAuthorizations.currency,
    })
    .from(challengeAuthorizations)
    .where(
      and(
        eq(challengeAuthorizations.challengeId, challengeId),
        eq(challengeAuthorizations.status, "live"),
      ),
    )
    .for("update", { skipLocked: true })
    .limit(1);
  if (row !== undefined) return row;

  const [unlocked] = await tx
    .select({ id: challengeAuthorizations.id })
    .from(challengeAuthorizations)
    .where(
      and(
        eq(challengeAuthorizations.challengeId, challengeId),
        eq(challengeAuthorizations.status, "live"),
      ),
    )
    .limit(1);
  return unlocked === undefined ? undefined : "locked";
}

/**
 * The instrument to charge when no hold is live.
 *
 * The most recent authorization that named one, whatever became of it: the card
 * behind a hold that lapsed or was superseded is still the card the user gave
 * us under the stored agreement, and the agreement rather than the hold is what
 * the collection stands on.
 */
async function savedInstrument(tx: Transaction, challengeId: string): Promise<string | null> {
  const [row] = await tx
    .select({ paymentMethodId: challengeAuthorizations.providerPaymentMethodId })
    .from(challengeAuthorizations)
    .where(
      and(
        eq(challengeAuthorizations.challengeId, challengeId),
        isNotNull(challengeAuthorizations.providerPaymentMethodId),
      ),
    )
    .orderBy(desc(challengeAuthorizations.authorizedAt))
    .limit(1);
  return row?.paymentMethodId ?? null;
}

async function endHold(
  tx: Transaction,
  options: SettlementPassOptions,
  holdId: string,
  status: "released" | "captured",
): Promise<void> {
  await tx
    .update(challengeAuthorizations)
    .set({ status, endedAt: options.now, updatedAt: options.now })
    .where(and(eq(challengeAuthorizations.id, holdId), ne(challengeAuthorizations.status, status)));
}

/** The command's own terminal state, with the reason it reached it. */
async function settle(
  tx: Transaction,
  options: SettlementPassOptions,
  command: DueCommand,
  status: "confirmed" | "cancelled" | "failed",
  providerReference: string | null,
  reason: string | null,
): Promise<void> {
  const [updated] = await tx
    .update(paymentCommands)
    .set({
      status,
      settledAt: options.now,
      // A cancelled command was never attempted at the provider, so it does not
      // count one: the column is what an alarm reads to tell a card that took
      // three tries from a command nobody ever called about.
      attempts: status === "cancelled" ? command.attempts : command.attempts + 1,
      ...(providerReference === null ? {} : { providerReference }),
      ...(reason === null ? {} : { lastError: reason }),
      updatedAt: options.now,
    })
    .where(and(eq(paymentCommands.id, command.id), eq(paymentCommands.status, "pending")))
    .returning({ id: paymentCommands.id });
  if (updated === undefined) {
    throw new AppError("internal_error", "a settled payment command was no longer pending");
  }
}
