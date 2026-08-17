# BetterWakeUp phased implementation plan

## How to read this

Each numbered entry is one issue: a unit of work with its own branch, review, and
acceptance boundary. An issue lists what it depends on, what it changes, and what
proves it done.

Issue 0 collected every decision the product and architecture documents left open,
plus the places where the two disagreed. It is now resolved, and both documents
were updated to match. Nothing is blocking.

Phases group issues that can proceed in parallel once their dependencies land.
Phase boundaries are dependency boundaries, not calendar boundaries.

---

## Issue 0: decisions (resolved)

**Outcome.** `product.md` and `architecture.md` were rewritten wherever a decision
changed a rule. The toolchain is under "Toolchain" in `architecture.md`, and the
positions that were reversed along the way are under "Positions that changed",
so they are not proposed again.

Resolved: steps rather than distance as the movement metric; foreground-only
observations; pause as a challenge mode rather than a per-task action; deposits
authorized on funding and captured only on failure; a 365-day maximum challenge
duration; PostgreSQL
rate limiting; development builds instead of Expo Go; constraint triggers for the
two aggregate invariants; and a webhook-activated funding flow with no separate
schedule preview.

Also resolved: a forfeit is platform revenue in full, with the donation made by
the platform outside the system and no charity recipient modelled anywhere;
Emergency Recovery is offered at the miss and consumed on acceptance,
with a 24-hour offer window; one active challenge per account; no draft challenge
resource; a 180-second idempotency lease; and zero deposit challenges as a
first-class mode. A general server outage policy is deferred.

Nothing is blocking.

---

## Phase 1: ground truth and foundations

### 1. Repository skeleton and toolchain
**Depends on:** nothing.
Create `app/`, `server/`, `infra/`, and `packages/contract/` per the architecture's
layout, with the chosen package manager, TypeScript configs, lint, format, and test
runners wired.
**Done when:** a no-op test and a lint run pass from the repository root in one
command.

### 2. Continuous integration
**Depends on:** 1.
Lint, typecheck, unit tests, and the conventional-commit subject check the
contributing guide already anticipates.
**Done when:** CI runs on pull requests and blocks merge on failure.

### 3. Step accuracy spike
**Depends on:** nothing.
A throwaway Expo build that records `expo-sensors` step counts on physical iOS and
Android devices: foreground accuracy against a manual count, indoor use, behavior
after reboot, behavior with the phone in a pocket versus a hand, and behavior on
permission denial.
**Done when:** `docs/movement-findings.md` states the step counts each platform
reliably produces, and names a defensible default step target. This closes release
gate 1.

The availability question is already answered. Expo reports steps only, and Android
has no historical query, so this issue measures accuracy rather than deciding the
contract.

### 4. Shared contract package
**Depends on:** 1.
Request and response schemas for every endpoint, the `MovementObservation` type,
error codes, and the idempotency header. The mobile app imports this package and
never a server database model.
**Done when:** client types are generated from the schemas and the generation is
checked in CI.

---

## Phase 2: data model

### 5. Database harness
**Depends on:** 1.
Drizzle setup, the Neon serverless WebSocket `Pool`, migration commands, and a
Testcontainers PostgreSQL fixture with per-test isolation.
**Done when:** an integration test opens a transaction, executes
`FOR UPDATE SKIP LOCKED`, and rolls back.

### 6. Identity schema
**Depends on:** 5.
Accounts, external provider identities keyed on issuer plus `sub`, sessions, and
the lifetime recovery flag. Email is stored as a display attribute only, never as
a key.
**Done when:** a uniqueness test proves two providers can map to distinct accounts
and that the same provider identity cannot be inserted twice.

### 7. Challenge and task schema
**Depends on:** 5.
Challenges, weekly schedule, pause mode with the instant it began, policy version,
and materialized scheduled tasks with UTC instants for date, deadline, and pause
cutoff, plus the task and challenge state machines including `expired`.
**Done when:** each terminal-state and single-outcome invariant is enforced by a
unique index or check constraint, one active challenge per account is enforced by a
partial unique index, the task-count constraint trigger is deferred and scoped to
`active` challenges, and a test proves the database rejects a direct violating
write.

### 8. Ledger, payment command, and idempotency schema
**Depends on:** 7.
Append-only balanced ledger entries, payment commands with `execute_after` and
explicit pending, cancelled, confirmed, and failed states, provider event
deduplication, and the idempotency key table with status and request hash.
**Done when:** the balance-to-zero trigger rejects an unbalanced entry set.

### 9. Invariant assault suite
**Depends on:** 7, 8.
Tests that attempt every listed invariant violation through raw SQL, bypassing all
application code.
**Done when:** every invariant under "Challenge state" has a passing negative
test.

---

## Phase 3: server platform

