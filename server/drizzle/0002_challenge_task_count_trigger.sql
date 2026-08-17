-- The two challenge invariants that are counts across many rows, and so cannot
-- be a check constraint (which sees one row) or a unique index (which sees one
-- key):
--
--   * While a challenge is `active`, the number of task rows in `scheduled` or
--     `completed` status equals the required task count.
--   * A challenge succeeds only after its required completion count is reached.
--
-- Both are carried by deferred constraint triggers. Deferral is not a detail:
-- every transition that consumes a task appends its replacement in the same
-- transaction, so the count is legitimately wrong between the two statements
-- and only has to be right at commit.
--
-- The task count is scoped to `active` deliberately. A `missed` task drops the
-- count below the required total by design, and it stays below while the
-- challenge sits in `recovery_pending`, until the task is forgiven or the
-- challenge fails. That is why the trigger reads the challenge status rather
-- than counting unconditionally.

CREATE FUNCTION assert_challenge_task_counts(target uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  challenge_state text;
  required integer;
  observed integer;
BEGIN
  SELECT c.status::text, c.required_task_count
    INTO challenge_state, required
    FROM challenges c
    WHERE c.id = target;

  -- The challenge was deleted in this transaction, taking its tasks with it.
  -- There is no challenge left to hold an invariant about.
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF challenge_state = 'active' THEN
    SELECT count(*)
      INTO observed
      FROM scheduled_tasks t
      WHERE t.challenge_id = target
        AND t.status IN ('scheduled', 'completed');

    IF observed <> required THEN
      RAISE EXCEPTION
        'active challenge % holds % scheduled or completed tasks but requires %',
        target, observed, required
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF challenge_state = 'succeeded' THEN
    SELECT count(*)
      INTO observed
      FROM scheduled_tasks t
      WHERE t.challenge_id = target
        AND t.status = 'completed';

    IF observed < required THEN
      RAISE EXCEPTION
        'challenge % succeeded with % completed tasks but requires %',
        target, observed, required
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
END;
$$;
--> statement-breakpoint

-- A task row moving in, out, or between challenges can break the count for the
-- challenge it left as well as the one it joined, so both are checked.
CREATE FUNCTION challenge_task_counts_from_task() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM assert_challenge_task_counts(OLD.challenge_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM assert_challenge_task_counts(NEW.challenge_id);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- The challenge side matters because the invariant is conditional on status: a
-- challenge returning to `active` from `recovery_pending`, or claiming
-- `succeeded`, changes which rule applies without touching a single task row.
CREATE FUNCTION challenge_task_counts_from_challenge() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_challenge_task_counts(NEW.id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER scheduled_tasks_challenge_task_counts
  AFTER INSERT OR UPDATE OR DELETE ON scheduled_tasks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION challenge_task_counts_from_task();
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER challenges_challenge_task_counts
  AFTER INSERT OR UPDATE ON challenges
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION challenge_task_counts_from_challenge();
