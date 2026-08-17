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

### Issue 16: account deletion

The App Store requires deletion to be available in the app, and the architecture
says an account with an active funded challenge cannot be deleted until that
challenge settles, with the flow saying so.
`deleteAccount` is the two branches and the retention rule between them.

The refusal has two conditions rather than one.
An open funded challenge (`active` or `recovery_pending` with a deposit above
zero) is money the user could still forfeit.
A `pending` payment command is money already on its way somewhere, and it
outlives its challenge's status: the capture created when a challenge fails is
pending against a challenge that is already terminal, so a check reading
challenge status alone would let a user delete the account a capture belongs to
before the provider had acted on it.
Both answer `account_has_active_funded_challenge` with a message naming which
condition holds, because refusing without saying why is what the review
guideline exists to prevent.

The retention rule, stated so it can be tested.
Deleted: the account row, the provider identities behind it, every session,
every challenge with its schedule, tasks, completions and payment commands, the
idempotency keys scoped to the account, and the rate limit counters keyed on it.
The counters are the one piece no cascade reaches, since the subject is a bare
string with no foreign key, so they are deleted explicitly in the same
transaction.
Retained and unlinked: the ledger. `ledger_transactions.account_id` and
`challenge_id` are `ON DELETE SET NULL`, so amounts, currencies, occurrence
instants and provider references survive with nothing pointing back at a person.
That is what a financial record has to be for tax and dispute purposes, and it
is why issue 8's append-only trigger permits exactly one mutation: a foreign key
going to NULL.

The check and the delete run in one transaction that opens by locking the
account row `for update`.
That lock is the serialization point, and it is what makes a second simultaneous
deletion wait and then find nothing rather than both proceeding.
It is also the lock issue 18's funding path must take before it inserts, so a
deposit cannot be authorized against an account between this check and this
delete; without that, the refusal is a read that a concurrent funding can
invalidate.

Deletion deliberately does not run under `runIdempotent`, even though the
contract marks the endpoint idempotent and the key is still required at the
edge.
`idempotency_keys.account_id` cascades from the account, so a key claimed for
this command is deleted by the command's own effect and the completion step
would find no row, throw, and roll the deletion back.
Deletion is idempotent by nature instead: the session that authorized it went
with the account, so a retry is answered by the session gate.
The end-to-end test asserts exactly that, a 200 followed by a 401 on the same
token.

13 integration tests: four over the refusal branch including the pending-command
case and the proof that nothing was deleted, seven over what deletion removes
and what it keeps, and two over the mounted route.
Two neuter checks: dropping the pending-command condition failed exactly one
test, and dropping the `for update` failed exactly the concurrency test, which
is what separates a lock that serializes from one that decorates.

### Issue 17: time and schedule engine

The engine is `server/src/schedule`, split in two because the hard part is not
the schedule.

`zoned-time.ts` turns a wall-clock time in an IANA zone into an instant. That
conversion is a function on 363 days a year and a relation on the other two, so
rather than asking Luxon for an answer and trusting it, it enumerates the
offsets in effect near the local time, inverts each one, and keeps the instants
that read back as the local time asked for. A nonexistent local time yields
none, an ambiguous one yields two, and that distinction is the thing no single
conversion can report.

The two DST cases were decided in the user's favor, in the same direction both
times. An ambiguous deadline, in the repeated hour of a backward transition,
resolves to the later occurrence, so a user whose deadline sits inside that hour
keeps the whole of it rather than losing an hour they can see on their own
clock. A nonexistent deadline, in the skipped hour of a forward transition,
moves forward by the length of the gap, which is Luxon's own behavior. Neither
case can move a deadline earlier, because a DST rule the user never agreed to
must not shorten the window they are judged against.

`engine.ts` places dates and derives instants. It reads no clock: every function
takes the instant it reasons from, which is what makes the boundary cases
statements rather than arrangements.

Three rules the documents do not state had to be decided here.