### 10. Lambda and Hono skeleton
**Depends on:** 1, 5.
The handler that discriminates scheduled events from HTTP events before anything
else, structured JSON logging with the fields listed under Observability, and a
single error model with classification codes.
**Done when:** a synthetic scheduled event never reaches Hono, and no log line
contains a token, raw health data, or a payment credential.

### 11. Validation boundary
**Depends on:** 4, 10.
Every route validates against the contract schemas at the edge.
**Done when:** an unknown field, a missing field, and a wrong type each produce the
documented error shape.

### 12. Idempotency service
**Depends on:** 8, 11.
The three-step sequence from the architecture, including the concurrent case, the
lease takeover, and rejection on a mismatched request hash. The lease is 180
seconds.
**Done when:** a test fires the same key from two connections simultaneously and
exactly one performs the domain change.

### 13. Authentication and sessions
**Depends on:** 6, 11.
JWKS verification of Apple and Google ID tokens checking signature, issuer,
audience, and expiry, mapping to an internal account, and issuing a signed session.
**Done when:** expired, wrong-audience, and wrong-issuer tokens are rejected, and
an Apple private relay address never reaches an identity column.

### 14. Session middleware and ownership checks
**Depends on:** 13.
Every command verifies the session and that the account owns the addressed
challenge or task.
**Done when:** a cross-account request for a valid task ID returns not found rather
than forbidden.

### 15. Rate limiting
**Depends on:** 14.
Database-backed limits on the session, completion, pause, and payment paths, plus
reserved concurrency on the Lambda as a cost ceiling.
**Done when:** limits hold across two concurrent Lambda instances in an
integration test.

### 16. Account deletion
**Depends on:** 14, 7.
Deletion is refused while a funded challenge is unsettled, with a message that says
why, and otherwise removes or anonymizes per a stated retention rule for financial
records.
**Done when:** both deletion branches are tested. This closes release gate 8.

---

## Phase 4: challenge domain

### 17. Time and schedule engine
**Depends on:** 7.
A pure module over a deterministic clock: derive task dates from a weekly schedule
and required count, compute deadlines and pause cutoffs, and project an end date.
**Done when:** table-driven tests cover inactive days, DST forward and backward
transitions, and cutoff boundaries on both sides.

### 18. Projection and zero deposit challenges
**Depends on:** 17, 12, 14.
`POST /challenges/projections`, which persists nothing and returns the projected
end date and whether the 365-day maximum duration rule is satisfied. `POST /challenges`, which creates
and materializes a zero deposit challenge in one transaction and rejects any
non-zero deposit. Plus `GET /challenges/current`.
**Done when:** the projection equals the schedule later materialized from the same
configuration, a funded configuration exceeding 365 days is rejected while a zero
deposit one is not, a deposit between zero and one dollar is rejected, and nothing
is written to the database by a projection call.

**This is the seam worth exploiting.** With zero deposit challenges landing here,
issues 20 through 24 and the whole mobile completion path can be built, tested, and
dogfooded before any payment code exists. Only settlement genuinely needs money.

### 19. Fake payment provider and funding
**Depends on:** 8, 18.
The narrow provider interface from the architecture, a fake implementation,
`POST /challenges/funding-intents` carrying the whole configuration, and a webhook
handler that, on a successful authorization, creates the challenge and materializes
the full schedule in one transaction. Nothing is captured.
**Done when:** funding intents are idempotent, a client callback alone never
activates a challenge, an account with an active challenge cannot fund a second, no
capture occurs anywhere in the flow, and the task-count invariant holds immediately
after activation.

### 20. Completions
**Depends on:** 19, 12, 3.
`POST /tasks/:taskId/completions`. Accept when received no later than the deadline
plus the sixty-second receipt grace and the reported local timestamp falls inside
the window at or before the deadline. Reject any observation whose `provenance` is
not `live-foreground`.
**Done when:** tests cover both sides of the grace boundary and a duplicate key
returns the stored result.

### 21. Pause mode
**Depends on:** 19, 17.
`POST` and `DELETE /challenges/:id/pause`. Setting the mode skips every subsequent
task until the user resumes, with no limit and no expiry. Each skip happens as its
own pause cutoff passes, appending one replacement `scheduled` task in the same
transaction.
**Done when:** entering and leaving pause both bind at the cutoff boundary, a pause
spanning many task windows leaves the task-count invariant intact after every skip,
and no code path resumes a challenge without an explicit request.

### 22. Time zone change
**Depends on:** 21, 17.
Re-materialize only tasks whose stored pause cutoff is strictly later than the
receipt instant.
**Done when:** a task with a passed cutoff and a future deadline is provably
untouched.

