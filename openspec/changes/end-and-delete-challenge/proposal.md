## Why

A user who stops caring about a challenge has no way out of it.
A running challenge holds the account's only challenge slot until it succeeds, fails, or sits paused for a year.
A challenge that has ended stays on home as the last-ended card: "Got it" hides it only until the app restarts, and the server keeps reporting it until another challenge exists.
Users need a deliberate way to give up a running challenge, and a durable way to clear an ended one.

## What Changes

- A user can **end** a running challenge (`active` including paused, or `recovery_pending`) from the challenge page.
  Ending is settled exactly like a failure: a funded deposit is charged in full, immediately.
  Ending is what changes the deposit: the capture is due at once and the hold stops being renewed.
  Ending never offers or consumes the Emergency Recovery. An unspent one, including one standing on this challenge's open offer, stays with the account.
  A zero-deposit challenge ends with nothing charged.
  The challenge moves to a new terminal status, `abandoned`, so "gave up" stays distinguishable from "missed a morning".
- A user can **delete** any ended challenge (`succeeded`, `failed`, `expired`, `abandoned`) from its ended card on home.
  Deletion hides the challenge from the user for good; the row, its tasks, and its ledger stay in the database for a future past-challenges view.
  Deletion never touches money, because by the time a challenge can be deleted its deposit has already been released or its capture already created.
- The ended card's "Got it" link is removed, so "Delete" is the only way to put an ended challenge away. "Got it" hid the card only until the app restarted.
- The user-facing words differ on purpose: "End challenge" for a running one, "Delete" for an ended one.
  "Delete" on a running funded challenge would read like undoing it, the opposite of what it costs.
- **Bug fix, prerequisite:** a miss after an accepted Emergency Recovery fails the challenge but never charges the deposit.
  The capture command's dedupe key is `capture:<challengeId>`, and the capture cancelled by the recovery already holds it, so the second miss's capture is silently dropped.
  The hold is then no longer renewed, and it lapses.
  Reproduced against the integration database: the challenge ends `failed` with only the cancelled capture.
  Ending after an accepted recovery would hit the same trap, so capture commands become keyed by what caused them.
- New endpoints: `POST /challenges/:challengeId/abandonment` and `DELETE /challenges/:challengeId`.
- `GET /challenges/current` no longer reports a deleted challenge as `lastEnded`.
  **BREAKING** (contract): `challengeStatus` and `endedChallengeSummary.status` gain `abandoned`.
  The app and server ship together from one repository, so no deployed client reads the old enum; an app build older than the server would fail to parse an `abandoned` summary.
- Product rules in `docs/product.md` gain a section for ending and deleting a challenge.
  "It is all or nothing" and "There is no early release" still hold: ending early forfeits, it does not release.

## Capabilities

### New Capabilities

- `challenge-ending`: ending a running challenge early, how it settles, and how the app confirms and reports it.
- `challenge-deletion`: deleting an ended challenge, hiding it from the user while keeping it stored.
- `forfeit-collection`: every forfeiting outcome of a funded challenge creates exactly one collectable capture, including a miss after an accepted recovery.

### Modified Capabilities

None.
`openspec/specs/` holds no capabilities yet; today's challenge lifecycle is specified in `docs/product.md` and `docs/architecture.md`.

## Impact

- **Contract** (`packages/contract`): `challengeStatus`, `endedChallengeSummary`, two new endpoint definitions with request/response schemas, any new error codes.
- **Database** (`server/drizzle`, `server/src/db/schema/challenges.ts`): `abandoned` added to `challenge_status`; a new `deleted_at` column; the terminal-status check constraint and the `challenges_status_transition` trigger updated to know `abandoned`; a constraint that only a terminal challenge can be deleted and that `deleted_at` is set once.
- **Server**: new `abandon-challenge.ts` and `delete-challenge.ts` commands under `server/src/challenges`, routes in `handlers.ts`, `current-challenge.ts` (`lastEnded` skips deleted, deposit outcome for `abandoned`), `payments/settlement.ts` (capture collectable for `abandoned`), and every list of terminal statuses (`delete-account.ts`, renewal, sweep passes).
- **App**: `lifecycle-commands.ts` gains two gated commands; `challenge-details-screen.tsx` gains "End challenge" behind `ConfirmAction`; the home ended card gains "Delete"; `ended-challenge.ts` and status copy learn `abandoned`.
- **Docs**: `docs/product.md` (the rule), `docs/architecture.md` (endpoints, challenge state diagram, `lastEnded`), `docs/phased-plan.markdown` (a new issue), `docs/work-log.md`.
- **Payments**: no new provider calls. Ending reuses the capture settlement command with `execute_after = now`, or brings an open offer's pending capture forward to now. `sweep/payment-commands.ts` derives capture dedupe keys from the cause, and existing rows keep their keys.
- **Account deletion**: unchanged. It still cascades every challenge row, deleted or not, because the App Store deletion requirement outranks history.
