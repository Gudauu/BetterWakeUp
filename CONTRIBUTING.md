# Contributing

## Development

Requires Node 22 or later and pnpm.

```sh
pnpm install
pnpm run check
```

`check` runs lint, typecheck, and tests across every workspace package. Run it
before opening a pull request. `pnpm run lint:fix` applies the safe fixes Biome
can make on its own.

The workspace holds `app`, `server`, `infra`, `packages/contract`, and `tools`,
which holds tests for repository tooling rather than shipped code. The Expo app
in `app/` uses jest-expo rather than Vitest, so `pnpm run test` runs Vitest
across the other packages and then Jest inside `app`. Tool choices are recorded
under "Toolchain" in `docs/architecture.md`.

## The API contract

`packages/contract` holds the Zod schemas for every endpoint. Both the app and
the server infer their types from those schemas, so nothing hand-writes a
request or response shape.

The schemas also produce a JSON Schema artifact, checked in at
`packages/contract/generated/contract.schema.json`. After changing a schema,
regenerate it:

```sh
pnpm --filter @betterwakeup/contract run generate
```

A test compares the checked-in artifact against a fresh build, so a change that
was not regenerated fails CI rather than reaching a consumer. Biome does not
format the `generated` directory, since the generator decides its layout.

Request schemas reject unknown fields at every level of nesting, and response
schemas do not. `deepStrict` in `packages/contract/src/strict.ts` applies the
first rule, and `ENDPOINTS` wraps every request schema in it, so write a request
schema as a plain `z.object` and let the registry make it strict. The asymmetry
is deliberate: a client that misspells a field must be told, and an older app
must survive a server that added a response field. A schema that decides for
itself, such as the payment webhook's `looseObject`, is left alone.

`deepStrict` throws on a schema construct it has not been taught to walk, so
introducing one to the contract fails at import rather than quietly leaving a
hole. Teach it the construct in `strict.ts` rather than working around it.

Path parameters are part of the contract too: an endpoint whose path has a
`:name` segment carries a `params` schema, and the server validates against it
rather than trusting a segment because the router matched it.

## The database

`server/src/db` holds the Drizzle setup. Production runs on Neon through the
serverless WebSocket `Pool`, and integration tests run against a PostgreSQL
container, so `createDatabase` picks a driver from the connection string's host
and hands back one `Database` type either way. Callers do not learn which driver
they hold.

Tables live in `server/src/db/schema/`, one module per area, all re-exported
from `server/src/db/schema.ts` so `drizzle-kit` sees a single entry point.

`server/drizzle` is the migration folder and the description of the database.
After adding or changing a table:

```sh
pnpm --filter @betterwakeup/server run db:generate --name <what-changed>
```

Pass `--name`, otherwise the kit invents one. `db:migrate` applies pending
migrations to `DATABASE_URL`, and `db:check` looks for conflicting migrations.
Nothing else applies SQL to a real database, so development, tests, and
deployment reach the same shape.

Forgetting `db:generate` is caught by
`server/test/integration/schema-drift.test.ts`, which compares the migrated
database's columns against the ones the Drizzle schema declares.

Invariants belong in the schema, not in application code. A rule expressed as a
unique index, check constraint, or trigger holds against every writer,
including a future migration script and a hand-typed `psql` session; the same
rule in a service function holds only for callers that remember it. Each such
constraint should have a negative test that attempts the violation directly
through Drizzle and asserts the SQLSTATE.

An invariant that counts or sums across rows cannot be a check constraint,
which sees one row, or a unique index, which sees one key. Those go in a
deferred constraint trigger, written as a hand-authored migration:

```sh
pnpm exec drizzle-kit generate --custom --name=<what-it-enforces>
```

Deferral is what makes them usable. A transaction that consumes a task and
appends its replacement is momentarily wrong between the two statements, and
only the state at commit has to hold. A constraint trigger raises SQLSTATE
`23000`, so tests assert that rather than a message. `drizzle-kit` neither
generates nor tracks triggers, so the migration file is their only description;
they will not appear in a snapshot and a regenerated migration will not drop
them.

A rule about a statement rather than about a row belongs in an immediate
trigger instead. The ledger's append-only guarantee is one: no `UPDATE` or
`DELETE` reaches a ledger entry, and a ledger transaction accepts an update only
when it nulls a foreign key back to a person. Those raise SQLSTATE `23001`, so a
test can tell an immutability refusal apart from a `23000` aggregate violation.
A state machine is the same kind of rule: a terminal task outcome or a terminal
challenge status is terminal because an immediate trigger refuses the `UPDATE`
that would leave it, not because the writer knows better.

`server/test/integration/invariant-assault.test.ts` attacks every invariant the
architecture lists through raw SQL, with no Drizzle and no schema module in the
path, using `useRawSql()` and the SQL fixtures in
`server/test/support/raw-challenge.ts`. A new invariant belongs there as well as
in its own schema suite. The distinction is not academic: three invariants
looked enforced in the Drizzle suites and were not, because Drizzle's types, and
not the database, were refusing the write.

