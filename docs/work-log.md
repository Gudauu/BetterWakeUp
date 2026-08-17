# Implementation work log

Progress against `docs/phased-plan.markdown`, and the items an agent cannot
complete on its own. Anything under "Handed back" needs a human with account
access, a vendor relationship, or a physical device, and is blocking the issue
it sits under until someone does it.

## Completed

### Issue 1: repository skeleton and toolchain

pnpm workspace over `server`, `infra`, and `packages/contract`, with TypeScript
5.9 in `strict` and `noUncheckedIndexedAccess`, Biome for lint and format, and
Vitest projects. `pnpm run check` runs lint, typecheck, and tests from the
repository root in one command, which is the issue's acceptance boundary.

`app/` holds a README rather than a package. The Expo project is issue 27, and
scaffolding it early would put an unused jest-expo toolchain in the repository
for the whole of phases 1 through 4.

### Issue 2: continuous integration

`.github/workflows/ci.yml` with two jobs. `check` installs from the frozen
lockfile and runs lint, typecheck, and tests. `commits` runs commitlint over the
pull request's commit range, from the base SHA to the head SHA, checking out the
head commit rather than the synthesized merge commit so the range holds only the
commits under review.

The rules live in `commitlint.config.ts`, which extends
`@commitlint/config-conventional` and restricts the type list to the nine types
`CONTRIBUTING.md` allows, forbids a trailing period, and caps the subject and
body lines at 72 columns. The subject cap is new: the contributing guide stated
72 for the body only, and left the subject unbounded.

`tools/` is a workspace package holding tests that load the real config through
`@commitlint/load` and assert both the accepting and the rejecting cases, so the
rules are verifiable without pushing a commit. The root `typecheck` now also
typechecks the two root config files, which no package tsconfig covered.

### Issue 4: shared contract package

`packages/contract` now carries the Zod schemas for all fourteen operations
under "Endpoints" in `docs/architecture.md`, the `MovementObservation` type,
the error codes, and the idempotency header. Every exported type is inferred
from a schema, so no request or response shape is written twice.

`src/endpoints.ts` is the registry: method, path, whether a session is
required, whether an idempotency key is required, and the request and response
schemas. Making the route table data rather than prose is what lets a test
assert that no sweep route exists, that no draft challenge resource exists, and
that every state-changing client command demands an idempotency key.

The issue's acceptance boundary is generation checked in CI. Zod infers the
client types directly, so the generated artifact is the JSON Schema document at
`packages/contract/generated/contract.schema.json`, produced by
`pnpm --filter @betterwakeup/contract run generate`. A test rebuilds it and
compares it byte for byte with the checked-in file, and CI already runs the
tests, so a stale artifact fails the build.

Two supporting changes. `tsconfig.base.json` now sets
`allowImportingTsExtensions`, so relative imports name the `.ts` file they
actually resolve to and the generator runs under Node's own type stripping
without a bundler or an extra dependency. And Biome no longer formats
`generated` directories, because the generator decides that file's layout and
the two formatters disagreed.

Error codes carry a disposition, `retry` or `reject`, in the contract itself.
The app's pending completion store needs exactly that distinction to decide
whether a record stays pending or is surfaced as rejected, and putting it here
means the rule is not implemented a second time in the app.

### Issue 5: database harness

`server/src/db` holds the Drizzle setup, the Neon serverless WebSocket `Pool`,
and the migration runner. The Neon driver cannot reach a plain PostgreSQL
container, and the container is what keeps the suite off the vendor the
architecture wants replaceable, so `createDatabase` selects between the Neon
serverless driver and node-postgres from the connection string's host. Both are
the same Drizzle PostgreSQL dialect, so one `Database` type covers them and no
caller learns which driver it holds. The one place the drivers show through is
raw `execute`, whose result shape differs, and `executeRows` contains that.

`server/drizzle` is the migration folder, currently an empty journal: the first
migration arrives with the identity schema in issue 6. `db:generate` writes
migrations from the schema, `db:migrate` applies them to `DATABASE_URL` under
plain `node`, and nothing else applies SQL to a database.

