CREATE TYPE "public"."challenge_authorization_status" AS ENUM('live', 'superseded', 'released', 'captured');--> statement-breakpoint
CREATE TABLE "challenge_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challenge_id" uuid NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_authorization_id" text NOT NULL,
	"provider_payment_method_id" text,
	"amount_minor_units" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" "challenge_authorization_status" DEFAULT 'live' NOT NULL,
	"authorized_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"renewal_attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "challenge_authorizations_amount_funded" CHECK ("challenge_authorizations"."amount_minor_units" >= 100),
	CONSTRAINT "challenge_authorizations_window_ordered" CHECK ("challenge_authorizations"."expires_at" > "challenge_authorizations"."authorized_at"),
	CONSTRAINT "challenge_authorizations_renewal_attempts_nonnegative" CHECK ("challenge_authorizations"."renewal_attempts" >= 0),
	CONSTRAINT "challenge_authorizations_ended_status_has_instant" CHECK (("challenge_authorizations"."status" in ('superseded', 'released', 'captured')) = ("challenge_authorizations"."ended_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "challenge_authorizations" ADD CONSTRAINT "challenge_authorizations_challenge_id_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."challenges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "challenge_authorizations_provider_key" ON "challenge_authorizations" USING btree ("provider","provider_authorization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "challenge_authorizations_live_per_challenge_key" ON "challenge_authorizations" USING btree ("challenge_id") WHERE "challenge_authorizations"."status" = 'live';--> statement-breakpoint
CREATE INDEX "challenge_authorizations_live_expiry_idx" ON "challenge_authorizations" USING btree ("status","expires_at");