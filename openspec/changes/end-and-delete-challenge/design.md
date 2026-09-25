## Context

See `proposal.md` for why, and `specs/challenge-ending` and `specs/challenge-deletion` for the required behavior.

The parts of today's system this change has to fit:

- **Status is a Postgres enum with rules written in several places.**
  `challenge_status` is `active`, `recovery_pending`, `succeeded`, `failed`, `expired`.
  The terminal set is written out in the schema's check constraint `challenges_terminal_status_has_instant`, in the `challenges_status_transition` trigger (migration 0005), in `current-challenge.ts`, and in the contract.
  The open set (`active`, `recovery_pending`) is written out in the partial unique index that gives an account one challenge, in `delete-account.ts`, and in `renewal.ts`.
- **A failure is two steps.** The overdue sweep moves the challenge to `failed` (or `recovery_pending`) and creates a `capture` payment command with an `execute_after`. The settlement pass later executes due commands. It only captures while the challenge is in `COLLECTABLE_CHALLENGE_STATUSES` (`failed`, `recovery_pending`) and cancels the command otherwise.
- **Capture commands are deduplicated per challenge for life.** `createSettlementCommand` inserts with dedupe key `capture:<challengeId>` and `on conflict do nothing`. A capture cancelled by an accepted recovery keeps that key, so a later miss on the same challenge creates no capture at all. The challenge ends `failed`, reports `charged`, is no longer renewed, and is never collected. Reproduced with an integration test against the real sweep and recovery route. A partial unique index separately allows one `pending` capture per challenge.
- **Renewal follows status.** `renewal.ts` renews only holds whose challenge is `active` or `recovery_pending`, so any move to a terminal status stops renewal with no further change.
- **Remaining tasks of a failed challenge stay `scheduled`.** The deferred task-count trigger only checks `active` and `succeeded`, so a terminal challenge's unfinished tasks need no change.
- **Pause is `paused_at` on an `active` challenge,** not a status. A paused challenge is `active`.
- **Lock order.** The completion command locks a task and then its challenge. The sweep locks a challenge and then a task, with `skip locked`. Recovery locks the account and then the challenge.
- **`lastEnded`** is the most recent terminal challenge by `terminal_at`, read in `current-challenge.ts`.
- **Migrations** run through the drizzle migrator, which applies every pending file in one transaction.

## Goals / Non-Goals

**Goals:**

- Ending reuses the failure's settlement path end to end, so "treated like a failure" holds by construction instead of by a parallel implementation.
- The database refuses a deleted open challenge and a second deletion instant, the same way it already refuses leaving a terminal status.
- Every list of terminal statuses learns `abandoned` in one change, with exhaustiveness forcing the app's copy tables.

**Non-Goals:**

- A past-challenges view. This change only keeps the rows it would read.
- A separate "decline recovery" command. Ending a `recovery_pending` challenge ends the challenge; it is not recorded as declining the offer.
- Changing account deletion, or the deletion-hold screen's wording.
- Marking an abandoned challenge's unfinished tasks with a new task status.

## Decisions

### A new terminal status `abandoned`, not `failed` plus a flag

Chosen with the user.
Every reader that asks "did this fail by a miss" would otherwise have to check a second column, and the history view this is preparing for needs the distinction.
Cost: every hard-coded terminal list changes.
`TERMINAL_CHALLENGE_STATUSES` in `current-challenge.ts`, the contract enums, the check constraint, and the transition trigger all gain `abandoned`.
`COLLECTABLE_CHALLENGE_STATUSES` in `settlement.ts` gains `abandoned`, because without it the settlement pass would cancel the capture that ending created.

The transition trigger allows `active` → `abandoned` and `recovery_pending` → `abandoned`.

### Ending creates a capture due now, from the same helper the sweep uses

`abandon-challenge.ts` runs in one idempotent transaction:

1. Lock the caller's challenge `for update` (waiting, not `skip locked`: this is a user command and should queue behind a completion instead of giving up).
2. Refuse unless the status is `active` or `recovery_pending` (`not_found` for a missing or foreign id first).
3. Set `status = 'abandoned'`, `terminal_at = now`.
4. For a funded challenge:
   - from `recovery_pending`, move the offer's pending capture to `execute_after = now`. Inserting a second one would break the one-pending-capture index, and there is only one forfeit;
   - from `active`, create a capture keyed `capture:abandon:<challengeId>`, due now.
5. Return the ended summary.

