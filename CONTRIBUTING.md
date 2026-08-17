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

The workspace holds `server`, `infra`, `packages/contract`, and `tools`, which
holds tests for repository tooling rather than shipped code. The Expo app in
`app/` joins the workspace when issue 27 scaffolds it, and uses jest-expo rather
than Vitest. Tool choices are recorded under "Toolchain" in
`docs/architecture.md`.

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

A handler receives a `HandlerInput`: a body, path parameters, and an idempotency
key that were all parsed at the boundary against the contract. It never re-checks
them, and it never reads the raw request. Its return value is parsed against the
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