### 23. Overdue sweep
**Depends on:** 20, 21, 8.
The eight-step pass from the architecture, with pause-cutoff processing running
before overdue evaluation, skipping tasks whose completion key is still unresolved
inside their receipt window, batched with `FOR UPDATE SKIP LOCKED`,
creating settlement commands rather than moving funds. Also moves any challenge
paused for 365 days to `expired`.
**Done when:** running the sweep twice yields the same state as running it once,
two concurrent invocations take disjoint work, a task whose completion attempt
crashed mid-transaction survives the sweep until its retry resolves, and a
year-long pause expires exactly once for funded and zero deposit challenges alike.

### 24. Emergency Recovery
**Depends on:** 23.
The 24-hour offer on funded challenges only, and the single commit that consumes the lifetime recovery, forgives the missed task,
appends a replacement scheduled task, cancels the pending settlement, and returns
the challenge to `active`.
**Done when:** recovery arriving just before the settlement instant succeeds, just
after is refused, a second lifetime attempt is refused on that challenge or a later
one, and a failed zero deposit challenge neither offers nor consumes it.

### 24a. Authorization renewal
**Depends on:** 19, 23.
Renewal driven by each authorization's own `capture_before` rather than a fixed
cadence, firing at roughly half the remaining window. Authorize the replacement
before cancelling the old one. A failed renewal marks the deposit unsecured,
notifies the user, and retries, with `POST /challenges/:id/payment-method` to
recover. Card account updater enabled.
**Done when:** a challenge outliving several renewals stays secured, a forced
renewal decline leaves the challenge running and the user informed, renewal
continues through `recovery_pending`, and no renewal path can ever capture.

**A failed renewal must never fail a challenge.** Assert that directly, not as a
consequence of other logic.

### 25. Settlement execution and webhooks
**Depends on:** 23, 19.
Execute due, uncancelled settlement commands. Release the authorization on success
and on expiry, so nothing is ever charged in either case. On failure capture the live authorization, or charge the
saved payment method off-session when none is live, and record the forfeit as
platform revenue in full. Handle verified provider
webhooks with event-ID deduplication. Collection is a retried command with a
terminal state that alarms, not a call that either works or throws.
**Done when:** a successful challenge incurs no processing fee at all, ledger
entries balance on a forfeit, a replayed webhook is a no-op, and an uncollectable
forfeit is recorded as uncollected rather than lost.

### 26. Concurrency suite
**Depends on:** 20, 23, 24, 25.
Completion racing the sweep, recovery racing settlement, and duplicate keyed
commands under load.
**Done when:** every run leaves the database satisfying every invariant. This
closes release gate 7.

---

## Phase 5: mobile application

### 27. App skeleton and API client
**Depends on:** 4, 1.
Expo Router, TypeScript, the generated contract client, secure storage for session
material, and an EAS development build profile.
**Done when:** the app builds on both platforms and reaches an unauthenticated
screen.

### 28. Sign-in
**Depends on:** 27, 13.
Apple and Google native sign-in, session exchange, and secure persistence.
**Done when:** sign-in, sign-out, and session expiry are exercised on a device.

### 29. Movement capture
**Depends on:** 27, 3.
The pedometer wrapper that normalizes every `watchStepCount` reading into
`MovementObservation` with correct `provenance` and `source`, plus permission
request and revocation handling.
**Done when:** provenance is never inferred and never defaulted, and a backgrounded
app records no movement.

### 30. Pending completion store
**Depends on:** 29, 20.
SQLite records holding the idempotency key, IDs, local timestamp, observation, app
and policy versions, and sync status. Independent per-record retry on open,
reconnect, and completion. Acknowledged records are removed, rejected records are
retained and surfaced, everything else stays pending.
**Done when:** killing the app between local completion and acknowledgment still
results in a synced completion on next launch.

### 31. Challenge creation and disclosure
**Depends on:** 28, 18.
Parameter entry held in memory with nothing persisted, time zone confirmation,
projected end date, the maximum duration rule when a funded
configuration exceeds it, the zero deposit path, and every disclosure item listed
in `product.md`.
**Done when:** the deposit action is unreachable until disclosures are
acknowledged, and a zero deposit challenge can be created and run without any
payment step.

### 32. Daily completion screen
**Depends on:** 30.
The two checks shown separately, the four-state progression from the architecture,
and a warning when a deadline is near with sync still pending.
**Done when:** a locally complete but unsynced task never renders as complete.

### 33. Pause, recovery, and deletion screens
**Depends on:** 21, 24, 16.
Pause names the next task it will skip before confirmation, makes it obvious while
paused that the challenge is not running, and warns as a pause approaches a year,
stating what will happen rather than pressing the user to act. Recovery states that
it is permanent.
**Done when:** each irreversible action requires explicit confirmation, and a
paused challenge is never presented as if it were running.

