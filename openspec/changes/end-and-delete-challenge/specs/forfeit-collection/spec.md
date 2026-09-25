## Purpose

Guarantees that every outcome which forfeits a funded challenge's deposit produces a capture the settlement pass will collect, so no forfeit is silently dropped.

## ADDED Requirements

### Requirement: Every forfeit creates a collectable capture

When a funded challenge reaches `failed` or `abandoned`, the system SHALL hold exactly one capture for that outcome that is pending or already settled.
A capture cancelled by an earlier accepted Emergency Recovery SHALL NOT prevent the capture for a later forfeit.

#### Scenario: Miss after an accepted recovery

- **WHEN** a funded challenge misses a task, the owner accepts the Emergency Recovery, and the challenge later misses another task
- **THEN** the challenge becomes `failed`, a capture of the full deposit is pending and due at that miss, and the next settlement pass collects it

#### Scenario: Ending after an accepted recovery

- **WHEN** a funded challenge that spent the Emergency Recovery is ended by its owner
- **THEN** a capture of the full deposit is pending and due at the ending instant

### Requirement: A forfeit is created once

Repeated sweeps and replayed commands SHALL NOT create a second capture for the same forfeit.

#### Scenario: Sweep runs twice over the same miss

- **WHEN** the sweep runs again after it has already failed a challenge for a miss
- **THEN** no additional capture is created for that challenge

### Requirement: Existing capture records keep working

Captures created before this change SHALL still be selected, executed, cancelled, and reported exactly as before.

#### Scenario: Pending capture from before the change

- **WHEN** a capture created before this change is pending when the new server version first runs the settlement pass
- **THEN** it executes at its original due instant exactly as it would have before