Where a schedule starts. The first task is the earliest scheduled date whose
pause cutoff is strictly after the starting instant. Binding on the cutoff
rather than the deadline is the boundary pause and resume already bind on: a
task the user could not have paused is one they were never given a chance to
plan around, so a challenge created inside that window starts on the following
task. With a 09:00 deadline and eight hours of No Regret Time, a challenge
created at 01:00 local starts tomorrow.

How the cutoff is measured. The cutoff is the deadline instant less the No
Regret duration in real time, not in wall-clock time. Eight hours of notice is
eight real hours on the day the clocks change too, which is why the cutoff on a
spring-forward Sunday reads an hour earlier on the wall clock than on any other
Sunday.

Where a replacement task lands. `appendTask` places it on the next scheduled
date strictly after the challenge's last task, with no eligibility test against
an instant. Holding a replacement to the cutoff rule as well would let a pause
silently shorten a challenge, which is the opposite of what the materialization
rule exists to guarantee.

Calendar arithmetic is done in UTC on purpose. A date has no zone, and walking
one in a zone would make the answer depend on whether that day had 23, 24, or 25
hours in it. The zone enters only where a date and a wall-clock time become an
instant. One test asserts the 25-hour Sunday does not produce the same date
twice, which is the failure that arithmetic would have.

`windowStart` is returned but not stored: the task row keeps the date, and the
window is that date's beginning in the challenge's zone. It is here because it
is the third instant from the same conversion and the completion path judges a
device-reported timestamp against it.

38 table-driven tests over inactive weekdays, both DST directions, ambiguous and
nonexistent local times, half-hour and three-quarter-hour zones, a zone whose
DST shift is 30 minutes, a day with no midnight, the cutoff boundary on both
sides, and the projection agreeing with the schedule it comes from. Every
expected instant is written as a UTC literal, because one written in the zone
under test would be produced by the conversion the test is checking.

Three neuter checks, each landing on a disjoint set: taking the earlier
occurrence of an ambiguous time failed exactly the two backward-transition
tests, moving the start boundary from strict to inclusive failed exactly the two
cutoff-boundary tests, and dropping the No Regret subtraction failed seven.

### Issue 18: projection and zero deposit challenges

Three endpoints, in `server/src/challenges`, and the seam the phased plan asked
for: from here a challenge exists, has tasks, and can be completed, paused, and
swept, with no payment code anywhere in the path.

The projection and the creation call one function. `planChallenge` returns both
the task list and the three facts the projection screen shows, so "the
projection equals the schedule later materialized from the same configuration"
is true by construction rather than by two implementations agreeing. The
projection throws the task list away; creation writes it. The acceptance test
still checks the property end to end, because a shared function would not
protect against creation deciding to place its own dates later.

The projection takes no database handle. "Nothing is written by a projection
call" is therefore a property of the code, and the test that counts rows before
and after is a guard against a future edit rather than the reason the claim is
true.

The maximum duration rule is reported here, not enforced. The projection is a
question the app asks before the user has committed to anything, so the answer
is `withinMaximumDuration` rather than a refusal. Enforcement belongs to the
command that takes the money, which is issue 19's funding intent, and
`isWithinMaximumDuration` is exported for it. The rule is measured in calendar
days in the challenge's own zone, from the day the money would be taken to the
day the last task falls on, so a transition that made one of those days 23 hours
long does not move the boundary. A zero deposit challenge is always within it:
the rule exists because an authorization cannot be held indefinitely, and there
is nothing to hold.

The deposit rule is stated twice on purpose. The contract rejects an amount
between zero and the funded minimum, so an HTTP request never reaches the
domain, and both endpoints answer `validation_failed` for fifty cents.
`assertDepositAmount` states the same rule for the callers that are not HTTP
requests. A money rule stated only at the edge is a money rule that holds only
for the edge.

`POST /challenges` refuses any non-zero deposit with `zero_deposit_required`,
and that is permanent rather than a stopgap. A funded challenge must not exist
until the provider confirms the authorization, so a path that could create one
without that confirmation is a path that lets a user start a challenge nobody
can be charged for.