Integration tests need a running Docker daemon. They live in
`server/test/integration` and run as the `server-integration` Vitest project,
separately from the unit tests, which need no container. One container is
started per run, migrations are applied once to a template database, and each
test gets its own database copied from that template. Isolation is therefore a
real database rather than a transaction the test must remember not to commit,
which is what lets a test hold two connections and observe locking. Use
`useTestDatabase()` from `server/test/support/postgres.ts`.

## The server

`server/src/lambda/handler.ts` is the Lambda entry point. It decides whether an
invocation is scheduled or HTTP before anything else runs, and a scheduled one
never reaches Hono. Both predicates read the envelope AWS builds and never
anything a caller supplies, so keep it that way: a discrimination that consults
a request body would give the sweep an HTTP surface.

`createApp` in `server/src/http/app.ts` registers the request log line and the
error model. Routes go on the app, so they inherit both; do not add per-route
logging or error handling.

### Routes

Routes are mounted from the contract's endpoint registry by `registerRoutes` in
`server/src/http/routes.ts`. Pass `createApp` a handler keyed by endpoint name;
never declare a path string in the server. An endpoint with no handler is not
mounted and answers `not_found`, which is how the surface grows one issue at a
time without a half-built route pretending to work.

A handler receives a `HandlerInput`: a body, path parameters, an idempotency
key, and the authenticated caller, all of them checked at the boundary against
the contract. The caller already owns every resource the path addresses, so a
handler never re-checks any of it, and it never reads the raw request. Its return value is parsed against the
response schema on the way out, and a response that does not match is
`internal_error`, because it is our bug and not something an app can act on.

### Logging

Use the logger from `server/src/observability/logger.ts`, and prefer the child
logger on the Hono context (`c.get("logger")`), which already carries the
request's identifiers.

`LogFields` is a closed set. Adding a field means adding it there, which is the
review point where someone asks whether it can carry a secret. Never widen it to
`Record<string, unknown>` or add a `data` field: the whole guarantee that no
session token, provider ID token, raw health data, or payment credential reaches
a log line rests on the set being closed. `scrub` is a second net over free
text, not a licence to log a value we know is sensitive.

### Errors

Throw an `AppError` with a contract error code. Nothing else may decide an HTTP
status or build an error body. A new code goes in `packages/contract/src/errors.ts`
first, and the server typecheck then fails until `ERROR_PROPERTIES` gives it a
status and a classification, so a new code cannot silently default to a 500.

Classifications are for operators, not clients. Only `internal` means our fault,
and only `internal` logs at error level, so an alarm on error level stays a
signal rather than a count of rejected requests.

### Authentication

`server/src/auth/` owns everything between a provider ID token and a session.
Verify a provider token through `createProviderTokenVerifier` and nothing else:
it keeps the algorithm list closed to the asymmetric algorithms Apple and
Google sign with, which is what stops a public JWKS key being presented as an
HS256 secret.

An email address is never an identifier, a key, or a deduplication signal. The
identity key is `(issuer, subject)`. An Apple private relay address is dropped
at the boundary by `displayableEmail`, so nothing downstream has to remember the
rule, and a test asserts the column stays empty rather than asserting the return
value.

A session is a signed JWT plus a `sessions` row holding a hash of the token.
Look a presented token up by `hashSessionToken`; never store or log the token
itself. The row is the authority on revocation and expiry, so a signature check
alone is not a session check.

Sign-out (`signOut`) sets `revoked_at` on the caller's own session and only when
it is still null, so a repeat does not rewrite the instant the session actually
ended. It never widens to the account's other sessions: signing out on one
device leaves the others signed in, which is what a user expects. The command has
nothing to refuse, because a revoked session cannot reach the handler twice.

`loadAuthConfig` reads `SESSION_SECRET`, `APPLE_AUDIENCES`, and
`GOOGLE_AUDIENCES` and throws when any is missing or empty. Keep it that way: an
empty audience list means every audience is accepted.

### Sessions and ownership

`createSessionGate` answers both questions every command asks: who is calling,
and is the thing they addressed theirs. `registerRoutes` runs it for every
endpoint the contract marks `auth: "session"`, so a handler never checks either
one for itself and never gets the chance to forget.

Ownership is answered with `not_found` and never `forbidden`. Both a resource
that does not exist and one belonging to somebody else must produce the same
response body, because a distinguishable 403 lets anyone with a session
enumerate other people's resources.

A new addressed resource means a new entry in `OWNERSHIP_CHECKS`, keyed by the
path parameter name the contract uses. A parameter with no entry is refused as
`internal_error` rather than allowed through, and a test walks the registry to
assert every session endpoint is covered.