It locks only the challenge and touches no task or account row, so it cannot deadlock against the completion command (task then challenge), the sweep (challenge then task, never waiting), or recovery (account then challenge).

Found in implementation: the completion command used to lock only its task and read the challenge's status unlocked, so a completion racing an ending was recorded, with a hold release, on the ended challenge. It now locks the challenge after the task and reads the status under that lock. That is the order its success update already took, so no new wait cycle appears.
Whichever of them commits first decides the outcome.
The loser sees a non-`active` status after its lock and is refused, which is what the race scenarios in the spec require.

The capture is executed by the next sweep, not inline.
Alternative: call the provider inside the request.
Rejected because the settlement pass already owns retries, `uncollected` recording, and the double-capture reconciliation, and a second caller would have to copy all of them.
The ended summary reports `depositOutcome: "charged"` immediately, exactly as a failure does while its capture is pending.

Emergency Recovery is untouched: the account row is neither locked nor read. Ending during an offer leaves the allowance unspent. Recovery racing an ending is refused with `recovery_not_offered` once the ending commits, because it re-reads the status under its lock.

Renewal needs no change for this: `abandoned` is not a status that renews, so the hold stops being renewed in the same transaction that ends the challenge. The pending capture then acts on the live hold, or charges the saved card if the hold has lapsed.

### Capture dedupe keys name their cause

The fix for the dropped capture, and a prerequisite for ending after a recovery.
`dedupeKeyFor` derives the key from what forfeited the deposit:

- a miss: `capture:miss:<taskId>`. A task can be missed once, so a second sweep over the same miss still writes nothing;
- an ending: `capture:abandon:<challengeId>`. A challenge can be ended once.

The partial unique index on pending captures stays and still guarantees one pending capture per challenge.
Existing rows keep `capture:<challengeId>`, which neither new form can produce, so no data migration is needed.
`release_authorization` keeps its per-challenge key, since a hold is released at most once.

Alternative: make the conflict target the pending-only index, so a cancelled capture no longer blocks.
Rejected because then a confirmed or failed capture would also stop blocking, and the dedupe would rest on status timing instead of on identity.

This lands as its own commit before the ending work, with a regression test reproducing the dropped capture first.

`paused_at` is left as it was.
It records that the challenge was paused when it ended, which a history view can use, and no constraint ties it to `active`.

### Response of ending is the ended summary

`POST /challenges/:challengeId/abandonment` answers with an `EndedChallengeSummary`, the same shape as `lastEnded`.
Home already has a `finished` slot that shows a completion-ended challenge without waiting for a re-read, and the same slot takes this one.
Alternative: return nothing and re-read `GET /challenges/current`.
Rejected because the user would see the running challenge flash back on screen between the press and the read.

### Endpoint shapes

- `POST /challenges/:challengeId/abandonment`, idempotent, with an empty `{}` body like `POST /pause`, answering `{ ended: EndedChallengeSummary }`.
  A noun sub-resource like `/pause` and `/recovery`, so the ending is a thing that was created, not a verb in the path.
- `DELETE /challenges/:challengeId`, idempotent, no body, empty response.
  To the client the challenge is gone, which is what `DELETE` says. The row surviving is a server storage choice.

### Deletion is a `deleted_at` instant guarded by the database

A nullable `deleted_at` on `challenges`, plus:

- a check constraint `deleted_at is null or status in (terminal set)`, so a deleted open challenge is unrepresentable;
- an addition to `challenges_status_transition`: once `deleted_at` is set it cannot change, matching how `terminal_at` is guarded.

Because a terminal status can never be left, a deleted challenge can never be reopened either.

`delete-challenge.ts` locks the challenge, answers `not_found` for a missing or foreign id, refuses `challenge_not_ended` for an open status, and otherwise sets `deleted_at = coalesce(deleted_at, now)`.
Deleting an already deleted challenge succeeds without changing the instant, so a retry with a fresh key after a lost response is not an error.

Alternatives considered:

- A separate `challenge_deletions` table. Rejected: it adds a join to every read for one instant.
- Hard delete. Rejected by requirement 3 of the request.

`challenge_not_ended` is a new error code with disposition `reject`.
Reusing `challenge_not_active` would tell the app the opposite of what went wrong.

### `lastEnded` reads the most recent ended challenge, then checks deletion

The query stays "most recent terminal challenge by `terminal_at`" and returns null if that one has `deleted_at` set.
Filtering deleted rows in the `where` would instead surface an older challenge the user never asked to see again.