Test isolation is a database per test rather than a transaction per test. One
container starts per run, migrations are applied once to a template database,
and each test copies that template with `CREATE DATABASE ... TEMPLATE`. A
transaction-per-test harness would have been cheaper and would have made the
issue's own acceptance test impossible to write, since `FOR UPDATE SKIP LOCKED`
only means anything with two sessions competing.

The acceptance test is `server/test/integration/database-harness.test.ts`: it
opens a transaction, claims a row with `FOR UPDATE SKIP LOCKED` while a second
connection claims the next row rather than blocking on the first, and rolls both
back leaving the table untouched. It also proves migrations reached the test
database and that one test's writes are invisible to the next.

The integration tests are their own Vitest project, `server-integration`, so the
unit tests still run with no Docker daemon present. Both projects run under
`pnpm run test`, and the GitHub Actions runner has Docker, so CI covers them.

### Issue 6: identity schema

Three tables in `server/src/db/schema/identity.ts`, applied by the first
migration, `server/drizzle/0000_identity.sql`.

`accounts` is keyed on nothing external, so the sign-in method can change
without rewriting challenge or ledger history. It carries the display name and
`emergency_recovery_consumed_at`. That column is the lifetime Emergency
Recovery flag: null means unspent, and an instant means spent. A nullable
instant was chosen over a boolean because it keeps the audit trail, and over a
counter because a counter makes a second consumption representable, which the
architecture's "consumed at most once per account" says it never is.

`provider_identities` is keyed on `(issuer, subject)` by unique index. Issuer is
part of the key because a provider's `sub` is only unique within the issuer that
minted it, which the acceptance test exercises by giving Apple and Google the
same subject string. A second unique index on `(account_id, provider)` says an
account holds at most one identity per provider: version 1 has no
account-linking flow, and it also serves lookups by account, so no separate
index on `account_id` exists. Email is a plain nullable column on this table
and is never a key, since Apple's private relay addresses would otherwise split
one person into two accounts or merge two people into one.

`sessions` stores a hash of the session token rather than the token, so a
database dump is not enough to impersonate anyone, with a unique index on the
hash, a check that expiry follows creation, and `revoked_at` for sign-out and
deletion. Both child tables cascade on account delete, which issue 16 needs.

The acceptance test is `server/test/integration/identity-schema.test.ts`. Every
write goes through Drizzle with no service layer, and each negative case
asserts the PostgreSQL SQLSTATE, so a passing test says the constraint exists
rather than that some function remembered to check. Drizzle wraps driver errors
in a `DrizzleQueryError`, so the test walks the `cause` chain for the code.

Also added `server/test/integration/schema-drift.test.ts`, which compares the
migrated database's columns against the ones the Drizzle schema declares. It
was verified to fail by adding a column to the schema without regenerating,
which is the exact mistake it exists to catch.

### Issue 7: challenge and task schema

Four tables in `server/src/db/schema/challenges.ts`, applied by
`server/drizzle/0001_challenges.sql`, with the aggregate invariants in the
hand-authored `server/drizzle/0002_challenge_task_count_trigger.sql`.

`challenges` holds the configuration the architecture's "Challenge time model"
lists: the confirmed time zone, required task count, step target, No Regret
minutes, deposit in minor units, policy version, and projected end date. Pause
is `paused_at` on the challenge rather than a flag per task, because pause is a
mode: the sweep consumes tasks as their own cutoffs pass, and only a resume
ends it.

One active challenge per account is a partial unique index on `account_id`
covering `active` and `recovery_pending`. `recovery_pending` holds the slot
because that challenge is still running and may return to `active`; every
terminal status drops out of the index, which is what guarantees the slot comes
back and a forgotten paused challenge cannot lock an account out.

One terminal outcome per challenge is a single `terminal_at` column paired with
the status by a check constraint, so there is no half-closed challenge with an
outcome and no time, or a time and no outcome. A second check makes
`recovery_pending` unreachable without a deposit, which is the architecture's
rule that a lifetime allowance must not be consumable on a challenge that costs
nothing to fail.

`challenge_schedule_days` is a row per active weekday with a composite primary
key, so a weekday appearing twice in one schedule is unrepresentable rather
than merely rejected somewhere.