Composing an app that mounts a session endpoint requires a `sessionGate`, and
mounting the payment webhook requires a `signatureVerifier`. Both are checked at
mount time and throw, which is what keeps a misconfigured deployment from
starting rather than from being noticed.

### Rate limiting

`RATE_LIMITS` in `server/src/rate-limit/policy.ts` is keyed by endpoint name and
exhaustive by type, so a new endpoint in the contract fails the server typecheck
until somebody decides what it costs. `null` is that decision written down, not
its absence, and it deserves the sentence of reasoning the existing entries have.

Counting is one SQL statement: an upsert on `(bucket, subject, window_start)`
that increments and returns the new total. Do not put a read in front of it. A
read followed by a write lets two Lambda containers both decide they were the
last one permitted, and the integration suite's acceptance test is there to
catch exactly that.

Two endpoints that should not be alternated between share a `bucket`. The window
is fixed rather than sliding, which accepts the boundary effect in exchange for
one row and one statement per request.

The subject of a `client`-scoped limit comes from `requestContext.http.sourceIp`
and never from a forwarding header, which a Function URL passes through from the
caller unmodified.

Composing an app that mounts a limited endpoint requires a `rateLimiter`,
checked at mount time and thrown, on the same reasoning as the session gate.
`LAMBDA_RESERVED_CONCURRENCY` in the infra package is the second ceiling: it
bounds cost where a counter does not apply or fails open.

### Idempotency

A handler for an endpoint the contract marks idempotent does its work inside
`runIdempotent`, never beside it. The callback it takes receives the transaction
the key is completed in, so the domain change and the record of it either both
commit or neither does; opening a separate transaction inside that callback
breaks the guarantee the service exists to give.

`runIdempotent` opens its own transactions, so it must not be called from inside
one.

Everything it decides is decided by the database: the insert of the key is the
concurrency control, the lease expiry is compared in SQL, and ownership of a
lease is a token on the row. Do not add a check-then-act around it, and do not
compare a lease against the process clock.

Account deletion is the one exception, and it is documented where it lives: the
key row cascades from the account, so a command that deletes the account cannot
also record itself under a key scoped to it.

### Account deletion and retention

Deletion refuses while any of the account's money is unsettled: an open funded
challenge, or a `pending` payment command under any of its challenges, whatever
that challenge's status. The refusal names which condition holds.

Everything identifying a user is deleted, and the ledger is retained with its
links to the account and the challenge set to NULL. When you add a table, decide
which side it is on: a table carrying anything about a person cascades from
`accounts`, and a table that must outlive them unlinks instead. A table keyed on
an account identifier with no foreign key, as `rate_limit_counters` is, is
reached by neither and has to be deleted explicitly in `deleteAccount`.

Any command that commits money to a challenge must lock the account row `for
update` before it inserts, the way `deleteAccount` does. Without that lock the
refusal is a read a concurrent funding can invalidate.

### Time and schedules

All IANA arithmetic happens on the server, in `server/src/schedule`, and nowhere
else. The app renders instants the server computed and never derives one.

`zoned-time.ts` is the only place a wall-clock time becomes an instant. Use it
rather than calling Luxon directly, because it decides the two cases a plain
conversion gets to decide silently: an ambiguous local time (the repeated hour
of a backward transition) resolves to the later occurrence, and a nonexistent
one (the skipped hour of a forward transition) moves forward by the gap. Both
choices move a deadline later, never earlier, so a DST rule the user never
agreed to cannot shorten the window they are judged against.

`engine.ts` is pure and reads no clock: every function takes the instant it
reasons from. Keep it that way, so a test states a moment rather than arranging
for one.

Two rules there are easy to get backwards. Calendar arithmetic walks dates in
UTC, because a date has no zone and walking one in a zone makes the answer
depend on whether that day had 23, 24, or 25 hours. Durations, including the No
Regret Time the pause cutoff is derived from, are subtracted from the instant,
because eight hours of notice must be eight real hours on the day the clocks
change too.

### Challenges

`server/src/challenges` owns the challenge lifecycle. Four rules there are worth
knowing before you add to it.

A configuration becomes a schedule in exactly one place. `planChallenge` returns
both the task list and the projection facts, and every caller that needs either
calls it. The projection endpoint and the creation command therefore cannot
disagree about where a challenge starts or when it ends, and neither can the
funding path when it arrives.

A projection persists nothing, and the way that is kept true is that the
projection path takes no database handle at all. Do not give it one.

The maximum duration rule is reported by the projection and enforced by the
command that takes money. `isWithinMaximumDuration` is the one statement of it;
call it rather than comparing dates again.

Answer with a challenge by reading it back through `loadChallengeView` rather
than by assembling a response from what you just wrote. A response built from
intentions describes rows that may not have committed and misses the defaults
the database applied.

## Completions

