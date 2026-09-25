## Purpose

Lets a user permanently remove an ended challenge from what the app shows them, while the system keeps the challenge stored for a future past-challenges view.

## ADDED Requirements

### Requirement: An ended challenge can be deleted by its owner

The system SHALL let the owner delete a challenge whose status is `succeeded`, `failed`, `expired`, or `abandoned`.
Deleting SHALL record the instant of deletion and SHALL NOT remove the challenge, its tasks, its completions, its payment commands, or its ledger entries from storage.

#### Scenario: Deleting a failed challenge

- **WHEN** the owner deletes a challenge whose status is `failed`
- **THEN** the request succeeds, the challenge is marked deleted, and its stored rows remain

#### Scenario: Deleting each ended status

- **WHEN** the owner deletes a challenge whose status is `succeeded`, `expired`, or `abandoned`
- **THEN** the request succeeds exactly as it does for `failed`

#### Scenario: Deleting twice

- **WHEN** the owner deletes a challenge that is already deleted
- **THEN** the request succeeds and the recorded deletion instant is unchanged

### Requirement: Only an ended challenge can be deleted

The system SHALL refuse to delete a challenge whose status is `active` or `recovery_pending`, with the error `challenge_not_ended`, and SHALL change nothing.
The system SHALL answer `not_found` for a challenge identifier that names no challenge or names another account's challenge.
The stored data SHALL make a deleted open challenge unrepresentable, so no future code path can produce one.

#### Scenario: Deleting a running challenge

- **WHEN** the owner tries to delete a challenge whose status is `active`
- **THEN** the request is refused with `challenge_not_ended` and the challenge keeps running

#### Scenario: Deleting during a recovery decision

- **WHEN** the owner tries to delete a challenge whose status is `recovery_pending`
- **THEN** the request is refused with `challenge_not_ended` and the recovery offer is unchanged

#### Scenario: Someone else's challenge

- **WHEN** a user tries to delete a challenge that belongs to a different account
- **THEN** the request is answered `not_found`

### Requirement: Deletion does not change money or allowances

Deleting a challenge SHALL NOT cancel, delay, or alter any settlement for it, and SHALL NOT change the account's Emergency Recovery.
Every change to the deposit happens when the challenge ends, not when it is deleted: by then a success or an expiry has released the hold, and a failure or an ending has created the capture and stopped renewals.

#### Scenario: Collection still retrying

- **WHEN** the owner deletes a failed challenge whose capture has not yet been collected
- **THEN** the capture stays pending and later settlement passes still try to collect it

#### Scenario: Recovery allowance

- **WHEN** the owner deletes a challenge
- **THEN** whether the account holds its Emergency Recovery is the same before and after

### Requirement: A deleted challenge is not reported as the last ended one

`GET /challenges/current` SHALL report `lastEnded` as null when the account's most recently ended challenge is deleted.
It SHALL NOT fall back to an older ended challenge in that case.
A challenge that ends after the deletion SHALL be reported as `lastEnded` as usual.

#### Scenario: Most recent ended challenge deleted

- **WHEN** the account's most recently ended challenge is deleted and no challenge is open
- **THEN** `GET /challenges/current` answers `challenge: null` and `lastEnded: null`

#### Scenario: Older ended challenge not resurfaced

- **WHEN** the account has two ended challenges and the owner deletes the more recent one
- **THEN** `lastEnded` is null rather than the older challenge

#### Scenario: A later challenge ends

- **WHEN** the owner deletes an ended challenge, starts a new one, and that one ends
- **THEN** `lastEnded` reports the new challenge

### Requirement: Deletion is idempotent

The delete request SHALL require an idempotency key.
A repeated request with the same key SHALL return the first response.

#### Scenario: Retried request after a lost response

- **WHEN** the app repeats a delete request with the idempotency key of one that already succeeded
- **THEN** the same response is returned and nothing else changes

### Requirement: The app confirms before deleting and the removal lasts

The app SHALL offer "Delete" on the ended-challenge card on home, for every ended status.
Deleting SHALL be the only way to remove the ended-challenge card other than starting a new challenge; the card SHALL NOT offer a dismissal that lasts only until the app restarts.
The app SHALL require a second, explicit confirmation before sending the request, stating that the challenge is removed from the app and that deleting does not change any charge or refund.
After deletion succeeds, home SHALL show the no-challenge state, and SHALL keep showing it after the app restarts.

#### Scenario: Confirming deletion

- **WHEN** the user presses "Delete" on the ended-challenge card and confirms
- **THEN** the request is sent and home shows "No challenge running"

#### Scenario: Backing out

- **WHEN** the user dismisses the confirmation
- **THEN** no request is sent and the ended-challenge card stays

#### Scenario: The card's actions

- **WHEN** home shows the ended-challenge card
- **THEN** its only actions are starting a new challenge and "Delete", and there is no "Got it"

#### Scenario: Survives a restart

- **WHEN** the user deletes an ended challenge and then restarts the app
- **THEN** home shows "No challenge running", not the deleted challenge's card

### Requirement: Account deletion still removes every challenge

Deleting the account SHALL remove all of its challenges, deleted or not, as it does today.

#### Scenario: Account with a deleted challenge

- **WHEN** an account holding a deleted challenge and no unsettled funded challenge is deleted
- **THEN** the deleted challenge's rows are removed with the account