`scheduled_tasks` carries the UTC instants for deadline and pause cutoff, the
local task date, and a `sequence` ordinal. Its outcome is one status column
plus one instant per outcome, each tied to the status by a check constraint.
That is where "one terminal outcome per scheduled task" comes from, and
`forgiven_at` being one column is why a task cannot be forgiven twice. A
forgiven task keeps its `missed_at`, since recovery supersedes the miss rather
than deleting it.

`task_completions` is its own table with a unique index on `task_id`, which is
"one completion result per scheduled task". A completion is evidence, not a
flag, so it stores the observation window, step count, provenance, source, app
version, and verification policy version.

Two invariants are counts across rows and cannot be a check constraint or a
unique index: the task count while a challenge is `active`, and the rule that a
challenge succeeds only after its required completion count is reached. Both
live in one plpgsql function called by two deferred constraint triggers, one on
each table. The challenge-side trigger matters because the rule is conditional
on status: a challenge returning to `active` changes which rule applies without
touching a task row. The function returns early when the challenge no longer
exists, which is the cascade-delete case, where the trigger fires at commit
against a challenge that is already gone.

The task count is scoped to `active` deliberately. A missed task drops the count
below the required total by design and stays below through `recovery_pending`,
until the task is forgiven or the challenge fails.

The acceptance test is `server/test/integration/challenge-schema.test.ts`: 21
tests writing through Drizzle with no service layer, each asserting a SQLSTATE.
The trigger tests were verified to fail by making the function return early,
which is the only way to tell a working constraint from an assertion that never
fires. `server/test/support/challenge-fixtures.ts` builds a challenge the
database will accept, since the deferred trigger means a challenge and its full
set of tasks have to arrive in one transaction; issue 9's assault suite starts
from the same fixtures. The SQLSTATE helpers moved out of the identity test into
`server/test/support/sql-errors.ts`.

### Issue 8: ledger, payment command, and idempotency schema

Five tables in `server/src/db/schema/payments.ts`, applied by
`server/drizzle/0003_payments.sql`, with the ledger's two trigger-carried
guarantees in the hand-authored
`server/drizzle/0004_ledger_balance_and_append_only_triggers.sql`.

The ledger is double entry across two tables. `ledger_transactions` is one
movement of value and `ledger_entries` are the sides that balance against each
other, with a positive amount a debit and a negative amount a credit. The
architecture states the balance invariant per challenge; the trigger enforces it
per transaction, grouped by currency. That is strictly stronger, since a
transaction that balances always implies a challenge that balances, and it is
also continuously true rather than only true once a challenge settles. It names
the transaction that broke the rule instead of leaving a challenge history that
no longer adds up with no indication of where. Grouping by currency is what
rejects a transaction whose two sides are in different currencies but whose
numbers happen to cancel.

The trigger fires from both sides. The entry-side trigger catches an unbalanced
set; the transaction-side trigger catches a transaction row written with no
entries under it at all, which no trigger on the entry table can ever see. Both
are deferred, for the same reason the task count trigger is: a transaction and
its entries arrive as separate statements and are legitimately unbalanced
between them.

The ledger is append only, enforced by immediate triggers rather than by
convention. An entry can never be updated or deleted, so the answer to a wrong
entry is another entry. A transaction is immutable in everything except the two
foreign keys back to a person, which may be set to NULL and to nothing else.
That single exception is what `ON DELETE SET NULL` on `account_id` and
`challenge_id` performs: deleting an account leaves the amounts, currencies, and
provider references intact with nothing pointing back at whose they were. It is
the anonymization issue 16 owes the retention rule for financial records, and it
is why the ledger does not cascade with the account the way sessions and
idempotency keys do.

`payment_commands` makes a payment an instruction recorded in one transaction
and executed in a later one. `execute_after` is what separates the two, so the
recovery window is a column rather than a scheduler entry, and no capture
happens in the transaction that fails a challenge. The status column is the
architecture's `pending`, `cancelled`, `confirmed`, and `failed`, paired with
one `settled_at` instant so a command cannot be both cancelled and confirmed. A
confirmed command must carry a provider reference, since a capture recorded as
done with no trace of what was captured cannot be reconciled. Idempotency is a
unique `dedupe_key` the creator derives from what the command is for, so a sweep
that runs twice writes the command once, plus a partial unique index allowing at
most one `pending` command of a kind per challenge. A retry after a failure is a
new row with its own key rather than a mutation of the attempt that did not
work, which keeps the failed attempt readable.