Creation runs inside `runIdempotent`, and both refusals are decided before the
key is claimed: a doomed request should not spend a key it will have to abandon.
The transaction opens with the same `for update` lock on the account row that
account deletion takes, which is the coordination point issue 16 said the
funding path would owe.

`loadChallengeView` is one reader, used by creation and by
`GET /challenges/current`. Creation reads the challenge back through its own
transaction rather than assembling a response from what it just inserted, so the
response describes rows that exist and carries the defaults the database
applied. Two view fields are derived rather than stored, because storing them
would mean keeping them true: `pause.expiresAt` is the paused instant plus the
maximum pause length, and `recoveryOffer` is the latest missed task plus the
recovery window, present only in `recovery_pending`.

"Current" means the challenge holding the account's slot, `active` or
`recovery_pending`. Every terminal challenge answers null, which is what the
contract says and what the app's empty state is built around. Returning the last
finished one would make the app guess whether it is looking at something it can
act on.

23 tests: 8 unit tests over the projection and the duration boundary on both
sides and both deposits, and 15 integration tests through the mounted routes
over the acceptance boundary, the two refusals, idempotent replay, the
one-challenge rule, two simultaneous creations on two connections, and what
`current` answers before, during, and after a challenge.

Two neuter checks, and the first was worth more than it looked. Removing the
account lock failed nothing: the partial unique index catches the second
creation and `rethrowDuplicate` renders it as the same 409. Neutering that
translation as well showed the concurrent case reaching the index and answering
500, and restoring the lock alone put it back on the check path. So the lock is
load-bearing, but for keeping a concurrent creation on the path with the useful
message rather than for the status code, and the index remains the authority
that makes a second open challenge impossible. Removing the zero deposit refusal
failed exactly the one test that asserts it.

### Issue 19: fake payment provider and funding

The funded door, in `server/src/payments` and `server/src/challenges/funding-intent.ts`.
A funding intent asks the provider for a hold and records what the hold is for.
The challenge appears only when the provider says the authorization succeeded.

The provider interface is the architecture's list, implemented in full rather
than in the part today's code calls. Authorizing and saving the instrument,
renewing and reporting expiry, releasing, capturing or charging off-session,
recording an uncollected forfeit, verifying webhooks, looking up transaction
status, and reporting a stable instrument fingerprint. A fake that answered only
the funding path would leave the boundary unexercised exactly where it is least
understood, and the operations that move money are covered by their own tests
that assert the funding flow never reaches them.

The fake models three things a stub would not. A hold starts `pending` and
becomes `authorized` only through a delivery, which is what lets the server
prove a client callback activates nothing. A delivery is signed with an HMAC
over the exact bytes, compared in constant time, so a payload edited in flight
fails even though it still parses. And asking for the same delivery twice
returns byte-identical bytes under one event ID, which is what makes a retried
delivery testable.

`funding_intents` stores the whole configuration and the accepted policy
version against the provider's authorization identifier. The architecture's
reason is that the webhook has to know what was authorized and the amount at
stake has to be tied to the exact terms the user accepted. Nothing in a delivery
describes a challenge, so a forged or mangled payload cannot change the terms
even if it somehow verified. Two check constraints carry the rest: an intent is
never for less than the funded minimum, and `authorized` holds a challenge while
no other status does, which is "money activates a funded challenge, and only
through the provider's confirmation" written as a constraint.

Materialization is one function for both doors. `materializeChallenge` writes
the challenge, the weekly schedule, and the full task set, and issue 18's
creation path was rewritten to call it. That is what makes the task count
invariant hold immediately after activation on the funded path as well: the
deferred trigger counts at commit, so a challenge that committed at all
committed complete.

A funded challenge is scheduled from the confirming instant rather than from the
instant the intent was created. The challenge did not exist until the provider
answered, so a user who left the payment sheet open is not handed a first
deadline that already passed.

