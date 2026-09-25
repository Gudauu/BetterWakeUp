-- Ending a challenge early, and deleting an ended one.
--
-- `abandoned` is a terminal status: a challenge its owner ended before it
-- finished, settled exactly like `failed`. `deleted_at` records that the owner
-- deleted an ended challenge. Deleting hides it and removes nothing, so the row
-- stays for a later view of past challenges.
--
-- The drizzle migrator applies every pending file in one transaction, and
-- PostgreSQL refuses to cast a literal to an enum value added in a transaction
-- that has not committed. So every constraint below that names `abandoned`
-- compares the status as text, and nothing here writes a row with the new value.
ALTER TYPE "public"."challenge_status" ADD VALUE 'abandoned';--> statement-breakpoint
ALTER TABLE "challenges" DROP CONSTRAINT "challenges_terminal_status_has_instant";--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_deleted_only_when_terminal" CHECK ("challenges"."deleted_at" is null or "challenges"."status"::text in ('succeeded', 'failed', 'expired', 'abandoned'));--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_terminal_status_has_instant" CHECK (("challenges"."status"::text in ('succeeded', 'failed', 'expired', 'abandoned')) = ("challenges"."terminal_at" is not null));--> statement-breakpoint
-- The architecture's challenge diagram, written out again with the ending in
-- it. `abandoned` is reachable from the two statuses that hold an account's
-- slot, `active` and `recovery_pending`, and like every terminal status it is
-- never left. A deleted challenge is always terminal (the check constraint
-- above), so it can never be reopened either, and its deletion instant, like
-- its terminal instant, is written once.
--
-- The body compares statuses as text for the same reason the constraints do:
-- a PL/pgSQL body is only planned when it first runs, but the text comparison
-- keeps that true whenever the first run happens.
CREATE OR REPLACE FUNCTION challenges_status_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status::text IN ('succeeded', 'failed', 'expired', 'abandoned')
       OR (OLD.status::text = 'recovery_pending'
           AND NEW.status::text NOT IN ('active', 'failed', 'abandoned')) THEN
      RAISE EXCEPTION
        'challenge % is %: it cannot become %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF OLD.terminal_at IS NOT NULL AND NEW.terminal_at IS DISTINCT FROM OLD.terminal_at THEN
    RAISE EXCEPTION 'challenge % already reached a terminal status', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'challenge % was already deleted at %', OLD.id, OLD.deleted_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
