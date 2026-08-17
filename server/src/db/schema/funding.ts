/**
 * Funding intents: the authorization a funded challenge waits on.
 *
 * This table exists because of one sentence in the architecture: the
 * configuration is stored against the payment intent, not as a user-visible
 * draft. The webhook has to know what was authorized, and the amount at stake
 * has to be tied to the exact terms the user accepted, so the whole
 * configuration and the accepted policy version travel with the hold rather
 * than being re-sent by whichever client happens to be alive afterwards.
 *
 * There is deliberately no challenge here until the provider confirms. A
 * pending intent is a question the provider has not answered; the row that
 * would make it a running challenge is written by the webhook and by nothing
 * else, which is what makes "a client callback alone never activates a
 * challenge" a property of the schema rather than a rule handlers remember.
 *
 * A zero deposit challenge never produces a row here at all: it has no
 * authorization to wait for, which is what the funded-amount check states.
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { challenges } from "./challenges.ts";
import { accounts } from "./identity.ts";
import { paymentProvider } from "./payments.ts";

/** Matches the states the provider's answer can leave an intent in. */
export const fundingIntentStatus = pgEnum("funding_intent_status", [
  /** Awaiting the provider. The only status that has no answer yet. */
  "pending",
  /** The provider confirmed the hold, and the challenge in `challenge_id` exists. */
  "authorized",
  /** The provider declined, or the user abandoned the payment sheet. */
  "failed",
]);

/** The statuses an intent can no longer move out of. */
const SETTLED_INTENT_STATUSES = sql`('authorized', 'failed')`;

export const fundingIntents = pgTable(
  "funding_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    provider: paymentProvider("provider").notNull(),
    /** The provider's identifier for the hold. The handle for every later operation. */
    providerAuthorizationId: text("provider_authorization_id").notNull(),
    status: fundingIntentStatus("status").notNull().default("pending"),
    /**
     * The exact terms the user accepted, as the contract's
     * `challengeConfiguration`. Stored whole rather than column by column
     * because it is evidence of an agreement and not something any query
     * filters on: what matters is that the challenge materialized later is
     * materialized from this and from nothing the client re-sends.
     */
    configuration: jsonb("configuration").notNull(),
    policyVersion: text("policy_version").notNull(),
    /** Denormalized from the configuration, because the money is what a check can hold. */
    depositMinorUnits: integer("deposit_minor_units").notNull(),
    depositCurrency: text("deposit_currency").notNull().default("USD"),
    /** The challenge this intent activated. Null until the provider confirms. */
    challengeId: uuid("challenge_id").references(() => challenges.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    /** When the provider answered. One column for both settled statuses. */
    settledAt: timestamp("settled_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    // The provider's identifier is the join key on a delivery, so a second
    // intent claiming one authorization is unrepresentable rather than merely
    // unexpected.
    uniqueIndex("funding_intents_provider_authorization_key").on(
      table.provider,
      table.providerAuthorizationId,
    ),
    index("funding_intents_account_idx").on(table.accountId, table.status),
    // An intent is never for nothing: the zero deposit path does not reach the
    // provider, so a zero here would be a funded challenge that costs nothing
    // to fail.
    check("funding_intents_deposit_funded", sql`${table.depositMinorUnits} >= 100`),
    check(
      "funding_intents_settled_status_has_instant",
      sql`(${table.status} in ${SETTLED_INTENT_STATUSES}) = (${table.settledAt} is not null)`,
    ),
    // An authorized intent activated a challenge, and nothing else has one.
    // This is the schema-level form of "money is what activates a funded
    // challenge, and only through the provider's confirmation".
    check(
      "funding_intents_authorized_has_challenge",
      sql`(${table.status} = 'authorized') = (${table.challengeId} is not null)`,
    ),
  ],
);