Three refusals happen before the idempotency key is spent, since each one is the
caller's to fix by sending a different request: a zero deposit belongs to
`POST /challenges` and answers `deposit_required_for_funding`, a schedule
running past the maximum duration answers `maximum_duration_exceeded` (the rule
issue 18 could only report now binds, at the moment an authorization is taken),
and an account already holding a challenge answers `active_challenge_exists`
under the same account lock every other path takes.

The provider call happens inside the transaction that records the intent, which
would be wrong for a capture and is right for this one. Authorizing is
reversible and free, so an intent created and rolled back is a hold nobody
confirms, which expires having charged nothing. The alternative, recording
first and calling after, leaves a row claiming a hold that may not exist.

Two simultaneous funding intents are both allowed. Neither account has a
challenge yet, a user who taps twice has two holds, and at most one of them will
ever be confirmed: the second confirmation finds the slot taken.

That case is the one refusal the webhook cannot answer with an error. A provider
that confirmed a hold cannot be told to try again later, so an account that
acquired a challenge between the intent and the confirmation fails the intent
instead, and the hold expires unconfirmed. Everything else the webhook cannot
act on (an unknown event type, a delivery naming no intent, an intent already
settled) is recorded and ignored for the same reason: no redelivery would
change the answer, and answering anything but 200 buys an unbounded retry.

Nothing is captured. The only ledger movement on this path is
`deposit_authorized`, a debit to `user_commitment` against a credit to
`payment_processor`, which the deferred balance trigger checks sums to zero. No
`platform_revenue` or `processor_fees` entry appears anywhere, because a
processing fee attaches to a capture and there has been none.

The signature check is the route's authentication, in the position the session
gate occupies for a client command, so it runs before validation parses a field.
The verified event travels on the request context; verifying again in the
handler would let the endpoint be mounted without a verifier and still appear to
work, which is the failure the route table's mount-time refusal exists to
prevent.

25 tests: 11 unit tests over the provider boundary and 14 integration tests
through the mounted routes over the acceptance boundary, the three refusals,
idempotent replay, two simultaneous intents, both provider answers, a delivery
naming no intent, and the ledger and provider records after a full funding.

Three neuter checks, each landing on exactly one test and a different one:
accepting any signature failed the signature test, removing the event dedupe
failed the redelivery test, and removing the open-challenge check at
confirmation failed the case where a challenge appeared in between.

### Issue 20: completions

`POST /tasks/:taskId/completions`, in `server/src/tasks`. This is the command the
product turns on: a completion the server has not acknowledged does not count,
so every refusal here is one a user feels, and each of the six is a separate
named error code the app can act on rather than one generic rejection.

The checks run in a fixed order, from the ones no later request could pass to the
ones a corrected request could. The body's `clientRecordId` must be the key the
request carries, and the observation's provenance must be `live-foreground`;
both are decided before an idempotency key is claimed, because a request that
can never succeed should not spend the caller's key. Then the task must exist,
be the caller's, still be open, and belong to an `active` challenge. Then the
receipt grace, then the reported instant against the task window, then the step
target.

The receipt grace and the window are two different rules and are worth keeping
apart. The grace forgives a late arrival by up to sixty seconds, which is what
the architecture wrote it for: server acknowledgment is a hard condition for
credit, so a cold start or a moment of weak signal must not decide a deposit. It
never forgives a late completion. A request received inside the grace that
reports movement finishing after the deadline is refused with
`completion_outside_task_window`, and the two have their own tests.

The window start is derived rather than stored: it is the beginning of the task's
calendar day in the challenge's zone, so the task row's date plus the
challenge's zone is the window. Storing a third instant per task would mean
keeping it true through a time zone change, which issue 22 rewrites instants for.

The step target is checked against the challenge's own `step_target`, not taken
on the device's word. The app evaluates it locally to show the user a result at
once; the server re-evaluates it because the observation is evidence and the
number is on the challenge.

**The receipt instant is the server clock when the command is handled**, injected
so a test can state it. The idempotency key's `created_at` is a second reading of
the same clock and is the one issue 23's sweep reads to know a completion is in
flight. The two differ only by the duration of an attempt, so they disagree about
a single completion only when an attempt crashes within a minute of the deadline
and is retried, in which case the retry is refused and the sweep then misses the
task. That gap is bounded and stated here rather than left to be discovered.

