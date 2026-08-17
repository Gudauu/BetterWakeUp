/**
 * The money side of the system: the ledger, the payment commands that move
 * funds, the provider events that report on them, and the idempotency keys
 * that make every client command safe to retry.
 *
 * Four modeling decisions carry most of the weight here:
 *
 * - **The ledger is double entry.** Every movement is a `ledger_transactions`
 *   row with two or more `ledger_entries` under it, and the entries of one
 *   transaction sum to zero in each currency. The architecture states the
 *   invariant per challenge; per transaction is strictly stronger, always
 *   true rather than only true once a challenge settles, and it localizes a
 *   violation to the transaction that caused it instead of to a challenge
 *   whose history is otherwise fine.
 * - **The ledger is append only.** Immutability is enforced by triggers, not
 *   by convention, so a correcting entry is the only way to change what the
 *   ledger says. The single exception is unlinking a row from a deleted
 *   account or challenge, which is what lets issue 16 anonymize a user while
 *   the financial record survives its stated retention period.
 * - **A payment command is a record, not a call.** It carries the instant it
 *   becomes eligible (`execute_after`), so the twenty-four hour recovery
 *   window is a column rather than a scheduler entry, and moves through
 *   `pending`, `cancelled`, `confirmed`, and `failed` with one settled
 *   instant. Separating creation from execution is what makes recovery
 *   possible at all: no capture happens in the transaction that fails a
 *   challenge.
 * - **Both duplicate protections are the same shape.** A client idempotency
 *   key and a provider event ID are each a unique index over an
 *   externally-supplied identifier, so a replay is a database error rather
 *   than a second effect.
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { challenges } from "./challenges.ts";
import { accounts } from "./identity.ts";

/**
 * The lease on an `in_progress` idempotency key, from the architecture.
 *
 * Longer than the sixty second receipt grace on purpose: a crashed attempt
 * must not block its own retry until past the point where the completion could
 * still have counted. The sweep closes that gap by treating an unresolved key
 * inserted inside the receipt window as proof the command arrived in time.
 */
export const IDEMPOTENCY_LEASE_SECONDS = 180;

/**
 * The accounts the ledger moves value between.
 *
 * The platform never holds user money, so these are the product's own view of
 * a commitment and its outcome rather than a bank's view of a balance. The
 * sign convention is that a positive amount is a debit and a negative amount
 * is a credit, and every transaction's debits equal its credits.
 */
export const ledgerAccount = pgEnum("ledger_account", [
  /** What the user has committed and stands to forfeit. */
  "user_commitment",
  /** Value sitting at the payment provider: an authorization, or a charge in flight. */
  "payment_processor",
  /** A captured forfeit, which is platform revenue in full. */
  "platform_revenue",
  /** The processing fee that attaches to a capture, never to an authorization. */
  "processor_fees",
  /** A forfeit that could not be collected, recorded rather than quietly dropped. */
  "uncollected_forfeit",
]);

/** What a ledger transaction records. */
export const ledgerTransactionKind = pgEnum("ledger_transaction_kind", [
  "deposit_authorized",
  "authorization_released",
  "forfeit_captured",
  "forfeit_charged",
  "forfeit_uncollected",
  "processor_fee_charged",
]);

/** The provider interface's operations, each one a command the sweep can create. */
export const paymentCommandKind = pgEnum("payment_command_kind", [
  "authorize",
  "renew_authorization",
  "release_authorization",
  "capture",
  "charge_off_session",
]);

/** The four explicit states from the architecture. `pending` is the only open one. */
export const paymentCommandStatus = pgEnum("payment_command_status", [
  "pending",
  "cancelled",
  "confirmed",
  "failed",
]);

/** Matches the contract's `paymentProvider`. No provider is selected yet. */
export const paymentProvider = pgEnum("payment_provider", ["fake"]);

/** Matches the two states in the architecture's idempotency sequence. */
export const idempotencyStatus = pgEnum("idempotency_status", ["in_progress", "completed"]);

