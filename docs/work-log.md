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

### Issue 10: Lambda and Hono skeleton

`server/src/lambda/handler.ts` is the entry point, and the discrimination the
architecture asks for happens in it before anything else runs. A scheduled
invocation goes to `runSweep` and never constructs a `Request`, never enters
Hono, and never reaches a route table.

The two predicates in `server/src/lambda/events.ts` both read the envelope AWS
builds rather than anything a caller supplies. A Function URL event is
recognized by `requestContext.http.method`, which the integration writes around
the request and no body can add, and an HTTP event is excluded before the
scheduled test runs at all. A request whose body claims `source:
"aws.scheduler"` is therefore still an HTTP request that reaches a route. An
event matching neither shape is logged and thrown rather than guessed at,
because there is no safe default: guessing HTTP would give the sweep an HTTP
surface, and guessing scheduled would run the sweep from an unknown caller.

The scheduled payload shape is ours to fix, since EventBridge Scheduler sends
whatever input its target is configured with. Issue 36 configures the rules to
send exactly the shape `ScheduledEvent` describes.

`server/src/observability/logger.ts` writes one JSON object per line with every
field listed under Observability. The defence against logging a session token,
a provider ID token, raw health data, or a payment credential is primarily that
`LogFields` is a closed set of named identifiers: there is no `data`, `payload`,
or `Record<string, unknown>`, so `logger.info("...", { idToken })` does not
compile. Nothing in the request body or the headers is logged, and the request
line carries the matched route pattern rather than the URL, so a query string
cannot reach a log line either.

`scrub` in `server/src/observability/redact.ts` is the second net, over free
text. Exception messages, driver errors, and provider rejections are written by
code we do not control and routinely quote the value that caused them. It
removes JSON Web Tokens, `Bearer` and `Basic` header values, card numbers, and
long opaque runs, and it cuts UUIDs out of the text first so the identifiers
that make a log line traceable survive. Disabling `scrub` entirely fails six
tests and leaves the closed-field-set test passing, which is the layering
working as intended rather than a gap.

`server/src/errors/app-error.ts` is the one error model. Every failure is an
`AppError` carrying a contract `ErrorCode`, and `ERROR_PROPERTIES` decides a
status and a classification for each. The classification is the log field the
architecture requires, and it is coarser than the code on purpose: the code
tells the app what happened, the classification tells an operator whether to
care. Exactly one code classifies as `internal`, which is what an alarm should
watch. A rejected request logs at `warn`, so the error level stays a signal.

`internal_error` is the one code whose message does not reach the client, since
an unexpected failure's message is the one most likely to carry something that
should not leave the server. The message is kept on the error, so the log has
what the response withholds.

The not-found handler renders its error rather than throwing it. A throw there
escapes the logging middleware's `next()`, and an unmatched route would be the
one request with no "request handled" line.

The app has no routes yet: issue 11 mounts them from the contract's endpoint
registry, and every one inherits the request log line and the error model
because both are registered on the app rather than per route. The tests mount
their own routes to exercise that stack.

36 tests across the handler, the app, the logger, and the error model. The
discrimination and the scrubbing were both verified by neutering them: making
`isScheduledEvent` return `false` fails exactly the two tests that assert the
scheduled arm, and making `scrub` return its input fails exactly the six that
assert redaction.

### Issue 11: validation boundary

Every route is mounted from the contract's endpoint registry by `registerRoutes`
in `server/src/http/routes.ts`, and every mounted route parses its path
parameters, its body, and its idempotency key at the edge before a handler runs.
No path string is written in the server, so the app and the server cannot
disagree about where an operation lives, and an endpoint with no handler yet is
absent rather than half-built: it answers `not_found`.

The three failures the issue names produce one shape. An unknown field, a
missing field, and a field of the wrong type each return `validation_failed`
with a `details` entry per problem, carrying the path to the field. Every failed
field is reported, not only the first, because a client fixing one field per
round trip is a slow way to find out that four were wrong.

Unknown fields are rejected in the contract rather than by the server inspecting
keys. `deepStrict` in `packages/contract/src/strict.ts` rebuilds a schema with
every object made strict at every level of nesting, and `ENDPOINTS` wraps each
request schema in it. Requests reject unknown fields; responses deliberately do
not, because an older app must survive a server that added a response field,
while a client that misspelled a request field must be told rather than have the
server silently substitute its own value.