`payment_provider_events` and `idempotency_keys` are the same shape applied to
the two sources of duplicates. Both are unique indexes over an
externally-supplied identifier, so a redelivered webhook and a retried client
command are each a database error rather than a second effect. The client key is
scoped to the account rather than global, so one account's key space cannot be
probed from another. The lease default is `now() + interval '180 seconds'`,
matching the architecture, and a check constraint ties `completed` to both its
instant and its stored result in each direction, since a result on a key that
never completed would be replayed by a reader that trusts the status.

The acceptance test is `server/test/integration/payments-schema.test.ts`: 22
tests writing through Drizzle with no service layer. Both trigger sets were
verified to fail, the balance trigger by making its function return early
(exactly the three balance tests failed) and the append-only triggers by
attaching them with `WHEN (false)` (exactly the three immutability tests
failed).

### Issue 9: invariant assault suite

`server/test/integration/invariant-assault.test.ts` attempts every invariant
under "Challenge state" through raw SQL. The suite opens its own `pg.Client`
against the test database and writes plain statements: no Drizzle, no schema
module, and no server code anywhere in the path. `server/test/support/raw-sql.ts`
is the session, and `server/test/support/raw-challenge.ts` rebuilds the valid
challenge fixture in SQL rather than importing the Drizzle one.

Duplicating the fixture is deliberate. Reusing the Drizzle builder would put the
schema module back in the path of the tests whose whole point is that it is not
there, and if the two builders ever disagree about what a valid challenge looks
like, one of them is wrong about the database.

Three invariants did not survive the change of writer, because Drizzle's types
had been refusing the write rather than the database:

* A `completed` task could be updated to `skipped`, and a `forgiven` task back to
  `missed` and then forgiven a second time. The check constraints tie each status
  to its instant, but say nothing about which status may follow which.
* A `succeeded` challenge could return to `active`, and a terminal challenge
  could be given a second `terminal_at`.
* An account's lifetime Emergency Recovery could be spent again by overwriting
  `emergency_recovery_consumed_at` with a later instant, or by clearing it to
  `NULL`. A nullable instant makes a second consumption unrepresentable only in
  the sense that there is nowhere to record it.

`server/drizzle/0005_state_machine_and_recovery_triggers.sql` closes all three
with immediate `BEFORE UPDATE` triggers raising SQLSTATE `23001`, matching the
ledger's append-only triggers. They are transition rules, not aggregates, so
deferral would buy nothing: there is no legitimate intermediate state to pass
through. The challenge trigger writes out the architecture's diagram directly,
including that `recovery_pending` leaves only for `active` or `failed`.

The triggers refuse transitions and do not require them. A legal status change
still has to satisfy the check constraints tying each status to its instant and
the deferred task count trigger, which is why the existing Drizzle suites needed
no changes.

19 tests, one section per invariant, each asserting a SQLSTATE. All three new
triggers were verified to fire by making each function return early: exactly the
six tests that assert `23001` against them failed, and nothing else did.

## Handed back

### Issue 3: step accuracy spike

Skipped, not attempted. The issue is a throwaway Expo build measuring
`expo-sensors` step counts on physical iOS and Android hardware: accuracy
against a manual count, indoor use, behavior after a reboot, phone in a pocket
against in a hand, and permission denial. None of that can be produced without
the devices and an Apple Developer account, and a number invented here would be
worse than no number, since it closes release gate 1 and sets the default step
target.

Nothing downstream is blocked meanwhile. Issue 4 depends on issue 1 only, and
the contract expresses the target in steps regardless of what the spike finds,
so the finding changes a default rather than a shape.

### Issue 2: CI must block merge

The workflow file cannot make itself required. Someone with repository admin
needs to add a branch protection or ruleset entry on `main` requiring the
`Lint, typecheck, and test` and `Commit messages` checks, and there is no `git
remote` configured yet, so the repository does not exist on GitHub to configure.
Until that is done, issue 2's acceptance boundary is met in the "CI runs on
pull requests" half only.

Note also that the orchestrator's own commits on this branch do not satisfy the
commitlint rules. They are automation artifacts, not authored commits, so
squashing or rewriting them before a pull request is expected.
