CREATE TYPE "public"."idempotency_status" AS ENUM('in_progress', 'completed');--> statement-breakpoint
CREATE TYPE "public"."ledger_account" AS ENUM('user_commitment', 'payment_processor', 'platform_revenue', 'processor_fees', 'uncollected_forfeit');--> statement-breakpoint
CREATE TYPE "public"."ledger_transaction_kind" AS ENUM('deposit_authorized', 'authorization_released', 'forfeit_captured', 'forfeit_charged', 'forfeit_uncollected', 'processor_fee_charged');--> statement-breakpoint
CREATE TYPE "public"."payment_command_kind" AS ENUM('authorize', 'renew_authorization', 'release_authorization', 'capture', 'charge_off_session');--> statement-breakpoint
CREATE TYPE "public"."payment_command_status" AS ENUM('pending', 'cancelled', 'confirmed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('fake');--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"account_id" uuid NOT NULL,
	"key" uuid NOT NULL,
	"command_type" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" "idempotency_status" DEFAULT 'in_progress' NOT NULL,
	"lease_expires_at" timestamp with time zone DEFAULT now() + interval '180 seconds' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "idempotency_keys_account_id_key_pk" PRIMARY KEY("account_id","key"),
	CONSTRAINT "idempotency_keys_completed_has_instant" CHECK (("idempotency_keys"."status" = 'completed') = ("idempotency_keys"."completed_at" is not null)),
	CONSTRAINT "idempotency_keys_completed_has_result" CHECK (("idempotency_keys"."status" = 'completed') = ("idempotency_keys"."result" is not null)),
	CONSTRAINT "idempotency_keys_lease_after_creation" CHECK ("idempotency_keys"."lease_expires_at" > "idempotency_keys"."created_at")
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"ledger_account" "ledger_account" NOT NULL,
	"amount_minor_units" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_amount_nonzero" CHECK ("ledger_entries"."amount_minor_units" <> 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challenge_id" uuid,
	"account_id" uuid,
	"kind" "ledger_transaction_kind" NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challenge_id" uuid NOT NULL,
	"kind" "payment_command_kind" NOT NULL,
	"status" "payment_command_status" DEFAULT 'pending' NOT NULL,
	"dedupe_key" text NOT NULL,
	"execute_after" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"provider_reference" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "payment_commands_attempts_nonnegative" CHECK ("payment_commands"."attempts" >= 0),
	CONSTRAINT "payment_commands_settled_status_has_instant" CHECK (("payment_commands"."status" in ('cancelled', 'confirmed', 'failed')) = ("payment_commands"."settled_at" is not null)),
	CONSTRAINT "payment_commands_confirmed_has_provider_reference" CHECK ("payment_commands"."status" <> 'confirmed' or "payment_commands"."provider_reference" is not null)
);
--> statement-breakpoint
CREATE TABLE "payment_provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_challenge_id_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."challenges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_commands" ADD CONSTRAINT "payment_commands_challenge_id_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."challenges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idempotency_keys_open_idx" ON "idempotency_keys" USING btree ("lease_expires_at") WHERE "idempotency_keys"."status" = 'in_progress';--> statement-breakpoint
CREATE INDEX "ledger_entries_transaction_idx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "ledger_transactions_challenge_idx" ON "ledger_transactions" USING btree ("challenge_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_commands_dedupe_key" ON "payment_commands" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_commands_pending_per_challenge_kind_key" ON "payment_commands" USING btree ("challenge_id","kind") WHERE "payment_commands"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "payment_commands_due_idx" ON "payment_commands" USING btree ("status","execute_after");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_provider_events_provider_event_key" ON "payment_provider_events" USING btree ("provider","event_id");