### 34. Crash and sync reporting
**Depends on:** 30.
Sentry for crashes and synchronization failures, with no health or session data in
any payload.
**Done when:** a forced rejected completion appears in Sentry with no sensitive
fields.

---

## Phase 6: infrastructure

### 35. CDK application
**Depends on:** 10.
One Lambda with a Function URL, no VPC, in the same region as Neon.
**Done when:** a deployed function serves a health request.

### 36. Scheduler rules
**Depends on:** 35, 23.
The daily sweep plus additional ticks across the hours containing common
deadlines, for both correctness and warmth.
**Done when:** a scheduled invocation runs the sweep and never reaches an HTTP
route.

### 37. Secrets and permissions
**Depends on:** 35.
Parameter Store SecureString entries and IAM roles granting each trigger only what
it needs.
**Done when:** no secret is present in an environment variable or the repository.

### 38. Logs, alarms, and budgets
**Depends on:** 35, 36.
Explicit log retention plus every alarm listed under Observability, including
authorization renewal failures, deposits left unsecured, and uncollected forfeits.
AWS budgets and billing alarms before any real traffic.
**Done when:** each alarm has been fired once in a test.

### 39. Deploy pipeline
**Depends on:** 2, 35, 5.
Migrations run before the function deploys, with separate development and
production environments.
**Done when:** a merge to the default branch deploys development end to end.

---

## Phase 7: release gates

Each of these is a gate, not a feature. Real deposits require all of them.

### 40. Real-device test matrix
**Depends on:** 29, 30, 32.
Foreground step counting, indoor use, permission denial and revocation,
termination before acknowledgment, network loss, rejected completions, device
reboot, and the lowest supported OS versions.
**Closes gate 1.**

### 41. Backup and recovery drill
**Depends on:** 39.
Restore a Neon backup into a scratch environment and replay a sweep backlog
against it.
**Closes gate 6.**

### 42. Funds flow approval and real provider
**Depends on:** 19, 25.
Legal counsel and a processor approve the authorize-and-capture funds flow and
what happens to a forfeit after collection, then the real provider replaces the
fake one behind the same
interface, including the payment-instrument identifier used for recovery
deduplication.
**Closes gate 3.**

**Start this first.** It has the longest external lead time of anything in the
plan, and a negative answer would change the deposit model and with it the whole
payment surface.

### 42a. Long-horizon authorization proof
**Depends on:** 42, 24a.
Authorize a real card through the real processor and keep it renewed across a full
length challenge, measuring how often extended authorization is actually granted,
how often renewals decline, and whether issuers release holds early. Include a
deliberate decline and recovery from it.
**Closes gate 5.**

This is the assumption the payment design now rests on, and it cannot be verified
quickly, so start it as soon as the processor is live. Extended authorization is
best-effort, so the real renewal cadence is unknown until measured.

### 43. Policy and disclosure audit
**Depends on:** 31.
Confirm every user-facing promise matches server behavior: the receipt grace
description, the 24-hour recovery offer, the maximum duration, the automatic
resume, and the donation pledge. Confirm the pledge is stated as a platform
commitment rather than a routing of the user's money, and that the published figure
matches what is actually given. Pin the policy version recorded at funding.
**Closes gates 2 and 4.**

### 43a. App Store review package
**Depends on:** 31, 19.
Reviewer notes stating the commitment contract framing, the absence of chance and
of a pot, that a successful user is never charged at all, and that IAP cannot
express an authorization that is released rather than captured.
Confirm the app is free and fully usable at zero stake.
**Done when:** a TestFlight external review build clears without a 3.1.1, 4.2, or
5.3 objection.

Submit this before the payment work is finished, not after. A 5.3 rejection would
change the product, and guideline 5.3 is among the most strictly enforced sections.

### 44. Production readiness sign-off
**Depends on:** 40, 41, 42, 42a, 24a, 43, 43a, 26, 16.
A production Neon plan, all eight release gates checked off with linked evidence,
and store submissions.

---

## Critical path

```text
1 ─▶ 5 ─▶ 7 ─▶ 8 ─▶ 12 ─▶ 19 ─▶ 20 ─▶ 21 ─▶ 23 ─▶ 24 ─▶ 25 ─▶ 26 ─▶ 44
                    │
3 ───────────────▶ 29 ─▶ 30 ─▶ 32 ─▶ 40 ────────────────────────────▶ 44

42 ─▶ 42a ──────────────────────────────────────────────────────────▶ 44
```

Three things run outside the dependency chain and should start immediately.

Issue 3 has no code dependencies and sets the step target the product promises.

Issue 42 is legal and commercial work with the longest lead time in the plan. A
negative answer on holding user deposits changes the deposit model, so the answer
is worth having before the payment surface is built rather than after.

Issue 42a takes as long as the longest challenge does. It is the only way to prove
the renewal assumption the payment design rests on, and it cannot be compressed.