/** The statuses a payment command can no longer move out of. */
const SETTLED_COMMAND_STATUSES = sql`('cancelled', 'confirmed', 'failed')`;

/**
 * One movement of value, grouping the entries that balance against each other.
 *
 * `challenge_id` and `account_id` are nullable and unlink rather than cascade,
 * because a financial record outlives the user it belonged to. Deleting an
 * account leaves its amounts, currencies, and provider references intact with
 * nothing pointing back at a person, which is the anonymization issue 16 owes
 * its retention rule.
 */
export const ledgerTransactions = pgTable(
  "ledger_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    challengeId: uuid("challenge_id").references(() => challenges.id, { onDelete: "set null" }),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    kind: ledgerTransactionKind("kind").notNull(),
    /** When the movement happened, which for a provider event is the provider's instant. */
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    /** The provider's transaction ID, which is the link the architecture requires. */
    providerReference: text("provider_reference"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [index("ledger_transactions_challenge_idx").on(table.challengeId)],
);

/**
 * A single debit or credit. Immutable once written.
 *
 * There is no status and no terminal instant: an entry that turns out to be
 * wrong is answered with another entry, which is what makes the running sum a
 * fact rather than the current opinion of whichever code path last ran.
 */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => ledgerTransactions.id, { onDelete: "restrict" }),
    ledgerAccount: ledgerAccount("ledger_account").notNull(),
    /** Minor units. Positive is a debit, negative is a credit; never zero. */
    amountMinorUnits: integer("amount_minor_units").notNull(),
    currency: text("currency").notNull().default("USD"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("ledger_entries_transaction_idx").on(table.transactionId),
    // A zero entry records nothing and would let an "unbalanced" transaction
    // hide behind a row that looks like a second side but is not one.
    check("ledger_entries_amount_nonzero", sql`${table.amountMinorUnits} <> 0`),
  ],
);

/**
 * An instruction to the payment provider, created in one transaction and
 * executed in a later one.
 *
 * `execute_after` is what separates the two. A settlement created when a
 * challenge fails is immediate; one created when a challenge enters
 * `recovery_pending` becomes eligible only at the end of the recovery window,
 * so a user who opens the app later that day still has an intact authorization
 * to recover against.
 */
export const paymentCommands = pgTable(
  "payment_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    kind: paymentCommandKind("kind").notNull(),
    status: paymentCommandStatus("status").notNull().default("pending"),
    /**
     * A deterministic key the creator derives from what the command is for, so
     * a sweep that runs twice writes the command once. This is idempotency for
     * commands the server originates, matching the key the client supplies for
     * commands it originates.
     */
    dedupeKey: text("dedupe_key").notNull(),
    /** The command is not eligible for execution before this instant. */
    executeAfter: timestamp("execute_after", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    /** The provider's transaction ID, once the provider has acted. */
    providerReference: text("provider_reference"),
    /** Why the last attempt failed. Never carries a payment credential. */
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    /**
     * When the command left `pending`. One column for all three settled
     * statuses, so a command cannot be both cancelled and confirmed.
     */
    settledAt: timestamp("settled_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("payment_commands_dedupe_key").on(table.dedupeKey),
    // At most one open command of a kind per challenge. A cancelled or failed
    // command drops out, so a retry is a new row with its own dedupe key
    // rather than a mutation of the attempt that did not work.
    uniqueIndex("payment_commands_pending_per_challenge_kind_key")
      .on(table.challengeId, table.kind)
      .where(sql`${table.status} = 'pending'`),
    // The sweep selects commands past their eligibility instant.
    index("payment_commands_due_idx").on(table.status, table.executeAfter),
    check("payment_commands_attempts_nonnegative", sql`${table.attempts} >= 0`),
    check(
      "payment_commands_settled_status_has_instant",
      sql`(${table.status} in ${SETTLED_COMMAND_STATUSES}) = (${table.settledAt} is not null)`,
    ),
    // A confirmed command means the provider acted, so there is something to
    // reconcile against. Without this a capture could be recorded as done with
    // no trace of what was captured.
    check(
      "payment_commands_confirmed_has_provider_reference",
      sql`${table.status} <> 'confirmed' or ${table.providerReference} is not null`,
    ),
  ],
);

/**
 * Webhook deliveries, deduplicated on the provider's own event ID.
 *
 * Providers retry deliveries and can deliver the same event twice, so this
 * table is what makes the second delivery a no-op. `processed_at` distinguishes
 * an event that was received from one whose effects have been applied.
 */
export const paymentProviderEvents = pgTable(
  "payment_provider_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: paymentProvider("provider").notNull(),
    /** The provider's identifier for the event. */
    eventId: text("event_id").notNull(),
    type: text("type").notNull(),
    /** The verified payload, kept for reconciliation and dispute handling. */
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("payment_provider_events_provider_event_key").on(table.provider, table.eventId),
  ],
);