`deepStrict` rebuilds with Zod's `clone` rather than re-declaring a
`strictObject` or a fresh `z.array`, so the refinements attached to a schema
survive having their inner schemas replaced: the weekly schedule's
"a weekday at most once" rule and the deposit's "zero or at least the minimum"
rule are both carried across. It throws on a construct it has not been taught to
walk, so a new one fails at import rather than leaving a silent hole through
which unknown fields would reach a command. A schema that already decided about
unknown keys is left alone, which is what keeps the payment webhook's
`looseObject` loose: the provider owns that payload.

Path parameters became part of the contract. Each endpoint carries a `params`
schema, so `:challengeId` is validated as a UUID and the webhook's `:provider`
against the provider enum, rather than a path segment being trusted because the
router matched it. The generated JSON Schema artifact now describes them too.

Responses are parsed on the way out. A handler returning something the response
schema rejects produces `internal_error` rather than reaching an app that cannot
parse it, which puts the failure where it belongs: our bug, logged at error, and
described to the client only as an unexpected error.

Two decisions worth recording. A body sent to an endpoint that takes none is
rejected rather than ignored, for the same reason an unknown field is: it is a
client acting on a belief the server does not share. And a request whose body is
expected must carry a JSON content type, so a form post or a text body fails at
the boundary with a named header rather than inside `JSON.parse`.

38 tests: 22 in the contract over `deepStrict` and the registry, and 16 in
`server/test/validation.test.ts` over the mounted routes. Making `deepStrict` a
no-op fails exactly the 18 tests that depend on strictness, including the
artifact freshness test, and leaves the missing-field and wrong-type tests
passing, which is the two layers being genuinely separate.

### Issue 12: idempotency service

`runIdempotent` in `server/src/idempotency/service.ts` is the architecture's
three-step sequence, and every state-changing command will run through it. The
insert of the `in_progress` key is the concurrency control: nothing reads before
it writes, so two callers presenting one key at the same instant are ordered by
the database rather than by a check-then-act that a scheduler can interleave.
The acceptance boundary is exactly that test, and it asserts one performed
domain change by counting rows rather than by trusting the service's own report.

The lease needed a column the schema did not have. `idempotency_keys` gains
`lease_owner`, minted on the claim and re-minted on every takeover, and an
attempt completes or releases its row only while the owner is still its own.
`status = 'in_progress'` looks like it would do the same job and does not: a row
that was taken over, failed, released, and claimed again is `in_progress` once
more, and a status check alone lets the original attempt complete somebody
else's claim. Both guards have a test that fails when the guard is removed, and
removing either fails exactly one test.

Time is the database's, never the process clock. The remaining lease is computed
in SQL and returned as an integer, so nothing depends on how a driver renders a
bare `now()`, and a Lambda container with a skewed clock can neither take over a
live lease nor hold an expired one. An earlier version compared a `now()` column
against a `Date` in TypeScript and silently fell through every branch.

Two decisions the architecture leaves open. A command that fails releases its
key rather than holding it for the rest of the lease, so a client whose request
was rejected can retry at once; a crash releases nothing, which is the case the
lease exists for. And a takeover inherits the creation instant rather than
restarting it, because the architecture makes the instant the key was inserted
the receipt instant the sweep reads.

The request hash is a canonical rendering (object keys sorted, array order
preserved) hashed with SHA-256, so a client build that serializes its fields in
a different order is not told its own retry is a key reuse. The command type is
part of a key's identity, so spending a completion key on a pause is rejected as
the same mistake as changing the body.

22 tests: 14 integration tests against a real database and 8 over the hash.

### Issue 13: authentication and sessions

`server/src/auth/` holds the sign-in path: `provider-tokens.ts` verifies an
Apple or Google ID token, `sign-in.ts` maps the verified identity to an internal
account and issues a session, and `session-token.ts` mints and recognizes the
token the app then presents.

