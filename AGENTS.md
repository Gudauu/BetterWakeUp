# Agent instructions

Read `zen.md` before making changes.

Project documents, in the order a newcomer should read them:

- `docs/product.md` - product rules. What the thing does.
- `docs/architecture.md` - technical direction, toolchain, reversed positions, and
  the App Store position. How it is built and why it is built that way.
- `docs/phased-plan.markdown` - issue-by-issue sequencing and release gates.
- `docs/work-log.md` - which issues are built, and what is waiting on a human.
- `docs/deployment.md` - the development backend runbook. Read it before changing
  deployed database credentials, applying remote migrations, or deploying the API.

A rule belongs in exactly one of these. State it where it is owned and link to it
from anywhere else that needs it.

When asked to create a commit or commit message, read `CONTRIBUTING.md` and use
the globally configured commit skill.