Refuse with the narrowest error code that fits. The app's pending completion
store decides whether to retry from the code, and it surfaces a rejection to the
user, so `deadline_passed`, `completion_outside_task_window`,
`step_target_not_met`, `movement_provenance_rejected`, and
`task_already_resolved` are five different things a user needs told apart.

Keep the receipt grace and the task window apart. The grace forgives a late
arrival by sixty seconds and never a late completion, so a request received in
time that reports movement finishing after the deadline is refused.

Take the task row `for update` before deciding anything about it. The sweep, the
pause skip, and this command all consume the same row, and a decision made
against a row another transaction is about to change is discovered later as a
duplicate-key failure instead of as a conflict the caller is told about.

Decide anything that does not need the database before claiming an idempotency
key. A request that can never succeed should not spend the caller's key.

## Pause mode

Pause is a mode on the challenge and never an action on a task. Entering it
writes `paused_at` and consumes nothing; a task is consumed only as its own pause
cutoff passes.

One skip is one transaction that moves a task to `skipped` and appends its
replacement. Never write the skip without the append: the active challenge's task
count is a deferred constraint trigger, so the commit fails, and it fails at the
end of the transaction rather than at the statement that caused it. The append
itself is `appendReplacementTask`, shared with Emergency Recovery; a second
implementation is a second idea of where a replacement lands.

The window a pause consumes is `(pausedAt, now]`, and both bounds are rules a
user feels. A pause set at or after a task's cutoff leaves that task live; a
resume consumes everything whose cutoff passed while the mode was set, so it
takes effect on the following task rather than dropping the user into a window
they can no longer plan around.

Both ends of the mode go through `skipTasksConsumedByPause`, and so will the
sweep. A second way to skip a task is a second idea of what a pause is.

Nothing may clear `paused_at` except the resume command. A pause has no limit and
no expiry, and the year that ends a paused challenge ends it as `expired` rather
than resuming it. `server/test/pause-mode.test.ts` is the test that says so.

## Emergency Recovery

The offer is derived and never stored. A challenge in `recovery_pending` has one
standing for its latest missed task, expiring at that task's `missed_at` plus the
recovery window, and `challenge-view.ts` renders it from those rows. Do not add a
column: an offer that can be stored is an offer that can disagree with the task
it is for.

Accepting it is one transaction with five effects, in
`server/src/challenges/accept-recovery.ts`: the allowance is consumed, the task
is forgiven, a replacement is appended, the pending capture is cancelled, and the
challenge returns to `active`. Anything added to the recovery goes in that
transaction too. A recovery that leaves a capture pending gets the user charged
for a miss that no longer exists.

The account row is locked before the challenge row, matching challenge creation
and the funding intent. Any command that reads the lifetime allowance and then
spends it must take that lock: the `accounts_recovery_consumed_once` trigger is
the backstop, and a backstop reached is a 500 rather than a refusal.

The window closes inclusively, at the same instant the app was shown and the same
instant the capture's `execute_after` holds. A capture that is no longer pending
is a closed window, not an internal error.

## Time zone changes

A time zone change moves instants and never dates. Every task keeps its calendar
date and its sequence, and only its deadline and pause cutoff are recomputed,
through `taskInstants` in the schedule engine.

Which tasks move is decided on the stored pause cutoff alone: strictly later than
the receipt instant, and open. Do not reach for "the window has not started"
instead, and do not read the deadline. A task can have a passed cutoff and a
deadline hours away, and that task keeps the terms it was given, because once its
cutoff passes the user can no longer pause it.

A change to the zone the challenge already holds writes nothing at all. A no-op
that touches rows is not a no-op.

## Payments

The provider is reached only through `PaymentProviderClient` in
`server/src/payments/provider.ts`. No domain module imports a processor SDK, and
`FakePaymentProvider` carries the whole flow until a real processor is approved.
Adding an operation means adding it to the interface first, so every
implementation has to answer for it.

Authorizing is not charging. `authorizeDeposit` and `releaseAuthorization` move
no money and cost no fee; `captureAuthorization` and `chargeOffSession` are the
only operations that do, and nothing on the funding path may reach them.

A funded challenge is created by the payment webhook and by nothing else. No
route a client can reach may create one, whatever the client reports about its
own payment. The terms come from the stored `funding_intents` row rather than
from the delivery, which describes no challenge.

Verify a webhook signature over the raw bytes, in the route's signature
verifier, before anything parses the payload. Re-serializing a payload changes
bytes a provider signed, so never verify against a parsed document.

A webhook answers 200 for anything no redelivery would change: an unknown event
type, a delivery naming no funding intent, an intent already settled, a
confirmation for an account that acquired a challenge in the meantime. Reserve a
non-2xx answer for a failure a retry could fix, since anything else buys an
unbounded retry loop from the provider.

A challenge is written by `materializeChallenge` in
`server/src/challenges/materialize.ts`, on both the funded and the unfunded
path. A second writer would be a second chance to get the task count invariant
wrong. Take the account lock first, through `lockAccount`, as every path that
decides whether a challenge may start does.

