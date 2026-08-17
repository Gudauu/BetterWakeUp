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

## Handed back

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