/**
 * The client idempotency keys, one row per state-changing command.
 *
 * The key is scoped to the account rather than global, so one account's key
 * space cannot be probed from another. The row is inserted `in_progress` in
 * its own short transaction before the domain change, which is why the insert
 * itself is the concurrency control: the second caller of a key loses the
 * unique index and reads the winner's row.
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** The client's key. The app uses its pending completion record's own ID. */
    key: uuid("key").notNull(),
    /** Which command the key was spent on. A key is not reusable across commands. */
    commandType: text("command_type").notNull(),
    /** Hash of the request body. A key replayed with a different body is rejected. */
    requestHash: text("request_hash").notNull(),
    /**
     * The one resource the command acts on, when it has one.
     *
     * The hash cannot answer "is a completion for this task in flight?", because
     * a hash is not a lookup key, and the sweep has to answer exactly that
     * before it marks a task missed. Storing the subject is what turns the
     * architecture's "unresolved key inside the receipt window" from a rule
     * about a request nobody kept into a row the sweep can join against. It is
     * nullable because most commands address no single resource, and it carries
     * no foreign key: the key outlives the row it names, and a cascade would
     * delete the record of a command that did run.
     */
    subjectId: uuid("subject_id"),
    status: idempotencyStatus("status").notNull().default("in_progress"),
    /**
     * When the lease on an `in_progress` row runs out. Past this instant a new
     * attempt may take the row over, because the earlier attempt did not
     * commit. Also the value the retry response reports back to the client.
     */
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now() + interval '${sql.raw(String(IDEMPOTENCY_LEASE_SECONDS))} seconds'`),
    /**
     * Which attempt currently holds the lease.
     *
     * A takeover mints a new owner, so the attempt that was taken over can tell
     * that it lost: it completes the row only while the owner is still its own,
     * and otherwise rolls its domain change back. Without this token, two
     * attempts whose lease instants happened to land on the same microsecond
     * would both believe they held the row.
     */
    leaseOwner: uuid("lease_owner").notNull().defaultRandom(),
    /** The stored response, replayed verbatim to a repeat of a completed key. */
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.key] }),
    // The sweep reads unresolved keys to decide whether a command arrived
    // inside a task's receipt window.
    index("idempotency_keys_open_idx")
      .on(table.leaseExpiresAt)
      .where(sql`${table.status} = 'in_progress'`),
    // And reads them by what they act on, which is how it recognises a
    // completion still in flight for the task it is about to mark missed.
    index("idempotency_keys_open_subject_idx")
      .on(table.commandType, table.subjectId)
      .where(sql`${table.status} = 'in_progress'`),
    // A completed key has both an instant and a result. Storing one without
    // the other would make a replay return nothing while claiming success.
    check(
      "idempotency_keys_completed_has_instant",
      sql`(${table.status} = 'completed') = (${table.completedAt} is not null)`,
    ),
    check(
      "idempotency_keys_completed_has_result",
      sql`(${table.status} = 'completed') = (${table.result} is not null)`,
    ),
    check(
      "idempotency_keys_lease_after_creation",
      sql`${table.leaseExpiresAt} > ${table.createdAt}`,
    ),
  ],
);