The task row is read `for update` before anything is decided, which is what makes
this command and any writer that consumes the same task mutually exclusive. The
proof is a test where a pause-style skip holds the lock and then consumes the
task: the completion waits, re-reads, and answers `task_already_resolved`.
Without the lock the same test fails, because the completion decides against a
row another transaction is about to change and discovers the conflict two
statements later as a duplicate-key failure.

`replayed` is decided by the key rather than stored under it. The stored result
is what the first attempt produced, and whether this caller is the one who
produced it is a property of this request, so a replay returns the same
acknowledgment with that one field flipped.

The challenge succeeds on the completion that reaches its required count, by
counting the completed rows rather than incrementing a column: there is no number
to double-count, and the deferred trigger counts the same rows at commit, so a
disagreement is a failed transaction rather than a challenge claiming an outcome
it has not earned.

16 integration tests through the mounted route: both sides of the grace boundary
to the millisecond, a duplicate key replaying, all five refusals, the stored
evidence, the succeeding completion, the concurrent writer, and another
account's task answering not found.

Six neuter checks on disjoint tests: the grace, the step target, the record
identifier, the provenance, and the row lock each failed exactly one test, and
the window check failed exactly two.

### Issue 21: pause mode

`POST` and `DELETE /challenges/:challengeId/pause`, in
`server/src/challenges/pause.ts`, with the skip they imply in
`server/src/challenges/pause-skips.ts`.

Pausing acts on the challenge and never on a task. Setting the mode writes
`paused_at` and consumes nothing; each task is consumed as its own pause cutoff
passes, and each consumption is one transaction moving the task to `skipped` and
appending one replacement `scheduled` task. Splitting those two statements is not
available: the active challenge's task count is a deferred constraint trigger, so
a skip with no replacement fails at commit. The invariant forces the shape rather
than merely describing it.

The window a pause consumes is `(pausedAt, now]`. Strictly after the pause
instant, because a pause set at or after a task's cutoff leaves that task live:
the user never got the No Regret notice, so the task they are inside of stays
theirs. At or before the current instant, because a cutoff still ahead has not
passed and the user may yet resume before it does.

Resume runs the same consumption, in its own transaction, before it clears the
mode. That is what makes leaving the pause bind at the cutoff boundary rather
than at whenever the sweep next runs: the tasks whose cutoffs passed while the
mode was set were spent, and a resume arriving before the sweep did must not hand
them back. It also means the sweep and the resume share one implementation, so
there is no second idea of what a pause skip is.

A replacement lands on the next scheduled date past the last date the challenge
holds a task on, and the challenge's stored `projected_end_date` moves with it. A
pause spanning several windows therefore carries the challenge past the date it
was created against, which is the intended cost and is why the maximum duration
rule is checked at creation and not maintained afterwards.

The catch-up loop runs until no task is due rather than once per due task,
because a replacement appended during a long pause can itself have a cutoff in
the past. It is bounded at 400 skips: a year of pause expires the challenge and
the densest schedule is daily, so anything past that is a bug, and the bound
exists so a bug does not present as a hung Lambda.

Both commands take the challenge row `for update` before deciding anything, which
is the same discipline the completion path applies to a task row. Removing it
fails exactly the two-writer test and nothing else.

`recovery_pending` is refused along with the terminal statuses. That challenge is
waiting on one decision with a window of its own, and letting a pause suspend
that clock would make the recovery window unbounded.

The contract changed in one place: `DELETE /challenges/:challengeId/pause` now
takes no request body, matching the other two `DELETE` commands. A body on a
`DELETE` is dropped by enough intermediaries that requiring one would make the
command's success depend on the network rather than on the request.

`pause_cutoff_passed` remains an unused error code. It belongs to the per-task
pause the architecture replaced with a mode: entering a pause inside a task's
cutoff is not a refusal, it is a pause that leaves that task live and names the
next one it takes. The code is left in the contract because the time zone change
in issue 22 binds on the same boundary and may need it.

