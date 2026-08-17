/**
 * Identity: accounts, the external provider identities that sign in to them,
 * and the sessions the API issues in exchange.
 *
 * Three rules from the architecture are enforced here rather than in
 * application code, because they are the ones a bug would silently violate:
 *
 * - An account is keyed on nothing external. Domain tables reference the
 *   internal account ID only, so the sign-in method can change without
 *   rewriting challenge and ledger history.
 * - A provider identity is keyed on issuer plus `sub`. Email is a display
 *   attribute: Sign in with Apple may return a private relay address, and
 *   treating that as a key would split one person into two accounts, or worse,
 *   merge two people into one.
 * - Emergency Recovery is consumed at most once per account for life, which a
 *   single nullable instant expresses exactly. There is no state in which an
 *   account has spent it twice.
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** The providers version 1 accepts. Matches the contract's `identityProvider`. */
export const identityProvider = pgEnum("identity_provider", ["apple", "google"]);

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  /**
   * Display only, and absent until a provider supplies one. Apple returns it
   * on the first authorization and never again.
   */
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  /**
   * The lifetime Emergency Recovery flag. Null means unspent; the instant it
   * was spent means spent, and there is no way back. A boolean would carry the
   * same invariant with less of the audit trail, and a counter would allow a
   * second consumption to be representable.
   */
  emergencyRecoveryConsumedAt: timestamp("emergency_recovery_consumed_at", {
    withTimezone: true,
    mode: "date",
  }),
});

export const providerIdentities = pgTable(
  "provider_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    provider: identityProvider("provider").notNull(),
    /** The `iss` claim of the verified ID token. */
    issuer: text("issuer").notNull(),
    /** The `sub` claim: the provider's stable identifier for the person. */
    subject: text("subject").notNull(),
    /**
     * Display only, never a key. Nullable because a provider may withhold it
     * and because a relay address may be revoked.
     */
    email: text("email"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    lastAuthenticatedAt: timestamp("last_authenticated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The identity key. Issuer is part of it because `sub` is only unique
    // within the issuer that minted it.
    uniqueIndex("provider_identities_issuer_subject_key").on(table.issuer, table.subject),
    // Version 1 has no account-linking flow, so an account reaches at most one
    // identity per provider. Without this, a second sign-in that failed to
    // find the existing row could attach a duplicate identity to the account.
    // Leading on account_id, so it also serves lookups by account and no
    // separate account index is needed.
    uniqueIndex("provider_identities_account_provider_key").on(table.accountId, table.provider),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /**
     * A hash of the session token, never the token. A database dump must not
     * be enough to impersonate anyone, and the API only ever needs to
     * recognise a token the client presents.
     */
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    /** Set by sign-out and by account deletion. Null while the session is live. */
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_key").on(table.tokenHash),
    index("sessions_account_idx").on(table.accountId),
    check("sessions_expiry_after_creation", sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);