## Authorizations and renewal

The hold securing a funded challenge is a `challenge_authorizations` row, not a
column on the challenge and not the funding intent. A renewal supersedes that
row and inserts a new one, so the table is also the history a reconciliation
reads. A partial unique index keeps one `live` hold per challenge; anything
asking "which authorization would this act on" reads that row.

Renewal is driven by each hold's own window, never by a cadence: a hold is due
once `now` has passed the midpoint of its `authorized_at` to `expires_at`
window. Do not add a renewal interval constant.

Take the replacement hold before releasing the one it replaces, and release only
after the replacement is committed. A stray hold expires having charged nothing;
an unsecured challenge does not fix itself.

A failed renewal must never fail a challenge. `deposit_secured` is the only
column of `challenges` the renewal path may write. If a new failure mode needs a
challenge to end, it does not belong on this path.

Nothing on the renewal path may capture, charge, forfeit, or write a ledger row:
replacing a hold moves no value. `server/test/authorization-renewal.test.ts`
asserts this over the whole module, so a new import there is a test failure
rather than a review comment.

## The scheduled sweep

The sweep is in `server/src/sweep`, and `run-sweep.ts` owns the order. Step 0
(pause cutoffs and year-long pause expiry) runs before step 1 (overdue tasks) in
every invocation. A skipped task's deadline passes like any other, so judging
overdue tasks first fails a challenge the user had already paused.

Every unit of work the sweep adds must be idempotent by construction: selected
by the state that makes it due, and ending by leaving that state. Do not reach
for a cursor, a counter, or a "last run" instant. Running the sweep twice has to
leave the same rows as running it once, which is also what makes a crashed
invocation safe to repeat.

Nothing the sweep takes may wait. Use `for update skip locked` for every row,
challenges included, and pass over a row somebody else holds rather than
blocking for it. The sweep locks a challenge and then its task while the
completion command locks a task and then updates its challenge, so a blocking
lock is a deadlock waiting for the two to meet. A candidate chosen before the
lock is attempted has to be remembered when the lock is missed, or the next
iteration chooses it again.

A task is overdue strictly after its deadline plus the receipt grace, and it is
left alone entirely while a completion for it is in flight: an `in_progress`
idempotency key naming the task in `subject_id`, with a live lease, claimed no
later than that same instant. A command whose retry is still entitled to succeed
must not have its task resolved underneath it, so a new command that acts on one
resource records that resource as its key's subject.

Steps 0 to 5 create settlement commands and execute none; step 6
(`server/src/payments/settlement.ts`) is the only place one is executed. Give
each command a deterministic dedupe key derived from the kind and the challenge,
so a second pass writes nothing, and put the delay in `execute_after` rather
than in when the command is created. No capture may happen in the transaction
that fails a challenge: that separation is what leaves a user who opens the app
later in the day an intact authorization to recover against.

Marking a task missed and moving its challenge out of `active` belong in one
transaction. The deferred task count trigger rejects any commit that does one
without the other.

## Settlement and the ledger

`recordLedgerMovement` in `server/src/payments/ledger.ts` is the only writer of
`ledger_transactions` and `ledger_entries`. Its module comment states the sign
convention for every account; read it before adding a movement, and add the new
movement there rather than writing the two tables directly. A positive amount is
a debit, a negative one a credit, and the entries of one transaction sum to
zero.

Every outcome of a challenge closes `user_commitment`. A release returns the
deposit to `payment_processor`, a collection moves it to `platform_revenue`, and
a collection that failed for good moves it to `uncollected_forfeit`. Nothing
writes a `processor_fees` entry, because the provider interface reports no fee:
a fee entry would be an invented number in the one record whose value is that it
contains none.

A settlement command is executed once, by the settlement pass, inside the
transaction holding that command's row lock. Collection is a retried command
with a terminal state that alarms: count the attempt, record the reason, leave
the command `pending`, and only after `MAX_COLLECTION_ATTEMPTS` record the
forfeit as uncollected and settle the command `failed`. A collection that simply
throws, or one that gives up silently, is money the product forgot it was owed.

Capture the live hold when there is one and charge the saved instrument
off-session when there is not. A hold another writer has locked is a hold that
exists: pass the command over for the next invocation rather than reading it as
absent, or a renewal in flight becomes a card charged while a capturable
authorization sat there.

## Concurrency

Two writers that take the same rows in opposite orders deadlock, and PostgreSQL
resolves a deadlock by killing one of them. For a pass that calls a payment
provider inside its transaction that is not a retry, it is money moved by a
transaction that then rolled back. So a background pass never waits: every row a
settlement, a renewal, or an overdue evaluation will touch is claimed with `for
update skip locked` before anything is written or charged, and a pass that
cannot have them all takes nothing and leaves the work for the next invocation.

