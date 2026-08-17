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

Integration tests need a running Docker daemon. They live in
`server/test/integration` and run as the `server-integration` Vitest project,
separately from the unit tests, which need no container. One container is
started per run, migrations are applied once to a template database, and each
test gets its own database copied from that template. Isolation is therefore a
real database rather than a transaction the test must remember not to commit,
which is what lets a test hold two connections and observe locking. Use
`useTestDatabase()` from `server/test/support/postgres.ts`.

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
