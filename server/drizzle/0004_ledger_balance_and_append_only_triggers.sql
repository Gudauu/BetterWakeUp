-- The ledger's two guarantees, neither of which a check constraint or a unique
-- index can express:
--
--   * Every transaction's entries balance to zero, in each currency. This is a
--     sum across many rows, so it is a deferred constraint trigger for the same
--     reason the challenge task count is: a transaction row and its entries
--     arrive as several statements and are legitimately unbalanced between
--     them, only having to be right at commit.
--   * The ledger is append only. Immutability is a rule about statements
--     rather than about rows, so it is an immediate trigger that rejects the
--     statement itself.
--
-- The architecture states the balance invariant per challenge. Enforcing it per
-- transaction is strictly stronger: it holds continuously rather than only once
-- a challenge settles, and it names the transaction that broke it instead of
-- leaving an otherwise sound challenge history that no longer adds up.

CREATE FUNCTION assert_ledger_transaction_balanced(target uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  entry_count integer;
  unbalanced record;
BEGIN
  -- The transaction was removed in this transaction. Deletes are refused by the
  -- append-only trigger, so this only happens on a rolled-back path, and there
  -- is no transaction left to hold an invariant about.
  PERFORM 1 FROM ledger_transactions WHERE id = target;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*) INTO entry_count FROM ledger_entries WHERE transaction_id = target;

  -- A transaction with no entries records no movement. Allowing one would let
  -- a provider reference exist with nothing behind it.
  IF entry_count = 0 THEN
    RAISE EXCEPTION 'ledger transaction % has no entries', target
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Grouping by currency is also what rejects a transaction whose two sides are
  -- in different currencies: each currency then has one unbalanced side.
  SELECT e.currency, sum(e.amount_minor_units) AS total
    INTO unbalanced
    FROM ledger_entries e
    WHERE e.transaction_id = target
    GROUP BY e.currency
    HAVING sum(e.amount_minor_units) <> 0
    LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'ledger transaction % is unbalanced in %: entries sum to %',
      target, unbalanced.currency, unbalanced.total
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION ledger_balance_from_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM assert_ledger_transaction_balanced(OLD.transaction_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM assert_ledger_transaction_balanced(NEW.transaction_id);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- The transaction side is what catches a transaction row written with no
-- entries at all, which no trigger on the entry table can ever see.
CREATE FUNCTION ledger_balance_from_transaction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_ledger_transaction_balanced(NEW.id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER ledger_entries_balance
  AFTER INSERT OR UPDATE OR DELETE ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_balance_from_entry();
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER ledger_transactions_balance
  AFTER INSERT OR UPDATE ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_balance_from_transaction();
--> statement-breakpoint

-- An entry is never corrected in place. The answer to a wrong entry is another
-- entry, which is what makes the running sum a fact rather than the current
-- opinion of whichever code path last ran.
CREATE FUNCTION ledger_entries_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger entries are append only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_append_only();
--> statement-breakpoint

-- A transaction is immutable in everything except the two links back to a
-- person. Those are allowed to be set to NULL and nothing else, which is
-- exactly the `ON DELETE SET NULL` the account and challenge foreign keys
-- perform: deleting an account leaves the amounts, currencies, and provider
-- references intact with nothing pointing back at whose they were.
CREATE FUNCTION ledger_transactions_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger transactions are append only: DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF ROW(NEW.id, NEW.kind, NEW.occurred_at, NEW.provider_reference, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.kind, OLD.occurred_at, OLD.provider_reference, OLD.created_at) THEN
    RAISE EXCEPTION 'ledger transaction % is immutable', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.challenge_id IS NOT NULL AND NEW.challenge_id IS DISTINCT FROM OLD.challenge_id THEN
    RAISE EXCEPTION 'ledger transaction % may only be unlinked from its challenge', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.account_id IS NOT NULL AND NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'ledger transaction % may only be unlinked from its account', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER ledger_transactions_append_only
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION ledger_transactions_append_only();