Count the rows a command reaches through its writes, not only the ones it locks
by name. A ledger movement names a challenge and an account, so writing one
takes a lock on both rows through the foreign keys, and those were the two rows
the settlement pass had not claimed.

A row claimed after it was selected must have anything the command decides on
read again under the lock. The status a moment earlier is a status another
writer may have committed since.

New concurrent behavior belongs in
`server/test/integration/concurrency.test.ts`, which ends every race in
`assertInvariantsHold` from `server/test/support/invariants.ts`: the whole
database, checked against every invariant the architecture lists. Two rules for
writing one of those tests:

- Do not assert which side won. Assert that exactly one did, that the loser was
  refused by name, and that the forbidden combination did not happen. A refusal
  may be reachable under more than one code, and accepting the set is honest
  where naming one is a bet on scheduling.
- Give one side a head start when the race is otherwise decided by warm-up. A
  race where the same side wins every run leaves the other branch's assertions
  unreached, which is a test that passes without testing.

An invariant added to the architecture needs a check added to
`invariants.ts` and a case in `invariant-checker.test.ts` that breaks it on
purpose. A check nothing has ever seen fire is not an assertion.

## The mobile app

`app/` is the Expo Router project. `pnpm --filter @betterwakeup/app run start`
opens it against a development build, `run test` runs Jest, and `run bundle`
exports the iOS and Android bundles, which is the cheapest proof that a change
still builds for both platforms without Xcode or Android Studio.

Requests go through `src/api/client.ts`, which is built from the contract's
endpoint registry. Never write a path, a method, an `Authorization` header, or
an `Idempotency-Key` header anywhere else: an endpoint added to the contract is
callable with no edit to the client, and one written by hand would be the only
place a route can disagree with the server.

The client validates a request against the contract before it sends it, so a
request the server would refuse costs no idempotency key and no rate limit
allowance. It parses every response too, and answers an unreadable one with
`internal_error` rather than handing a caller a value the contract does not
describe.

Every failure the client raises is an `ApiError` carrying a contract error code
and the contract's own `disposition`. A caller decides whether to retry by
reading `disposition`, never by matching on a status code or a message: the
retry rule belongs to the contract so the server and the pending completion
store cannot disagree about it. A failure that never reached the server is
`internal_error` with a `null` status, which is retryable because every command
that changes anything carries an idempotency key.

Session material lives in `expo-secure-store` behind `SessionStore`, bound to
the device and never written anywhere else. A stored value this build cannot
parse is discarded rather than thrown at launch, and a `401` from the server
clears it, so a session the server has refused is never presented twice.

Screens read session state from `useSession()`. `loading` is one of its three
states because secure storage is asynchronous: rendering the signed-out screen
while the read is in flight would flash it at a signed-in user.

### Sign-in and sign-out

A native provider is reached only through `ProviderSignIn`
(`src/auth/provider-sign-in.ts`), which has exactly two operations: is this
provider usable here, and give me a credential. Nothing above that interface
imports Apple's or Google's SDK, and `src/auth/native-providers.ts` is the only
module that does. That is not a style rule: both SDKs register a native module
at import time, so a module that named them directly would make every test that
renders a screen need a device. `app/_layout.tsx` builds the real pair once and
passes them to `SessionProvider`.

`authenticate()` resolves to `null` when the user backed out. Cancellation is a
third outcome alongside success and failure everywhere it travels
(`SignInOutcome`), and it must never be shown as an error: a user who dismissed
Apple's sheet has not failed at anything. A provider's own error message is
never shown either, because it names a native module; the user gets one sentence
per contract error code from `src/auth/sign-in.ts`.

A provider that reports itself unavailable is not offered at all. Apple is
absent off iOS, and Google is absent in a build with no client ID, which is the
same condition under which `app.config.ts` leaves Google's config plugin out.
Add a build-dependent plugin there rather than in `app.json`, and gate it on the
configuration it needs: a plugin configured with a placeholder fails the build
instead of hiding a feature.

`SessionProvider` owns every transition, so a screen never writes the session
store. The server refusing a session is one of those transitions: the client
calls `onSessionInvalid` after it discards the stored session, and the provider
moves the app to signed out. The client only does this for a request that
carried the session; `POST /sessions` answers `unauthenticated` for a provider
token it could not verify, which says nothing about what is in storage.

Sign-out calls `DELETE /sessions` so the row is revoked and a copy of the token
is useless, then clears the device whatever the call did. A user with no network
must still be able to sign out of their own phone.

### Movement capture

`expo-sensors` and React Native's `AppState` are reached only through the ports
in `src/movement/pedometer.ts`, and `src/movement/native-pedometer.ts` is the
only module that imports either. Same reason as the sign-in SDKs: a native
module in a test's import graph needs a device.

