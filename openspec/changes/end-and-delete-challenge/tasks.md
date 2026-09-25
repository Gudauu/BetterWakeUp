## 0. Fix the dropped capture after an accepted recovery

- [x] 0.1 Add a failing regression test to `sweep.test.ts` or `recovery.test.ts`: funded challenge, miss, accept recovery, miss again; assert the challenge is `failed`, one pending capture exists due at the second miss, and the settlement pass collects it
- [x] 0.2 Derive capture dedupe keys from their cause in `server/src/sweep/payment-commands.ts` (`capture:miss:<taskId>`), keep `release_authorization` per challenge, and update the sweep and account-deletion tests that assert the old key format
- [x] 0.3 Prove a pre-change pending capture with key `capture:<challengeId>` still executes, is cancelled by recovery, and blocks account deletion as before
- [x] 0.4 Commit this fix on its own, before the ending work

## 1. Product rule and plan

- [x] 1.1 Add a section to `docs/product.md` stating the rule: a running challenge (paused, not paused, or with a recovery offer standing) can be ended and settles as a failure, ending never spends the Emergency Recovery, the hold stops renewing when the challenge ends, and any ended challenge can be deleted from view while it stays stored. Check that "It is all or nothing" and "There is no early release" still read true beside it
- [x] 1.2 Add an issue for this change to `docs/phased-plan.markdown`, after 34b, with dependencies and a "Done when" that points at the two specs

## 2. Contract

- [x] 2.1 Add `abandoned` to `challengeStatus` and to `endedChallengeSummary.status` in `packages/contract/src/challenges.ts`, and update the doc comments that list the terminal statuses and which ones forfeit
- [x] 2.2 Add the error code `challenge_not_ended` with disposition `reject` in `packages/contract/src/errors.ts`
- [x] 2.3 Add the `abandonChallenge` (`POST /challenges/:challengeId/abandonment`, response `endedChallengeSummary`) and `deleteChallenge` (`DELETE /challenges/:challengeId`, empty response) endpoints, both idempotent with no body, in `packages/contract/src/endpoints.ts`
- [x] 2.4 Extend the contract's tests to cover the new enum value, the new error code, and both endpoint definitions

## 3. Database

- [x] 3.1 Write migration 0012: add the `abandoned` enum value, recreate `challenges_terminal_status_has_instant` on `status::text`, add `deleted_at` with the "only a terminal challenge can be deleted" check, and replace `challenges_status_transition()` so it allows `active` → `abandoned` and `recovery_pending` → `abandoned`, treats `abandoned` as terminal, and makes `deleted_at` immutable once set
- [x] 3.2 Mirror the column and constraints in `server/src/db/schema/challenges.ts`, and make `schema-drift.test.ts` pass
- [x] 3.3 Extend `migration-upgrade.test.ts` to migrate a database at 0011 that holds challenges in every status, and prove the chain from empty still applies in one transaction
- [x] 3.4 Extend `invariant-assault.test.ts` with raw-SQL attacks: `abandoned` → any status, setting `deleted_at` on an open challenge, rewriting or clearing a set `deleted_at`

## 4. Server: ending a challenge

- [x] 4.1 Add `server/src/challenges/abandon-challenge.ts`: an idempotent transaction that locks the challenge, answers `not_found` or `challenge_not_active`, sets `abandoned` and `terminal_at`, and for a funded challenge either brings the offer's pending capture forward to now (from `recovery_pending`) or creates a capture keyed `capture:abandon:<challengeId>` due now (from `active`)
- [x] 4.2 Add `abandoned` to `COLLECTABLE_CHALLENGE_STATUSES` in `server/src/payments/settlement.ts`
- [x] 4.3 Wire the route in `server/src/challenges/handlers.ts` and make `handler-set.test.ts` see it
- [x] 4.4 Add `server/test/integration/abandonment.test.ts` covering every `challenge-ending` scenario on the server: active, paused, `recovery_pending` (same capture brought forward, allowance kept), after an accepted recovery (new capture collected), zero deposit, secured and unsecured funded (collected by the settlement pass), no renewal of the hold after ending, recovery allowance kept, refusals by status and by owner, idempotent replay with one capture, and a new challenge accepted afterward
- [x] 4.5 Add race tests to `concurrency.test.ts`: end against the final completion, end against the sweep failing the challenge, end against the sweep opening an offer, end against accept-recovery, and a completion after ending

## 5. Server: deleting a challenge and the ended summary

- [x] 5.1 Add `server/src/challenges/delete-challenge.ts`: an idempotent transaction that locks the challenge, answers `not_found` or `challenge_not_ended`, and sets `deleted_at` only if it is null
- [x] 5.2 Wire `DELETE /challenges/:challengeId` in `handlers.ts`
- [x] 5.3 In `current-challenge.ts`, add `abandoned` to the terminal list, return `lastEnded: null` when the most recent ended challenge is deleted, and report `charged` for a funded `abandoned` challenge
- [x] 5.4 Add `server/test/integration/challenge-deletion.test.ts` covering every `challenge-deletion` server scenario: each ended status, twice, open statuses refused, foreign owner, rows retained, pending capture still collected after deletion, recovery allowance unchanged, `lastEnded` null without falling back, a later challenge reported, and account deletion removing a deleted challenge
- [x] 5.5 Search the server for every other hard-coded terminal or open status list (renewal, sweep passes, account deletion, the invariant checker) and confirm each one is right for `abandoned`, changing any that are not

## 6. App

- [x] 6.1 Add `endChallenge` and `deleteChallenge` to the API client and to `app/src/challenges/lifecycle-commands.ts`, both gated on `confirmed`, with tests asserting no request is made without it and that each error code maps to a message
- [x] 6.2 Add a pure module for the end-challenge consequence text (funded: amount, now, cannot be undone; zero deposit: nothing charged; offer standing: the Emergency Recovery stays for a future challenge) with unit tests
- [x] 6.3 Add "End challenge" to `challenge-details-screen.tsx` behind a danger-toned `ConfirmAction`, shown in `active` and `recovery_pending`, and add `abandoned` to `STATUS_HEADLINE` and `STATUS_TONE`
- [x] 6.4 In `home-screen.tsx`, route a successful end to home with the returned summary in `finished`, add "Delete" with confirmation to the ended card that clears it and re-reads on success, and remove the card's "Got it" link (`home-finished-dismiss`) and its `onDismiss` prop, updating the tests that press it
- [x] 6.5 Add the `abandoned` cause to `app/src/challenges/ended-challenge.ts`, with tests
- [x] 6.6 Extend the fake API and journey server in `app/test/support`, then add screen and journey tests: end a funded and a zero-deposit challenge, back out of each confirmation, end during a recovery offer, reminders cancelled after ending, delete an ended card, and the deletion surviving a restart

## 7. Architecture and verification

- [x] 7.1 Update `docs/architecture.md`: the endpoint list, the challenge state diagram and terminal list, the `lastEnded` section (deleted challenges), the settlement section (`abandoned` is collectable, capture dedupe keys name their cause), and the app screens that gained controls
- [x] 7.2 Run lint, type check, unit tests, and the server integration suite. Fix any failure, including ones this change did not cause
- [ ] 7.3 Run the app end to end: end a funded challenge, end a paused one, delete the ended card, restart, and check every new screen and confirmation for layout and copy problems at phone width
- [x] 7.4 Record the change in `docs/work-log.md`, including that the server and app must ship together and the rollback caveat about pending captures
