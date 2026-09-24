-- The walk window: how long before each deadline a walk opens, and the
-- instant each task opens at.
--
-- Challenges that exist before this migration were created without a window,
-- so they take the product's default of 10 minutes. Their tasks are backfilled
-- with the same rule the schedule engine applies to new ones: the deadline less
-- the window, or the previous task's deadline if that is later, and never
-- after the task's own deadline. The defaults exist only for the backfill and
-- are dropped, so every later insert has to state both values.
ALTER TABLE "challenges" ADD COLUMN "walk_window_minutes" integer NOT NULL DEFAULT 10;--> statement-breakpoint
ALTER TABLE "challenges" ALTER COLUMN "walk_window_minutes" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "opens_at" timestamp with time zone;--> statement-breakpoint
UPDATE "scheduled_tasks" AS "task"
SET "opens_at" = least(
  "task"."deadline",
  greatest(
    "task"."deadline" - make_interval(mins => "challenge"."walk_window_minutes"),
    coalesce("previous"."deadline", '-infinity'::timestamptz)
  )
)
FROM "challenges" AS "challenge", "scheduled_tasks" AS "self"
LEFT JOIN "scheduled_tasks" AS "previous"
  ON "previous"."challenge_id" = "self"."challenge_id"
  AND "previous"."sequence" = "self"."sequence" - 1
WHERE "self"."id" = "task"."id" AND "challenge"."id" = "task"."challenge_id";--> statement-breakpoint
-- The backfill fires the deferred task count trigger once per row, and
-- PostgreSQL refuses to alter a table with trigger events still pending in
-- the transaction. Running them now empties the queue; the backfill changed
-- no status, so they pass. Every deferrable constraint in this schema is
-- initially deferred, so switching back restores the migration's own mode.
SET CONSTRAINTS ALL IMMEDIATE;--> statement-breakpoint
SET CONSTRAINTS ALL DEFERRED;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ALTER COLUMN "opens_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_walk_window_minutes_in_range" CHECK ("challenges"."walk_window_minutes" between 3 and 119);--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_opens_at_or_before_deadline" CHECK ("scheduled_tasks"."opens_at" <= "scheduled_tasks"."deadline");