`src/movement/observation.ts` is the one place a reading becomes a
`MovementObservation`, and the one place in the app that names a provenance at
all. Provenance is never inferred and never defaulted: each observation channel
gets its own function that states its provenance as a literal, no function takes
a provenance argument, and no fallback exists to be wrong. Version 1 has one
channel, so `historical-query` is not constructible from the app. Adding a
second channel means adding a second function here, not a parameter to this one.

`source` comes from the platform the code is running on, and an unsupported
platform throws rather than guessing. Every observation is parsed through the
contract on the way out, so a window that ends before it starts fails in the app
rather than at the server.

Backgrounding is not a pause. A capture ends the instant the app stops being in
front of the user, `inactive` counts as not in front (the iOS app switcher and
an incoming call), and a reading delivered after that is discarded by the
capture itself rather than trusted not to arrive. Coming back starts a fresh
window; it never resumes the old one.

Motion permission is read from the operating system at both ends of a capture,
never cached. Reading it at the start is what notices a revocation performed in
Settings; reading it at the end is what discards a window whose permission the
user took away while it ran. Those steps may be real, but the app no longer has
the user's word that it may look at them.

`watchStepCount` reports steps cumulatively since the subscription began, so the
capture keeps the latest reading rather than adding readings up, and takes the
maximum so an Android counter reset cannot shrink an already-observed window.

### Pending completions

A completion is written to SQLite before the local check is shown, and the
record's own ID is the idempotency key every attempt carries, so a retry after a
crash is the same command rather than a second completion.