Verification is `jose` against the provider's published JWKS, checking
signature, issuer, audience, and expiry. Three details are decisions rather than
defaults. The algorithm list is closed to `RS256` and `ES256`: a JWKS is public,
so an open list turns "anyone can read Apple's key" into "anyone can mint an
Apple token" by presenting it as an HS256 secret. Google's issuer is accepted in
both spellings it has minted for years, because a single-issuer check rejects
real tokens at random. And a JWKS that times out is `internal_error`, never
`unauthenticated`: telling every user their credential is bad while a provider
is unreachable would send the whole install base through a sign-in that cannot
work.

An Apple private relay address is discarded at the boundary rather than stored
and handled carefully afterwards. `displayableEmail` drops an unverified
address, an address Apple flags with `is_private_email`, and anything on
`@privaterelay.appleid.com`, so no writer downstream is trusted to remember the
rule. The integration suite checks the column rather than the return value:
after a relay sign-in, no row in `provider_identities` has an email at all.

The mapping key is `(issuer, subject)`, which is the unique index issue 6
already carries, and that index is also the concurrency control for a first
sign-in. Two simultaneous first sign-ins both insert an account and then race on
the identity insert; the loser gets no row back from `onConflictDoNothing` and
throws, which rolls its own account insert back rather than leaving an account
nobody can reach. Removing that guard leaves two accounts and fails exactly the
concurrent test.

The session token is a signed JWT whose `jti` is the session row, with a
SHA-256 hash of the token in the row. Both halves earn their place: the
signature rejects a forged token without a database round trip, and the row is
what makes revocation and expiry real and what keeps a database dump from
containing anything presentable as a session. Thirty days is the lifetime, and
`SESSION_SECRET`, `APPLE_AUDIENCES`, and `GOOGLE_AUDIENCES` are the three
environment variables `loadAuthConfig` refuses to start without; an empty
audience list accepts every audience, so it is an error rather than a default.

One thing is deliberately not done here. `createAuthHandlers` is mounted by
whoever composes an app with a database, and the Lambda entry point still
composes `createApp` with no handlers, because nothing has yet decided where a
database handle is opened and closed across invocations. `POST /sessions` is
therefore live in tests and not yet in a deployed function; the composition root
belongs with the rest of the handlers rather than half-built here.

36 tests: 25 unit tests over verification, the session token, and the
configuration, and 11 integration tests over the mapping, including the
concurrent first sign-in and the `POST /sessions` route end to end. Allowing
`HS256`, dropping the relay checks, and removing the race guard each fail
exactly the tests that assert them and nothing else.

### Issue 14: session middleware and ownership checks

Both halves live in one place, `server/src/auth/session-gate.ts`, and
`registerRoutes` runs them for every endpoint the contract marks
`auth: "session"`.
A handler that forgot either one would not be a broken feature, it would be a
way to read or change somebody else's challenge, so neither is something a
handler can be trusted to remember.

The ownership answer is `not_found` and never `forbidden`.
A 403 for someone else's task and a 404 for a task that does not exist are
distinguishable, and that difference is an oracle: anyone holding a valid
session could walk identifiers and learn which ones name real tasks.
The acceptance test therefore compares the two response bodies to each other
rather than checking each against a status code.

Ownership rules are keyed by the contract's own path parameter name, and a
parameter with no rule is refused as `internal_error` rather than waved
through.
That turns "somebody added an addressed resource and forgot to say who owns
it" from a silent hole into a failing request, and a test walks the registry to
assert every session endpoint's parameters are covered today.

Two refusals happen at mount time rather than per request: an endpoint needing
a session cannot be mounted without a gate, and the payment webhook cannot be
mounted until issue 25 supplies something that checks a signature.
A deployment that forgot to configure authentication now fails to start instead
of serving every command to anyone until somebody notices.

Authentication runs before validation.
A caller with no usable credential is told exactly that and learns nothing
about which fields the command takes.
Within authentication the signature is checked before the database, so a flood
of forged tokens costs one HMAC each and never reaches a connection, which is
the reason the token is signed as well as stored.

