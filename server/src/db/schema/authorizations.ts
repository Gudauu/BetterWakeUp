/**
 * The hold that secures a funded challenge, and every hold that came before it.
 *
 * A funding intent records the question the provider was asked; this records
 * the answer, and it keeps recording it for as long as the challenge runs. The
 * two are separate rows because they have different lifetimes: an intent is
 * settled once and never again, while the hold behind a challenge is replaced
 * every time it is renewed, and a challenge that outlives several renewals is
 * exactly the case the architecture asks to keep secured.
 *
 * Three decisions carry the table.
 *
 * **A renewal is a new row, not an edited one.** An authorization has its own
 * window (`authorized_at` to `expires_at`), and renewal takes a replacement
 * hold before releasing the old one, so for the length of one transaction the
 * challenge has two. Superseding the old row and inserting the new one is what
 * makes that orderable, and it leaves the history a reconciliation needs: every
 * hold the product ever took against a challenge is still here with the reason
 * it ended.
 *
 * **Exactly one hold is live per challenge.** A partial unique index says it,
 * so "which authorization would a capture act on" has one answer at every
 * instant rather than an ordering rule some query has to remember.
 *
 * **The window is the renewal clock.** Renewal is driven by each
 * authorization's own expiry rather than by a fixed cadence, so the row carries
 * both ends of its window and the sweep computes the halfway point from them.
 * Nothing schedules a renewal; the row being half-spent is what makes it due.
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { challenges } from "./challenges.ts";
import { paymentProvider } from "./payments.ts";

/** What became of a hold. `live` is the only status that secures anything. */
export const challengeAuthorizationStatus = pgEnum("challenge_authorization_status", [
  /** Securing the deposit right now. At most one per challenge. */
  "live",
  /** Replaced by a renewal or by a new payment method, and released. */
  "superseded",
  /** Ended without a capture: the challenge succeeded, expired, or was cancelled. */
  "released",
  /** Settled against. The one status that means money moved. */
  "captured",
]);

/** The statuses a hold can no longer move out of. */
const ENDED_AUTHORIZATION_STATUSES = sql`('superseded', 'released', 'captured')`;

export const challengeAuthorizations = pgTable(
  "challenge_authorizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    provider: paymentProvider("provider").notNull(),
    /** The provider's identifier for the hold, and the handle for every later call. */
    providerAuthorizationId: text("provider_authorization_id").notNull(),
    /**
     * The saved instrument behind the hold.
     *
     * Kept because a renewal that has to take a fresh hold, and a settlement
     * with no live hold to capture, both act on the instrument rather than on
     * the authorization. It is the provider's opaque identifier and never a
     * card number.
     */
    providerPaymentMethodId: text("provider_payment_method_id"),
    amountMinorUnits: integer("amount_minor_units").notNull(),
    currency: text("currency").notNull().default("USD"),
    status: challengeAuthorizationStatus("status").notNull().default("live"),
    /** When this hold began. The start of the window renewal measures. */
    authorizedAt: timestamp("authorized_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    /** The provider's `capture_before`: when the hold lapses if it is not renewed. */
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    /**
     * How many times renewing this hold has failed.
     *
     * A failed renewal leaves the row live and due, so the next sweep tries
     * again; the count is what an alarm reads and what tells a support call
     * apart from a card that declined once.
     */
    renewalAttempts: integer("renewal_attempts").notNull().default(0),
    /** Why the last renewal failed. Never carries a payment credential. */
    lastError: text("last_error"),
    /** When the hold stopped being live. One column for all three ended statuses. */
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // One hold per provider identifier, so a renewal that returned the same
    // identifier cannot be recorded as a second hold.
    uniqueIndex("challenge_authorizations_provider_key").on(
      table.provider,
      table.providerAuthorizationId,
    ),
    // At most one live hold per challenge: the answer to "what would a capture
    // act on" is a row rather than an ordering convention.
    uniqueIndex("challenge_authorizations_live_per_challenge_key")
      .on(table.challengeId)
      .where(sql`${table.status} = 'live'`),
    // The renewal pass selects live holds by how far into their window they are.
    index("challenge_authorizations_live_expiry_idx").on(table.status, table.expiresAt),
    check("challenge_authorizations_amount_funded", sql`${table.amountMinorUnits} >= 100`),
    check(
      "challenge_authorizations_window_ordered",
      sql`${table.expiresAt} > ${table.authorizedAt}`,
    ),
    check(
      "challenge_authorizations_renewal_attempts_nonnegative",
      sql`${table.renewalAttempts} >= 0`,
    ),
    check(
      "challenge_authorizations_ended_status_has_instant",
      sql`(${table.status} in ${ENDED_AUTHORIZATION_STATUSES}) = (${table.endedAt} is not null)`,
    ),
  ],
);
