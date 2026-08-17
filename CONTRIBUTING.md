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
