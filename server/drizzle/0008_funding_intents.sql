CREATE TYPE "public"."funding_intent_status" AS ENUM('pending', 'authorized', 'failed');--> statement-breakpoint
CREATE TABLE "funding_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_authorization_id" text NOT NULL,
	"status" "funding_intent_status" DEFAULT 'pending' NOT NULL,
	"configuration" jsonb NOT NULL,
	"policy_version" text NOT NULL,
	"deposit_minor_units" integer NOT NULL,
	"deposit_currency" text DEFAULT 'USD' NOT NULL,
	"challenge_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "funding_intents_deposit_funded" CHECK ("funding_intents"."deposit_minor_units" >= 100),
	CONSTRAINT "funding_intents_settled_status_has_instant" CHECK (("funding_intents"."status" in ('authorized', 'failed')) = ("funding_intents"."settled_at" is not null)),
	CONSTRAINT "funding_intents_authorized_has_challenge" CHECK (("funding_intents"."status" = 'authorized') = ("funding_intents"."challenge_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "funding_intents" ADD CONSTRAINT "funding_intents_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_intents" ADD CONSTRAINT "funding_intents_challenge_id_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."challenges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "funding_intents_provider_authorization_key" ON "funding_intents" USING btree ("provider","provider_authorization_id");--> statement-breakpoint
CREATE INDEX "funding_intents_account_idx" ON "funding_intents" USING btree ("account_id","status");