# Contributing

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
`Closes #N` in the pull request. Automated checks may validate the
conventional subject and line lengths. Review enforces imperative
grammar, rationale, and issue traceability.