`verifySessionToken` now returns a result rather than `SessionClaims | null`,
because expiry is the one refusal the app can act on: `session_expired` means
sign in again and carry on, while `unauthenticated` means the credential was
never ours.
Only a `JWTExpired` earns the expired answer, so a forgery that happens to also
be past its own `exp` is not mistaken for a lapsed session.
The row remains the authority on expiry, since a session can be cut short and
the token's own `exp` cannot be edited to follow.

23 tests: 9 unit tests over mounting, ordering, and rule coverage, and 14
integration tests over real rows including the acceptance boundary.
Neutering `assertOwnership` fails exactly the two ownership refusals, removing
the session row lookup fails exactly the deleted-row test, and removing the
row's expiry check fails exactly the expiry test.

The composition root is still absent, as noted under issue 13: the Lambda entry
point composes `createApp` with no handlers, so the gate is live in tests and
not yet in a deployed function.

### Issue 15: rate limiting

Counters live in PostgreSQL, one row per fixed window per bucket per subject,
and counting is one upsert that increments and returns the new total.
That single statement is the whole concurrency story: two Lambda containers
arriving together are ordered by the row lock the upsert takes, so each sees a
distinct total and exactly `limit` of them are inside the allowance.
In-process counters were never an option, since Lambda instances share no
memory and the effective ceiling would have been a function of AWS's scaling
decisions rather than of the policy.

The window is fixed rather than sliding.
A fixed window is one row and one statement; a sliding window is a row per
request and a scan at read time.
The cost is the boundary effect, where a caller can spend two allowances across
the instant a window turns over, and that is acceptable for a limit whose job is
to bound cost and abuse rather than to shape traffic precisely.
The window start is derived from the database's clock, for the reason issue 12's
lease is: a container with a skewed clock would otherwise be counted against a
window of its own, and a caller could pick the friendliest clock by retrying.

`RATE_LIMITS` is keyed by endpoint name and exhaustive by type, on the
`ERROR_PROPERTIES` precedent, so an endpoint added to the contract without a
decision fails the server typecheck rather than arriving unlimited.
`null` is a decision, and every one of them carries its reasoning.
Pause and resume share a bucket, so alternating between them does not buy twice
the calls, and the two payment endpoints share one because a provider call is
the expensive thing either of them makes.
The provider's webhook is deliberately unlimited: dropping its retries would
lose events that decide whether money moved, its authenticity is proven by
signature, and its volume is bounded by our own commands.

Sign-in is the one limit counted by source address, because before a session
exists there is no account to count and it is the only limit that has to hold
against a caller holding no credential at all.
The address comes from `requestContext.http.sourceIp`, which the Function URL
integration writes around the request.
The forwarding headers are the obvious alternative and are exactly wrong: a
Function URL passes through whatever `X-Forwarded-For` the caller sent, so
trusting it would let one caller spend another address's allowance or mint a
fresh one per request and never meet a limit at all.
A request with no source address is a direct invocation or a test, and those
share one subject rather than being waved through, because an unlimited fallback
is a way around the limit and a shared one is only inconvenient.

Order within a request follows from where the subject becomes known.
A client-scoped limit is spent first, before validation, so a flood costs one
statement rather than a parse.
An account-scoped limit is spent immediately after authentication and still
before validation: an anonymous caller cannot spend somebody's account
allowance, and a caller past its own cannot keep the server parsing by sending
larger bodies.

Mounting a limited endpoint without a limiter throws, as does an account-scoped
limit on an endpoint with no session, both at mount time.
The first is the session gate's precedent; the second would otherwise count
nobody, silently.

Reserved concurrency is the second ceiling and lives in the infra package as
`LAMBDA_RESERVED_CONCURRENCY`, since issue 35 defines the function that consumes
it. It is the limit that holds where the counters do not: a counter that fails
open, an unlimited endpoint under load, or a caller distributed widely enough
that no single subject ever meets its allowance.

23 tests: 15 unit tests over which endpoints are limited, mount-time refusals,
who is counted, ordering, and the address, and 8 integration tests over real
rows including the acceptance boundary.
The neuter check is the one worth recording: replacing the upsert with a read
followed by a write left all seven serial integration tests passing and failed
only the acceptance test, which admitted all 30 concurrent requests against an
allowance of 20. A rate limiter that is correct one caller at a time and wrong
under concurrency looks exactly like a working one until two connections fire at
once.

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