`src/completions/sqlite.ts` is a port shaped like the slice of `expo-sqlite` the
store uses, and `src/completions/native-store.ts` is the only module importing
`expo-sqlite`, `expo-network`, or `AppState`. The SQL itself lives in
`store.ts`, which is what lets the tests run the statements the app ships
against a real engine (Node's `node:sqlite`) rather than against a fake that
would agree with whatever the store did.

What happens to a failed attempt is decided by the contract's disposition for
the error code and by nothing else: `reject` marks the record rejected and stops
retrying it, and everything else leaves it pending. Do not match on a status
code or a message anywhere in the app.

A record leaves the store in exactly one way, by being acknowledged. A rejected
record is retained, counted, and surfaced; nothing else deletes anything.

Records are attempted independently and never as a queue. A new trigger (a
moment worth trying again) is a `SyncTrigger`, which is a plain subscribe
function, so adding one needs no change here and no native import above the
ports.

### Challenge setup and disclosure

The configuration being edited lives in `src/challenges/draft.ts` and nowhere
else. Nothing about a half-finished challenge is persisted, so that module
imports no storage at all; if you need to keep something across a launch, it
does not belong in the draft.

Whether a draft describes a legal configuration is answered by handing it to the
contract's own `challengeConfiguration` schema. Do not restate a rule the
contract already carries. The one sentence written here rather than derived is
the deposit gap, because "either nothing or at least a dollar" reads better than
a schema error.

Disclosures are data (`src/challenges/disclosures.ts`), not screen copy, and
each is scoped to `all` or `funded`. Every statement `product.md` requires
before a deposit is one item, and `DISCLOSURE_POLICY_VERSION` names the exact
list. Editing, adding, or removing an item means a later user accepted something
different, so move the version with the list. That version is the `policyVersion`
sent with a challenge, which is what makes the terms stored beside a challenge
the ones the user actually read.

The gate on the deposit belongs in `startChallenge`, not on a screen.
`readinessOf` says what is outstanding, and the command returns `blocked` before
it builds a request, so an unacknowledged disclosure costs no idempotency key
and no rate limit allowance. A screen hiding the button is the second gate, not
the first.

Which door a challenge goes through is decided by the deposit alone: zero goes
to `POST /challenges` and reaches no payment code, and anything else goes to
`POST /challenges/funding-intents`. Assert on the endpoints a test's client was
asked for when you touch this, since "no payment step" is a claim about requests
that were never made.

The maximum duration is the server's answer, read from a projection of the
configuration currently on screen. A funded challenge with no projection is
blocked rather than allowed: a projection the app could not fetch must not open
the deposit path. Re-ask for a projection when the configuration changes and
only then, and clear the old one immediately, so no stale end date is on screen
while its replacement is in flight.

### Pause, recovery, and deletion

An action that cannot be taken back is confirmed in the command, not on the
screen. `src/challenges/lifecycle-commands.ts` takes a `confirmed` flag and
returns `blocked` before it builds a request, so the guarantee survives a new
screen, a deep link, or a test harness. Assert it by checking that the API
client recorded no call at all.

Resume takes no confirmation on purpose. Gate what is irreversible and nothing
else; a confirmation in front of a reversible action trains people to press
through the ones that matter.

`src/challenges/pause.ts` is where anything about how a pause looks belongs. It
compares the server's instants to the clock and derives nothing else: the task a
pause would skip comes from `pauseCutoff`, and the year's approach from
`pause.expiresAt`. Never compute a cutoff or an expiry in the app.

While paused, offer no task and no pause control. The challenge view still
carries an open task, and rendering it as something about to be skipped reads as
a challenge that is still running.

State the outcome of a pause reaching its year rather than urging the user to
act. It costs them nothing, so a prompt would misrepresent it.

### The daily completion screen

The two checks a day needs are separate facts and stay separate in the code.
`src/completions/daily-state.ts` is the only place the server's `TaskView` and
the local pending records meet, and it is pure. Put a new rule about how today
looks there rather than in the screen.

`acknowledged` is produced by the server's task view alone. If you find yourself
reaching for a local record to decide that the day is done, stop: a record on
this device says nothing about what the server received, and the product makes
the server's acknowledgment the condition for credit.

A rejected record outranks a pending one, and a rejected record is never given a
retry action. The architecture says a rejection is surfaced and never retried
silently, and an action that resends it is a retry with extra steps.

Warn about a near deadline only while synchronization is pending. An incomplete
task is already saying it is not done, and a second alarm for the same fact
teaches people to ignore alarms.

Compare a capture against the challenge's `stepTarget` before writing anything
to the store. A stored completion is what the local check reports, so storing a
short window would make that check a lie and would spend an idempotency key on a
request the server would refuse.

### Crash and synchronization reporting

Nothing above `src/reporting/native-reporting.ts` imports Sentry. A caller holds
a `CrashReporter` and hands it a `Report`, whose `fields` are a closed set the
same way the server's log fields are: adding a field is a source change with a
name on it, not something a call site can do in passing.

`scrubPayload` is the net under that, installed as Sentry's `beforeSend`, and it
is the only thing standing between the SDK's own payloads and the network. A new
kind of sensitive value needs a marker in `FORBIDDEN_NAME_MARKERS`, a rule in
`RULES`, or both, plus a test that fails without it.

Report a defect, not a condition. A rejected completion means the app and the
server disagree about what a valid completion is; a deferred one usually means
the network is down. So a rejection is reported at once and a deferral is
reported once, on the attempt that crosses `STALLED_AFTER_ATTEMPTS`, and an
acknowledgment is not reported at all.

## Infrastructure

Infrastructure is AWS CDK in TypeScript under `infra`. `infra/bin/cdk-app.ts` is
what `cdk.json` runs; `infra/src/app.ts` holds `defineApp` so a test can build
the tree without synthesizing an assembly as an import side effect.

Run `pnpm --filter @betterwakeup/infra run synth` to produce a template. It
works from a clean checkout: the function's code defaults to the checked-in
placeholder in `infra/lambda-bundle-placeholder`, and the deploy pipeline passes
a built bundle through the `bwu:codeAssetPath` context key instead.

Deployment decisions arrive as CDK context (`bwu:stage`, `bwu:region`,
`bwu:account`, `bwu:codeAssetPath`) and are read in exactly one place,
`readStackConfiguration`. A missing or nonsensical value fails at synth, where
somebody is watching. The region is required and must be one Neon runs in,
because the architecture requires the Lambda and the database to share a region.

Never put anything that grants access in a resource property. A synthesized
template is readable by anyone who can describe the stack, so secrets are
Parameter Store SecureString entries the role is granted a read of, and a test
asserts every Lambda environment variable is neither named nor shaped like a
credential.

Every stack change needs a template assertion. `Template.fromStack` synthesizes
in process, so an assertion costs a millisecond and is the only thing standing
between a review and a deploy.

`GET /health` is an operational probe and is deliberately outside the contract's
endpoint registry. It takes no session, spends no rate limit, and opens no
database connection, so it answers whenever the function is running at all. Keep
it that way: a probe that can fail for a second reason stops answering the
question it exists to answer.

## Commits

Use Conventional Commits.

Write the subject in imperative grammar. Omit the trailing period.

Wrap body lines at 72 columns. Explain why when the rationale is not
obvious from the diff.

```text
feat(catalog): filter food items by multiple categories

Selections are additive, while an empty selection means no filter.

Refs #4
```

Allowed types:

- `feat`
- `fix`
- `refactor`
- `test`
- `docs`
- `chore`
- `build`
- `ci`
- `perf`

For work tied to a GitHub issue, use `Refs #N` in commits and
`Closes #N` in the pull request.

`commitlint.config.ts` encodes the mechanical rules: the type list, the
absent trailing period, and the 72-column subject and body limits. CI runs it
over every commit in a pull request, and `pnpm run lint:commits` runs the same
check locally against `origin/main`. Review enforces what a linter cannot judge:
imperative grammar, rationale, and issue traceability.

## Continuous integration

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main`. The
`check` job runs the same `lint`, `typecheck`, and `test` scripts `pnpm run
check` runs locally, and the `commits` job runs commitlint over the pull
request's commit range. Both must be required status checks on `main` for CI to
block a merge; that setting lives in the repository, not the repository's files.