14 integration tests through the mounted routes and 2 unit tests. The acceptance
boundary is both ends of the cutoff, to the millisecond, in both directions; the
invariant is a pause spanning three windows, whose skips and replacements are
checked against committed rows, so the deferred trigger accepting the commit is
part of the assertion. The unit tests are a source scan: exactly one module in
the server clears `paused_at`, and it is the resume command, which is the only
way to state "no code path resumes a challenge without an explicit request" over
paths that do not send requests.

Four neuter checks, each landing where it should: dropping the `pausedAt` bound
failed only the test asserting a pre-pause task stays live, dropping the `now`
bound failed the six tests that depend on a resume not consuming the future,
dropping the row lock failed only the two-writer test, and dropping the
consumption from resume failed the five tests that assert what a resume spends.

### Issue 22: time zone change

`POST /challenges/:challengeId/time-zone`, in
`server/src/challenges/change-time-zone.ts`.

A challenge's schedule is a wall-clock time on a weekday, so the instants a task
is judged against exist only once a zone is chosen. Changing the zone keeps the
wall-clock promise: an 08:00 deadline stays 08:00 where the user now is. Every
task keeps its calendar date and its sequence, and only its deadline and pause
cutoff move, which is exactly what `taskInstants` in the issue 17 engine was
written for.

Which tasks move is the whole of the rule, and the architecture states it against
a stored instant: re-materialize only tasks whose stored pause cutoff is strictly
later than the instant the command is received. That is deliberately not the same
boundary as "tasks that have not started". A task can have a passed pause cutoff
and a deadline still hours ahead, and the two readings disagree about it. The
cutoff is what the user was promised, so once it passes the terms that task is
judged on are settled and a later command must not restate them.

Tasks with a resolved outcome are excluded by status as well. The cutoff filter
would catch most of them, but a skipped or forgiven task can hold a cutoff in the
future, and a finished task's instants are part of the record of what happened.

Three decisions the architecture leaves open:

- **A change to the same zone writes nothing.** It is not a smaller move, it is
  not a move: writing identical instants back would leave `updated_at` claiming a
  change the user did not make and would report tasks as re-materialized that
  nothing happened to.
- **`recovery_pending` is refused** along with the terminal statuses, matching the
  pause command. That challenge is waiting on one decision whose window is
  measured from a missed task, and moving instants underneath it would change
  what the decision is about.
- **A paused challenge is accepted.** The mode suspends tasks, not the
  challenge's relationship to a clock, and the user who moves is the user most
  likely to be paused.

One consequence is pinned by a test rather than prevented. Moving eastward moves
a deadline earlier, so a task whose cutoff was still ahead can come out of the
change with a deadline already behind the receipt instant, which the sweep will
treat as missed. Nothing upstream states a policy for that, so the rule is
applied as written and `moving eastward` in the suite records what that means. If
the product decides such a change should be refused, or should spare that task,
that test is the one that changes.

The command runs inside `runIdempotent` and takes the challenge row `for update`
before deciding anything, which is the same lock the pause path and the funding
path take, and it is what stops a task from being moved into a new zone after a
completion or a pause skip decided it under the old one. The status is in the
predicate of each task update as well as in the read that selected it.

`server/src/challenges/weekly-schedule.ts` is a small extraction: the pause skip
and this command both rebuild the engine's schedule from stored rows, and both
would otherwise repeat the one detail that is easy to get wrong, which is that
the deadline column is a `time` and reads back with seconds.

13 integration tests through the mounted route. The acceptance boundary is a task
with a passed cutoff and a future deadline being untouched while its two
successors move, against the same challenge one millisecond earlier where all
three move.

Four neuter checks, each landing on a disjoint test: dropping the cutoff bound
failed only the untouched-task test, dropping the status filter failed only the
resolved-outcome test, dropping the same-zone short circuit failed only the two
tests that assert a no-op, and dropping the row lock failed only the two-writer
test.

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
