## Purpose

Lets a user end a running challenge before it finishes, at the cost a failure would carry, so a challenge they no longer want does not hold the account's only challenge slot.

## ADDED Requirements

### Requirement: A running challenge can be ended by its owner

The system SHALL let the owner of an `active` or `recovery_pending` challenge end it, whether or not the challenge is paused.
Ending SHALL move the challenge to the terminal status `abandoned` and record the instant it ended.
Ending SHALL free the account's challenge slot, so a new challenge can be created afterward.

#### Scenario: Ending an active challenge

- **WHEN** the owner ends a challenge whose status is `active` and which is not paused
- **THEN** the challenge status becomes `abandoned`, its end instant is the request time, and the account holds no open challenge

#### Scenario: Ending a paused challenge

- **WHEN** the owner ends a challenge whose status is `active` and which is paused
- **THEN** the challenge status becomes `abandoned`, exactly as for a challenge that is not paused

#### Scenario: Ending during a recovery offer

- **WHEN** the owner ends a challenge whose status is `recovery_pending`
- **THEN** the challenge status becomes `abandoned`, the offer is gone, and the missed task stays `missed`

#### Scenario: A new challenge after ending

- **WHEN** the owner has ended their challenge and then creates a new one
- **THEN** the new challenge is accepted and no `active_challenge_exists` refusal is returned

### Requirement: Ending is refused for a challenge that is already over

The system SHALL refuse to end a challenge whose status is `succeeded`, `failed`, `expired`, or `abandoned`, with the error `challenge_not_active`, and SHALL change nothing.
The system SHALL answer `not_found` for a challenge identifier that names no challenge or names another account's challenge.

#### Scenario: Challenge already over

- **WHEN** the owner tries to end a challenge that has already reached a terminal status
- **THEN** the request is refused with `challenge_not_active` and the challenge is unchanged

#### Scenario: Someone else's challenge

- **WHEN** a user tries to end a challenge that belongs to a different account
- **THEN** the request is answered `not_found`

### Requirement: Ending settles like a failure

Ending a funded challenge SHALL forfeit the full deposit, collected by the same settlement path a failure uses and due immediately.
Ending SHALL NOT offer the Emergency Recovery and SHALL NOT consume it; an unspent Emergency Recovery stays with the account, including one that was standing on this challenge's open offer.
Ending SHALL be the event that stops the deposit hold being renewed.
Exactly one capture SHALL be collectable for the ending, however many recovery offers the challenge went through before it.
Ending a zero-deposit challenge SHALL charge nothing.
The ended challenge's reported deposit outcome SHALL be `charged` for a funded challenge and `none` for a zero-deposit one.

#### Scenario: Funded challenge with a live hold

- **WHEN** the owner ends a funded challenge whose deposit is secured
- **THEN** a capture of the full deposit becomes due at the ending instant, and the next settlement pass collects it

#### Scenario: Funded challenge whose hold renewal failed

- **WHEN** the owner ends a funded challenge whose deposit is not secured
- **THEN** the full deposit is still due, and is collected by charging the saved payment method as a failure would be

#### Scenario: Recovery allowance still held

- **WHEN** the owner ends a funded challenge while the account still holds its Emergency Recovery
- **THEN** no recovery offer is opened, the deposit is due immediately, and the account still holds its Emergency Recovery afterward

#### Scenario: Ending during a recovery offer charges now and keeps the allowance

- **WHEN** the owner ends a funded challenge in `recovery_pending`, whose capture was waiting for the offer window to close
- **THEN** that same capture becomes due at the ending instant, no second capture is created, and the account still holds its Emergency Recovery

#### Scenario: Ending after an accepted recovery

- **WHEN** the owner ends a funded challenge that earlier spent the account's Emergency Recovery, so its first capture was cancelled
- **THEN** a new capture of the full deposit becomes due at the ending instant and the settlement pass collects it

#### Scenario: The hold is no longer renewed

- **WHEN** the owner ends a funded challenge whose live hold would be due for renewal before the capture executes
- **THEN** the renewal pass does not renew that hold, and the capture acts on it or on the saved payment method

#### Scenario: Zero-deposit challenge

- **WHEN** the owner ends a challenge whose deposit is zero
- **THEN** no settlement is created and the ended challenge reports deposit outcome `none`

### Requirement: Ending is idempotent

The end request SHALL require an idempotency key.
A repeated request with the same key SHALL return the first response and SHALL NOT create a second settlement.

#### Scenario: Retried request after a lost response

- **WHEN** the app repeats an end request with the idempotency key of one that already succeeded
- **THEN** the same response is returned and exactly one capture exists for the challenge

### Requirement: Ending races resolve to one outcome

When ending competes with a completion or with the deadline sweep, exactly one of them SHALL decide the challenge's outcome, and the loser SHALL be refused rather than applied on top.

#### Scenario: Last completion commits first

- **WHEN** a completion that meets the required count commits before the end request is processed
- **THEN** the challenge is `succeeded` and the end request is refused with `challenge_not_active`

#### Scenario: Sweep fails the challenge first

- **WHEN** the sweep marks a task missed and moves the challenge to `failed` before the end request is processed
- **THEN** the end request is refused with `challenge_not_active` and the failure's capture stands

#### Scenario: Sweep opens a recovery offer first

- **WHEN** the sweep moves the challenge to `recovery_pending` before the end request is processed
- **THEN** the end request succeeds, and the offer's pending capture becomes due at the ending instant

#### Scenario: Recovery accepted and ending race

- **WHEN** an accept-recovery request and an end request for the same `recovery_pending` challenge are processed concurrently
- **THEN** either recovery commits first and the end then ends the resumed `active` challenge, or the end commits first and recovery is refused with `recovery_not_offered` without consuming the allowance

#### Scenario: Completion after ending

- **WHEN** a completion for one of the challenge's tasks arrives after the challenge was ended
- **THEN** the completion is refused with `challenge_not_active`

### Requirement: The app confirms before ending and reports the result

The app SHALL offer ending as "End challenge" on the challenge page while the challenge is `active`, paused or not, or `recovery_pending`.
The app SHALL require a second, explicit confirmation before sending the request.
For a funded challenge the confirmation SHALL name the deposit amount that will be charged, state that it is charged now, and state that it cannot be undone.
For a zero-deposit challenge the confirmation SHALL state that nothing is charged.
While a recovery offer stands, the confirmation SHALL state that ending gives up this offer and that the Emergency Recovery stays available for a future challenge.
After the challenge ends, home SHALL show the ended challenge with its outcome, when it ended, and what became of the deposit.

#### Scenario: Funded confirmation

- **WHEN** the user presses "End challenge" on a challenge with a $50.00 deposit
- **THEN** a confirmation names the $50.00 charge, says it happens now and cannot be undone, and no request is sent until the user confirms

#### Scenario: Backing out

- **WHEN** the user dismisses the confirmation
- **THEN** no request is sent and the challenge is unchanged

#### Scenario: Recovery offer standing in the app

- **WHEN** the user presses "End challenge" on a challenge in `recovery_pending`
- **THEN** the confirmation names the charge and says the Emergency Recovery stays with the account for a future challenge

#### Scenario: Result on home

- **WHEN** ending succeeds
- **THEN** home shows the ended-challenge card saying the user ended the challenge, the time it ended, and that the deposit was charged (or that nothing was at stake for a zero-deposit challenge)

#### Scenario: Reminders stop

- **WHEN** ending succeeds
- **THEN** the app cancels every reminder it had scheduled for the challenge
