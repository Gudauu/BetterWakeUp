CREATE TABLE "rate_limit_counters" (
	"bucket" text NOT NULL,
	"subject" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"hits" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "rate_limit_counters_bucket_subject_window_start_pk" PRIMARY KEY("bucket","subject","window_start"),
	CONSTRAINT "rate_limit_counters_hits_positive" CHECK ("rate_limit_counters"."hits" > 0)
);
--> statement-breakpoint
CREATE INDEX "rate_limit_counters_window_idx" ON "rate_limit_counters" USING btree ("window_start");