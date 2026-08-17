CREATE TYPE "public"."challenge_status" AS ENUM('active', 'recovery_pending', 'succeeded', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."movement_provenance" AS ENUM('live-foreground', 'historical-query');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('scheduled', 'completed', 'skipped', 'missed', 'forgiven');--> statement-breakpoint
CREATE TYPE "public"."weekday" AS ENUM('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday');--> statement-breakpoint
CREATE TABLE "challenge_schedule_days" (
	"challenge_id" uuid NOT NULL,
	"weekday" "weekday" NOT NULL,
	"deadline_local" time NOT NULL,
	CONSTRAINT "challenge_schedule_days_challenge_id_weekday_pk" PRIMARY KEY("challenge_id","weekday")
);
--> statement-breakpoint
CREATE TABLE "challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"status" "challenge_status" DEFAULT 'active' NOT NULL,
	"required_task_count" integer NOT NULL,
	"step_target" integer NOT NULL,
	"no_regret_minutes" integer NOT NULL,
	"time_zone" text NOT NULL,
	"deposit_minor_units" integer NOT NULL,
	"deposit_currency" text DEFAULT 'USD' NOT NULL,
	"policy_version" text NOT NULL,
	"projected_end_date" date NOT NULL,
	"paused_at" timestamp with time zone,
	"deposit_secured" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "challenges_required_task_count_positive" CHECK ("challenges"."required_task_count" > 0),
	CONSTRAINT "challenges_step_target_positive" CHECK ("challenges"."step_target" > 0),
	CONSTRAINT "challenges_no_regret_minutes_nonnegative" CHECK ("challenges"."no_regret_minutes" >= 0),
	CONSTRAINT "challenges_deposit_zero_or_funded" CHECK ("challenges"."deposit_minor_units" = 0 or "challenges"."deposit_minor_units" >= 100),
	CONSTRAINT "challenges_terminal_status_has_instant" CHECK (("challenges"."status" in ('succeeded', 'failed', 'expired')) = ("challenges"."terminal_at" is not null)),
	CONSTRAINT "challenges_terminal_after_activation" CHECK ("challenges"."terminal_at" is null or "challenges"."activated_at" is null or "challenges"."terminal_at" >= "challenges"."activated_at"),
	CONSTRAINT "challenges_recovery_requires_deposit" CHECK ("challenges"."status" <> 'recovery_pending' or "challenges"."deposit_minor_units" > 0)
);
--> statement-breakpoint
CREATE TABLE "scheduled_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challenge_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"task_date" date NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"pause_cutoff" timestamp with time zone NOT NULL,
	"status" "task_status" DEFAULT 'scheduled' NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"skipped_at" timestamp with time zone,
	"missed_at" timestamp with time zone,
	"forgiven_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_tasks_sequence_positive" CHECK ("scheduled_tasks"."sequence" > 0),
	CONSTRAINT "scheduled_tasks_cutoff_at_or_before_deadline" CHECK ("scheduled_tasks"."pause_cutoff" <= "scheduled_tasks"."deadline"),
	CONSTRAINT "scheduled_tasks_completed_status_has_instant" CHECK (("scheduled_tasks"."status" = 'completed') = ("scheduled_tasks"."acknowledged_at" is not null)),
	CONSTRAINT "scheduled_tasks_skipped_status_has_instant" CHECK (("scheduled_tasks"."status" = 'skipped') = ("scheduled_tasks"."skipped_at" is not null)),
	CONSTRAINT "scheduled_tasks_missed_status_has_instant" CHECK (("scheduled_tasks"."status" in ('missed', 'forgiven')) = ("scheduled_tasks"."missed_at" is not null)),
	CONSTRAINT "scheduled_tasks_forgiven_status_has_instant" CHECK (("scheduled_tasks"."status" = 'forgiven') = ("scheduled_tasks"."forgiven_at" is not null)),
	CONSTRAINT "scheduled_tasks_forgiven_after_missed" CHECK ("scheduled_tasks"."forgiven_at" is null or "scheduled_tasks"."forgiven_at" >= "scheduled_tasks"."missed_at")
);
--> statement-breakpoint
CREATE TABLE "task_completions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"observation_started_at" timestamp with time zone NOT NULL,
	"observation_ended_at" timestamp with time zone NOT NULL,
	"steps" integer NOT NULL,
	"provenance" "movement_provenance" NOT NULL,
	"source" text NOT NULL,
	"app_version" text NOT NULL,
	"verification_policy_version" text NOT NULL,
	CONSTRAINT "task_completions_steps_nonnegative" CHECK ("task_completions"."steps" >= 0),
	CONSTRAINT "task_completions_observation_ordered" CHECK ("task_completions"."observation_ended_at" >= "task_completions"."observation_started_at")
);
--> statement-breakpoint
ALTER TABLE "challenge_schedule_days" ADD CONSTRAINT "challenge_schedule_days_challenge_id_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."challenges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_challenge_id_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."challenges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_completions" ADD CONSTRAINT "task_completions_task_id_scheduled_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."scheduled_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "challenges_open_per_account_key" ON "challenges" USING btree ("account_id") WHERE "challenges"."status" in ('active', 'recovery_pending');--> statement-breakpoint
CREATE INDEX "challenges_status_idx" ON "challenges" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_tasks_challenge_sequence_key" ON "scheduled_tasks" USING btree ("challenge_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_tasks_challenge_date_key" ON "scheduled_tasks" USING btree ("challenge_id","task_date");--> statement-breakpoint
CREATE INDEX "scheduled_tasks_deadline_idx" ON "scheduled_tasks" USING btree ("status","deadline");--> statement-breakpoint
CREATE INDEX "scheduled_tasks_pause_cutoff_idx" ON "scheduled_tasks" USING btree ("status","pause_cutoff");--> statement-breakpoint
CREATE UNIQUE INDEX "task_completions_task_key" ON "task_completions" USING btree ("task_id");