### Migration: add the enum value, compare as text where it is used in the same transaction

Postgres refuses to use an enum value added by `ALTER TYPE ... ADD VALUE` before the adding transaction commits, and the drizzle migrator applies all pending files in one transaction.
The new migration therefore:

1. `ALTER TYPE challenge_status ADD VALUE 'abandoned'`.
2. Recreates `challenges_terminal_status_has_instant` comparing `status::text`, so creating it does not cast `'abandoned'` to the enum.
3. Adds `deleted_at` and its check constraint, also on `status::text`.
4. Replaces `challenges_status_transition()` with a version that knows `abandoned` and guards `deleted_at`. A PL/pgSQL body is not checked against the enum until it runs, so it can name the new value.

Alternative: rebuild the enum type and cast the column.
Rejected because it rewrites the table and has to drop and recreate the partial unique index and status index around it.

The schema file mirrors the constraints so `drizzle-kit` generates no drift.
A migration test must run the full chain from an empty database, and from a database at 0011 that holds rows in every status.

### App

- `lifecycle-commands.ts` gains `endChallenge` and `deleteChallenge`. Both take the `confirmed` flag and refuse before building a request without it, like pause, recovery, and account deletion.
- The challenge page shows "End challenge" under pause, drawn with `ConfirmAction` in the danger tone, in `active` and `recovery_pending` alike.
  The consequence text lives in a small pure module next to `miss-cost.ts` so it is unit-tested apart from the screen: funded names the amount, "now", and "cannot be undone"; zero-deposit says nothing is charged; during an offer it adds that the Emergency Recovery stays for a future challenge.
- After a successful end, home puts the returned summary in `finished` and pops back to home. The existing reminder reconciliation already cancels everything when `challenge` is null.
- The ended card gains "Delete" behind `ConfirmAction`. On success it clears `finished`, marks the id dismissed, and re-reads.
- The ended card's "Got it" link (`home-finished-dismiss`) is removed, with its `onDismiss` prop.
  It hid the card in memory only, so the card came back on the next launch, and beside a permanent "Delete" it would be a second way to put the card down that does not last.
  The card keeps two actions: start a new challenge, or delete this one.
  The `dismissed` state in `home-screen.tsx` stays, because opening the creation form and a successful delete still use it to keep the card from flashing back before the next read.
- `ended-challenge.ts` gains an `abandoned` cause ("You ended this challenge"). The details screen's `STATUS_HEADLINE` and `STATUS_TONE` records gain `abandoned`. They are `Record<ChallengeStatus, ...>`, so the compiler lists every place that must change.

## Risks / Trade-offs

- [A user ends a funded challenge by mistake and is charged] → Two presses, danger tone, the amount named, and "cannot be undone" stated before the request exists. The command itself refuses without confirmation, and a test asserts no request is made.
- [An app build older than the server receives `abandoned` and fails to parse `GET /challenges/current`] → The app and server ship from one repository. Deploy the server and the app build together, and state it in the work log. No production users exist yet.
- [A walk held offline for the ended challenge is refused on sync] → The existing refusal path shows `challenge_not_active` for a held walk. It is the right outcome, since the challenge is over, so no special case is added.
- [The enum migration fails in the single-transaction migrator] → The text-cast approach above, proven by the migration chain test before anything touches the development database.
- [A pending capture on an abandoned challenge blocks account deletion until the next sweep] → Same as a failure today. The deletion-hold screen already explains a pending settlement.
- [Deleted rows grow without bound] → Acceptable: one row per challenge per user, and the history view is the reason to keep them.

## Migration Plan

1. Contract, migration, and server change land together. Run the migration chain test and the integration suite against a local Postgres.
2. Apply the migration to the development database per `docs/deployment.md`, then deploy the API.
3. Ship the app build that understands `abandoned` in the same release. The server never produces `abandoned` until a client calls the new endpoint, so the migration alone changes nothing an older app reads.

Rollback: redeploy the previous API. The enum value and column can stay. Postgres cannot drop an enum value without rebuilding the type, and nothing reads them once the endpoints are gone. An old server would treat an `abandoned` row as neither open nor ended, so it would report no `lastEnded` for it. Its settlement pass would also cancel any pending capture for it, because `abandoned` is not in its collectable list. So roll back only after every abandoned challenge's capture has settled, or hold the sweep until they have.

