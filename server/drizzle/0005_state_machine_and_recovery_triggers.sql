-- Three invariants that the schema expresses only as long as writes arrive
-- through code that respects the state machine. Raw SQL does not, and the
-- assault suite is the test that says so.
--
--   * One terminal outcome per scheduled task, with `missed` supersedable by
--     `forgiven` at most once. A single status column stops a task carrying two
--     outcomes at rest, but nothing stopped an UPDATE moving a `completed` task
--     to `skipped`, or a `forgiven` task back to `missed` so it could be
--     forgiven a second time.
--   * One terminal outcome per challenge. Same shape: `succeeded`, `failed`,
--     and `expired` are terminal in the architecture's diagram, and an UPDATE
--     could leave any of them.
--   * Emergency Recovery is consumed at most once per account. A nullable
--     instant makes a second consumption unrepresentable only in the sense that
--     there is nowhere to record it; overwriting the first one with a later
--     instant, or clearing it back to NULL, spends the lifetime allowance
--     again and leaves no trace.
--
-- All three are rules about statements rather than about rows, so they are
-- immediate BEFORE triggers raising `restrict_violation`, matching the ledger's
-- append-only triggers. A deferred constraint trigger is the wrong tool: there
-- is no legitimate intermediate state to pass through.
--
-- These triggers refuse transitions. They do not require them: a status change
-- that is legal here still has to satisfy the check constraints tying each
-- status to its instant, and the deferred task count trigger.

-- `scheduled` may go to any outcome. `missed` may be superseded by `forgiven`
-- exactly once, which is what forbidding every other move out of `missed` and
-- every move out of `forgiven` amounts to.
CREATE FUNCTION scheduled_tasks_outcome_terminal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status IN ('completed', 'skipped', 'forgiven')
       OR (OLD.status = 'missed' AND NEW.status <> 'forgiven') THEN
      RAISE EXCEPTION
        'task % is %: it cannot become %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- An outcome instant records when something happened. Rewriting one is how a
  -- second forgiveness would be recorded without a second status change.
  IF (OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at)
     OR (OLD.skipped_at IS NOT NULL AND NEW.skipped_at IS DISTINCT FROM OLD.skipped_at)
     OR (OLD.missed_at IS NOT NULL AND NEW.missed_at IS DISTINCT FROM OLD.missed_at)
     OR (OLD.forgiven_at IS NOT NULL AND NEW.forgiven_at IS DISTINCT FROM OLD.forgiven_at) THEN
    RAISE EXCEPTION 'the outcome instants of task % are immutable once set', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER scheduled_tasks_outcome_terminal
  BEFORE UPDATE ON scheduled_tasks
  FOR EACH ROW EXECUTE FUNCTION scheduled_tasks_outcome_terminal();
--> statement-breakpoint

-- The architecture's challenge diagram, written out. `recovery_pending` is the
-- only non-terminal status a challenge can return from, and it returns only to
-- `active` or `failed`.
CREATE FUNCTION challenges_status_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status IN ('succeeded', 'failed', 'expired')
       OR (OLD.status = 'recovery_pending' AND NEW.status NOT IN ('active', 'failed')) THEN
      RAISE EXCEPTION
        'challenge % is %: it cannot become %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF OLD.terminal_at IS NOT NULL AND NEW.terminal_at IS DISTINCT FROM OLD.terminal_at THEN
    RAISE EXCEPTION 'challenge % already reached a terminal status', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER challenges_status_transition
  BEFORE UPDATE ON challenges
  FOR EACH ROW EXECUTE FUNCTION challenges_status_transition();
--> statement-breakpoint

-- One per account for life. Consuming it is a one-way move from NULL, and the
-- instant it was consumed at is part of the audit trail rather than a flag.
CREATE FUNCTION accounts_recovery_consumed_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.emergency_recovery_consumed_at IS NOT NULL
     AND NEW.emergency_recovery_consumed_at IS DISTINCT FROM OLD.emergency_recovery_consumed_at THEN
    RAISE EXCEPTION
      'account % already consumed its lifetime Emergency Recovery at %',
      OLD.id, OLD.emergency_recovery_consumed_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER accounts_recovery_consumed_once
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_recovery_consumed_once();
