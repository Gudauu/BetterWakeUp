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
