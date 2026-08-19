# BetterWakeUp architecture

## Status

This document records the version 1 technical direction.

The chosen stack is:

- Expo React Native and TypeScript for the mobile app.
- `expo-sensors` Pedometer for movement data, with no custom native code until it is proven necessary.
- Hono on AWS Lambda for the application API, reached through a Lambda Function URL.
- Neon PostgreSQL as the authoritative data store.
- Sign in with Apple and Google, verified directly against provider JWKS.
- EventBridge Scheduler for overdue challenge evaluation.
- AWS CDK in TypeScript for infrastructure.

The first release has no website, administrative console, queue, cache, permanent worker, email delivery, or separate analytics platform.

Product rules are in `docs/product.md`. Implementation sequencing is in `docs/phased-plan.markdown`.

## Stack decisions

Choices a reader is likely to question, recorded so they are not relitigated.

**Lambda Function URL rather than API Gateway.**
Nothing here uses API Gateway's distinguishing features: rate limiting is enforced in the application, authorization is handled by the session layer, and there are no API keys or usage plans.
The Lambda free tier is not time-limited, while API Gateway's expires after twelve months.
Accepted tradeoffs: AWS WAF cannot attach to a Function URL, and a custom domain would need CloudFront in front.
Neither is a version 1 requirement.

**Neon rather than an AWS-native database.**
RDS and Aurora live in a VPC, which would force Lambda into that VPC and usually drag in a NAT gateway.
DynamoDB is always free at this scale, needs no VPC, and its conditional writes would genuinely enforce most of the invariants under "Challenge state."
It was still rejected on two grounds.
Conditional expressions live in calling code, so an invariant protects only the paths that remember to declare it, whereas a PostgreSQL constraint is declared once and holds for every present and future write path.
And the remaining invariants, the required completion count and a balanced ledger, are aggregates across many records, which DynamoDB cannot check at all.
For a system carrying financial obligations, moving integrity out of the database and into application code is the wrong direction.

**Zero deposit challenges are part of the design, not a free tier bolted on.**
They also carry weight at App Store review.
If the challenge works at zero stake, paying is not unlocking in-app functionality, which is the substance of a guideline 3.1.1 objection, and the app is not a thin client under 4.2.
See "App Store position" for the rest of the review argument.

**No custom movement module at the start.**
`expo-sensors` wraps CMPedometer on iOS and the Android step counter, and the rule under "Movement" counts only foreground movement anyway.
A custom Swift and Kotlin module is a response to a measured gap, not a starting assumption.

**No authentication library.**
Restricting sign-in to Apple and Google removes passwords, email verification, password reset, and therefore all email infrastructure.
What remains is verifying a provider ID token against published JWKS and issuing a session, which is narrow enough that one small library beats a full framework.

## Toolchain

| Area | Decision | Reason |
|---|---|---|
| Package manager | pnpm workspaces | Four manifests exist on day one. Strict `node_modules` catches accidental cross-package imports. |
| Runtime | Node 22 LTS on Lambda | Current LTS. |
| Language | TypeScript 5.x, `strict` and `noUncheckedIndexedAccess` | |
| Test runner | Vitest for server, infra, and contract; jest-expo for the app | Expo's transform pipeline expects Jest. Two runners costs less than fighting that. |
| Integration database | Testcontainers PostgreSQL | Keeps the suite off the vendor this document wants replaceable. |
| CI | GitHub Actions, with commitlint | The contributing guide already assumes GitHub. |
| Lint and format | Biome, repo-wide, replacing the Expo ESLint template | One config, one binary, no plugin drift. |
| Validation | Zod | Contract schemas are the single source; client types are inferred from them. |
| Date and time zone | Luxon on the server; `Intl` only in the app | Only the server does IANA arithmetic. The app renders instants the server computed. |
| Token verification | `jose` | Narrow enough that a full authentication framework is not warranted. |
| Database access | Drizzle and Drizzle Kit over the Neon serverless WebSocket `Pool` | The HTTP driver cannot express the transactions this design needs. |
| Money | Integer minor units with an ISO currency column; USD only in version 1 | The column costs nothing now and avoids a migration later. |
| Server logs | Pino JSON | |
| Mobile error reporting | Sentry | |

## Positions that changed

Held once, then reversed. Recorded so they are not proposed again.

**Distance target became a step target.**
Expo's pedometer reports steps and nothing else on either platform, and the `CMPedometer` distance underneath it is steps multiplied by an uncalibrated stride estimate, which a clinical comparison found unreliable where step counting was not.

**Historical movement became foreground-only.**
Not a product choice. Android has no historical step query at all, so foreground is the only guarantee both platforms can make.

**Per-task pause became a pause mode.**
Pauses exist for illness and travel, where the user does not know in advance how many days they need. An action per day would fail exactly the people the feature is for.

**Capture-on-funding became authorize-on-funding.**
Processing fees attach to capture, so an authorization that is released costs nothing.
The old model burned about 4% of every successful deposit permanently, because processors stopped returning fees on refunds in 2020.
It also removed the custody question, the refund window, and any need for special handling during `recovery_pending`.

**The 150-day cap became 365 days.**
The old cap existed only to keep a refund inside the card network's 180-day window. With nothing to refund, only accumulated renewal risk remains, and a year bounds that.

**A user-directed charity share became a platform pledge.**
Routing a user's money to a third party is what attracts money transmitter licensing and what App Store guideline 3.2.2(iv) forbids an app to collect for.
It also broke arithmetically: a fixed 20% share can be smaller than a fixed fee, so a $1 forfeit yielded 20 cents against a 33-cent fee.
Keeping the forfeit as revenue and donating separately removed all three problems.

**Draft challenges were dropped entirely.**
Setup is one sitting in client memory. The configuration stored against a payment intent is not a draft; the webhook has to know what was authorized, and the amount has to be tied to the accepted terms.

**Expo Go was dropped before it was ever used.**
A Sign in with Apple token issued inside Expo Go carries Expo's bundle identifier in `aud`, so our audience check would reject every one.

## Design goals

The architecture must:

1. Let the user complete and synchronize a task while the app is open.
2. Keep local completion durable until the server acknowledges it.
3. Give the server sole authority over challenge and financial outcomes.
4. Make every completion and payment command safe to retry.
5. Resolve challenges even when a user never opens the app again.
6. Keep infrastructure inexpensive at low traffic.
7. Preserve a practical path away from any individual provider.

## System overview

```text
┌───────────────────────────────────────────────┐
│ Expo React Native app                         │
│                                               │
│  expo-sensors pedometer                       │
│             │                                 │
│             ▼                                 │
│  Local task evaluation                        │
│             │                                 │
│             ▼                                 │
│  SQLite pending completion store              │
└─────────────┬─────────────────────────────────┘
              │ HTTPS and idempotency key
              ▼
┌───────────────────────────────────────────────┐
│ Lambda Function URL                           │
└─────────────┬─────────────────────────────────┘
              ▼
┌───────────────────────────────────────────────┐
│ Lambda handler                                │
│                                               │
│  HTTP event      ──▶ Hono application         │
│  Scheduled event ──▶ Overdue sweep            │
└─────────────┬─────────────────────────────────┘
              ▼
┌───────────────────────────────────────────────┐
│ Neon PostgreSQL                               │
└───────────────────────────────────────────────┘

EventBridge Scheduler ───────▶ Lambda (scheduled event)
Payment provider       ◀────▶ Lambda (HTTP event)
```

## Ownership boundaries

### Mobile app

The mobile app owns:

- Displaying challenge state received from the server.
- Reading movement data through the pedometer API.
- Evaluating and recording the local completion check.
- Persisting unsynchronized completions in SQLite.
- Retrying pending completions while the app is open.
- Displaying local and server checks separately.

The mobile app does not own:

- The authoritative deadline.
- The authoritative challenge state.
- Pause eligibility.
- Emergency Recovery consumption.
- Deposit release or forfeiture.
- Financial ledger entries.

### Application API

The API owns all authoritative commands and queries, using the server clock and the challenge's stored time zone and schedule.

It is a modular monolith.
Challenge, completion, pause, recovery, identity, and payment behavior remain modules in one deployable Lambda application.
They may use separate source directories, but they do not begin as separate services.

### PostgreSQL

PostgreSQL is the source of truth for identity, challenge, task, and financial state.

The mobile app never connects directly to Neon; every client operation passes through the API.
Database constraints and transactions protect invariants even when a request is retried or two requests arrive concurrently.

## Mobile application

### Framework

Use Expo React Native with TypeScript and Expo Router.

Use an EAS development build from the first authentication work, not Expo Go.

Expo Go is one published application with one Apple bundle identifier, Expo's own.
A Sign in with Apple identity token obtained inside it carries that bundle identifier in its `aud` claim, so the API's audience check would reject every token the sandbox produces.
A development build is the same Expo application compiled under our own identifier and entitlements.
Nothing about the framework changes.

Start with React hooks and context for local interface state.
Add a client state library only when an observed state-sharing problem requires one.

### Appearance

`app/src/ui/theme.ts` owns every colour, spacing step, corner radius and text size in the app, as a light theme and a dark one of the same shape.
`app/src/ui/components.tsx` owns how the recurring pieces are drawn: the screen frame, cards, buttons, banners, progress bars, labelled rows, and the status pill that names the state a challenge is in, and the form controls a screen collects a configuration with - a labelled field, a selectable chip, a statement toggle.

A screen names a role - `textMuted`, a `danger` banner, a `primary` button - and never a hex code or a font size.
That is what lets the app follow the device between light and dark without a single screen asking which one is in force, and it is why a change to the look of a button is one edit rather than nine.

`useTheme` reads the device setting, which `app.json` already declares the app honours with `userInterfaceStyle: automatic`.

`app/src/ui/format.ts` owns how instants and dates are read out loud, so no screen prints an ISO string at a person.
A deadline is only true in the challenge's own time zone, so every screen that shows one formats it there rather than in the device's zone, and falls back to the raw instant when the runtime has no zone data.

### The end of a challenge

`GET /challenges/current` answers null in `challenge` for every terminal challenge: "current" is the challenge holding the account's slot, and a challenge that ended holds nothing and offers nothing to act on.

A challenge can end two ways, and the app hears about them differently.

**The user finishes it.**
The completion that ends a challenge says so in its own response, in `challengeStatus`, so the daily task screen says the challenge is over on the acknowledgment that ended it and hands that finish up to home, which shows it without waiting for another read.

**The server decides it.**
A failure and an expiry are decided by the sweep, which the app is never told about, so there is no response to carry them.
`GET /challenges/current` therefore answers with `lastEnded` beside the null challenge: the outcome, the days that were done, the deposit, and what became of it.
It is one summary of the account's most recent terminal challenge, not a history, and it is null while a challenge is running, because a running challenge is the whole answer.

`depositOutcome` is stated by the server rather than derived by the app from a status.
Only a failure forfeits a deposit: a challenge that succeeded, and one that expired after a year of pause, both release the hold uncharged, and that rule belongs beside the settlement that carries it out.

Home draws both the same way, so a month that ended reads as a month that ended however the app came to hear about it.
Without this, a challenge that failed would read as an account that never held one, and a charged deposit would be something the user found out from their card statement.

### Reminders

The product asks the user to be at their phone before a wall-clock time with money riding on it, so a device that never makes a sound is the quietest way to lose a deposit.
`app/src/reminders/reminders.ts` owns what should be scheduled, and `native-notifier.ts` is the only module that imports `expo-notifications`, the same way `native-pedometer.ts` is the only one that imports `expo-sensors`.

Everything is a local notification.
A reminder is a fact the device already holds - the deadline arrived on the last read of the challenge - so it needs no push token and no network at the moment it fires, which is the moment a phone on a bedside table is least likely to have one.

What is scheduled comes from instants the server sent, never from the weekly schedule.
A challenge carries one open task at a time, so the app reminds about that task and asks again on the next read.
Two per task: the alarm 45 minutes before the deadline, which is time enough to get up and walk, and a last call 10 minutes before it for a morning already going wrong.
A recovery offer gets one an hour before it lapses, because that one is about the deposit rather than about walking.

The set is replaced whole on every read rather than added to, and each reminder's identifier is derived from the task it belongs to.
That is what makes a task that has since been completed, skipped or paused away take its reminders with it instead of firing at someone who has nothing to do.

A read that is still in flight, or one that failed, schedules nothing at all - it is `undefined` rather than `null` to the hook that does the scheduling.
An answer of "this account holds no challenge" clears the device; a momentary network failure must not.

Permission is requested from a press and never on launch.
iOS gives an app one prompt for the lifetime of an install, and spending it in front of a user who has not yet seen what the app is for is how an app ends up permanently unable to remind anyone of anything.
Home therefore offers the switch by naming the time the nudge would arrive rather than the feature, and says where to turn notifications back on for a device that has already refused.

### The payment sheet

A funded challenge is authorized on the device, not on the server.
`POST /challenges/funding-intents` answers with `providerClientSecret` precisely because the hold is completed at the provider's own sheet, in front of the user, and confirmed back to us by a webhook.

`app/src/payments/payment-sheet.ts` is the app's half of that: a port with `present(request)` and four answers - authorized, cancelled, unavailable, failed.
It exists for the same reason the notifier's and the pedometer's ports do.
The provider's SDK only runs on a device, while what the screen does with each answer is exactly what is worth testing without one.

The sheet reports that the user completed the authorization and nothing more.
Whether a hold exists is the server's answer, read from `GET /challenges/current` after the webhook lands, so the wait for the bank starts only once a card has actually been given.

There is no processor yet, so `createConfiguredPaymentSheet` answers `unavailable` and the setup screen offers the same challenge with the deposit dropped.
It is deliberately not a stub that claims success: a sheet that lied would leave the user waiting for a bank nobody had asked anything of, while believing they had paid.
Replacing it with a real provider's sheet is a new implementation of that one function.

### Movement

Use the `expo-sensors` Pedometer, which wraps CMPedometer on iOS and the step counter on Android.

Two documented properties of that module decide the movement rule, so they are recorded here rather than left to a spike.

**The module reports steps only.**
`PedometerResult` carries a step count and nothing else, on both platforms.
Distance is not available through Expo at all.
On iOS, `CMPedometer` does expose a `distance` value underneath, but it is nil on some devices and is computed as steps multiplied by an estimated stride length, uncorrected for the individual.
It is a less reliable derivative of the number already in hand, so version 1 expresses the target in steps.

**Historical queries are iOS only.**
`getStepCountAsync` is unsupported on Android; only `watchStepCount` works there, and it delivers nothing while the app is backgrounded.
iOS serves at most seven days of history.

Version 1 therefore counts only observations with `provenance` of `live-foreground`, on both platforms, because that is the only guarantee Android can make.
This is a documented platform limit, not a pending finding.

A custom native module would not change it.
The operating system cannot return motion history it never retained, so a custom module is justified only if the packaged pedometer proves inaccurate or unavailable on supported devices.

Normalize every reading into one contract before it reaches the rest of the app:

```ts
interface MovementObservation {
  startedAt: string;
  endedAt: string;
  steps: number;
  provenance: "live-foreground" | "historical-query";
  source: "expo-pedometer-ios" | "expo-pedometer-android";
}
```

`provenance` is required, not decorative.
The server cannot audit a completion or enforce the foreground-only rule if it cannot distinguish movement observed while the app was open from movement backfilled out of the operating system's history.
The API rejects any observation whose `provenance` is not `live-foreground` while that rule stands.

### Pending completion store

The app writes a pending completion to SQLite before displaying the local check.
Each record contains at least:

- A generated record ID used as the idempotency key.
- Challenge and scheduled task IDs.
- The local completion timestamp.
- The normalized movement observation.
- The app version and verification policy version.
- Synchronization status.

When the app opens, reconnects, or records a completion, it attempts every pending record.

Records are retried independently rather than as an ordered queue.
Ordering buys nothing here, because at most a small number of records can be pending inside one task window, and a strict queue would let a single undeliverable record block every later completion from ever syncing.

Each record ends in one of two states:

- **Acknowledged.** The API returned a stored or fresh success. The record is removed.
- **Rejected.** The API returned a non-retryable error, such as a task already resolved or a payload the current server rejects. The record is retained, marked rejected, and surfaced in the interface. It is never retried silently.

Every other outcome, including network failure and any 5xx, remains pending and is retried.

The interface exposes these states:

```text
Task incomplete
    │
    ▼
Completed locally, synchronization pending
    │
    ├──────────▶ Acknowledged by server
    │
    └──────────▶ Rejected, action required
```

Mobile background execution is not part of correctness.

## Authentication

Version 1 supports Sign in with Apple and Google Sign-In only.
There are no passwords, no email verification, and no transactional email of any kind.

The app obtains a provider ID token natively and posts it to the API.
The API verifies the token against the provider's published JWKS, checking signature, issuer, audience, and expiry, then takes the provider `sub` as the stable external identifier.
Use one small JOSE library for verification rather than an authentication framework.

The API maps each external identifier to an internal BetterWakeUp account ID and issues its own signed session token.
Domain tables reference only the internal account ID, so the sign-in method can change without rewriting challenge and ledger history.

The app stores session material in operating system secure storage.

Three provider-specific requirements must be handled explicitly:

- Sign in with Apple may return a private relay address. Never treat an email address as an identifier or a deduplication key.
- The App Store requires in-app account deletion for apps offering account creation. An account with an active funded challenge cannot be deleted until that challenge settles, and the deletion flow must say so.
- Social sign-in does not prevent a user creating a second provider account to obtain a second lifetime Emergency Recovery. The payment instrument is the practical deduplication key, and the payment provider integration must supply it.

## API

### Runtime

Run one Hono application on the current AWS Lambda Node.js LTS runtime.
A Lambda Function URL is the public entry point.

The Lambda handler receives two kinds of event and must discriminate between them before doing anything else:

```ts
export const handler = async (event: unknown) => {
  if (isScheduledEvent(event)) return runSweep(event);
  return honoAdapter(event);
};
```

Scheduled invocations never pass through Hono and have no route, so the sweep has no HTTP surface to protect.

Use standard Web APIs where possible so the application can later run in a Node container or another compatible runtime.

### Endpoints

The exact contract belongs in an API specification.
The initial API needs operations equivalent to:

```text
POST   /sessions                              exchange a provider ID token
DELETE /sessions                              sign out
DELETE /accounts                              App Store deletion requirement
POST   /challenges/projections                   validate a configuration
POST   /challenges                               start a zero deposit challenge
POST   /challenges/funding-intents               authorize a deposit
POST   /challenges/:challengeId/payment-method   replace a card after a failed renewal
GET    /challenges/current
POST   /challenges/:challengeId/time-zone
POST   /challenges/:challengeId/pause            enter pause mode
DELETE /challenges/:challengeId/pause            resume
POST   /challenges/:challengeId/recovery
POST   /tasks/:taskId/completions
POST   /payments/webhooks/:provider
```

Pause is a challenge-level mode, so it is addressed on the challenge rather than on a task.

There is no draft challenge resource.
Setup is a single sitting held in client memory, and abandoning it leaves nothing behind.

`POST /challenges/projections` persists nothing.
It validates a configuration and returns the projected end date and whether the maximum duration rule is satisfied.
It exists because the disclosure screen must show the same end date the server will materialize, and duplicating the schedule engine in the app would guarantee the two eventually disagree.

`POST /challenges/funding-intents` carries the whole configuration and is idempotent, so a repeated tap cannot produce two authorizations.
The configuration is stored against the payment intent, not as a user-visible draft.
The webhook has to know what was authorized, and the amount at stake must be tied to the exact terms the user accepted.

A zero deposit challenge never reaches the payment provider at all.
It is the absence of a charge rather than a charge of zero: no authorization, no saved card, no renewal, no settlement command.
So `POST /challenges` creates and materializes it in one transaction, and rejects any non-zero deposit.
That keeps a single rule holding: money never activates a challenge from the client.

The branch belongs at the provider boundary and nowhere else. Every other part of the domain treats a zero deposit challenge identically.

A funded challenge becomes active on the payment provider's webhook confirming the authorization succeeded, never on a client callback.
No money is captured at any point in this flow.
The client's post-payment callback only triggers a poll of `GET /challenges/current`.
A client can lie about a payment or die halfway through one, so it is not permitted to be the thing that activates a funded challenge.

`app/src/challenges/funded-challenge.ts` owns that poll on the app's side: it reads `GET /challenges/current` until the challenge appears, and distinguishes a hold that has not cleared yet from a read that did not come back.
The screen shows the first as something to check again and the second as an error, because a user who has just staked money must never be left watching a screen that cannot change.

There is no sweep endpoint.
Overdue evaluation is reachable only through a scheduled Lambda invocation.

### Validation

Validate every request at the HTTP boundary.
Keep shared request and response types generated from, or checked against, the API contract rather than importing server database models into the mobile app.

### Idempotency

Every state-changing client command includes an idempotency key.

Handling must cover the concurrent case, not only the replay case.
Two devices, or a retry fired before the first response arrives, can present the same key at the same moment.

The sequence is:

1. Insert the idempotency key with status `in_progress` in its own short transaction, recording account, command type, and request hash.
2. If that insert violates the unique constraint, read the existing row.
   A `completed` row returns its stored result.
   An `in_progress` row younger than its lease returns a retry response rather than an error.
   An `in_progress` row past its lease may be taken over, because the earlier attempt did not commit.
3. Perform the domain change and mark the key `completed` with its result in one transaction.

The lease is 180 seconds.

That is longer than the sixty-second receipt grace, so a crashed attempt could otherwise block its own retry until past the point where the completion could still count.
The sweep closes that gap instead of the lease doing it.
An `in_progress` key is proof the server received the command, and the instant it was inserted is the receipt instant, so a task with an unresolved completion key inserted inside its receipt window is not marked `missed`.
The sweep leaves it for a later tick, by which time the lease has expired and the retry has resolved it either way.

This is not leniency.
The receipt rule asks whether the command arrived in time, and the key records exactly that.

Reusing a key with a different request hash is rejected.

Payment provider event IDs receive the same duplicate protection.

## Challenge time model

Store:

- The confirmed IANA time zone, such as `America/Los_Angeles`.
- The weekly schedule and deadline for each active weekday.
- The required task count.
- The No Regret duration.
- Whether the challenge is currently paused, and since when.
- The policy version accepted when the challenge was funded.

Materialize scheduled task rows with UTC instants for:

- Task date in the challenge time zone.
- Task deadline.
- Pause cutoff.

### Maximum duration

Reject a funded challenge at creation whose projected end date falls more than 365 days after funding.

The rule does not apply to a zero deposit challenge, which has no authorization to maintain.

The bound comes from accumulated renewal risk, not from the schedule.
Every authorization renewal is another opportunity for a card to decline, so a longer challenge is more likely to end up unsecured.
A year caps that exposure without imposing a technical boundary that does not exist.

Enforce it against the projected end date rather than a task count, since the weekly schedule decides how many calendar days a given number of tasks spans.

It bounds the plan, not the outcome.
Pause is unlimited, so an actual challenge can run past a year and must not be cut short for doing so.
See "Pause mode" for what that costs.

### Materialization rule

Materialize the full schedule when the challenge is funded.

Because a skipped or forgiven task consumes a task row without producing a completion, the schedule must grow to compensate.
Rather than defining a rolling horizon, hold one invariant:

> While a challenge is `active`, the number of task rows in `scheduled` or `completed` status equals the required task count.

Every transition to `skipped` or `forgiven` appends exactly one new `scheduled` task at the next eligible active weekday, inside the same transaction.
This keeps the end date correct, matches the product rule that pausing pushes the end date later, and removes any possibility of a challenge running out of tasks before reaching its required count.

The invariant is scoped to `active` deliberately.
A `missed` task drops the count below the required total by design, and it stays below until the task is forgiven or the challenge fails.

### Pause mode

Pausing sets a mode on the challenge rather than acting on one task.

While the mode is set, each task is transitioned to `skipped` as its own pause cutoff passes, appending one replacement `scheduled` task in the same transaction.
The sweep drives this, one task at a time.

A pause has no limit and no expiry.
Only an explicit resume ends it, so no code path resumes a challenge on the user's behalf and no user meets a deadline they did not choose to face.

Entering and leaving pause mode both bind at the pause cutoff boundary.
A pause set at or after a task's cutoff leaves that task live.
A resume issued at or after a task's cutoff takes effect on the following task, so a user is never dropped into a window they can no longer plan around.

A pause is bounded only by the year after which the challenge becomes `expired`.
That bound exists to stop authorization renewal running forever, not to shape behavior, so it is a year rather than a number tuned to anything.

Releasing the authorization on pause and re-authorizing on resume remains available as an optimization, since renewal buys nothing while a challenge cannot fail.
It is not required now that the exposure is bounded, and it would trade a certain cost for an uncertain one: a decline at resume time. Deferred.

### Time zone changes

A time zone change re-materializes only tasks whose stored pause cutoff is strictly later than the instant the command is received.

The boundary is deliberately stated against a stored instant rather than an informal notion of a window that has not started, because a task can have a passed pause cutoff and a future deadline, and the two readings would give that task different pause eligibility.

A time zone change never rewrites completed, missed, forgiven, skipped, or currently open task rows.

**Who asks for the change.**
The user never types a zone. The app compares the device's zone against the challenge's on every home read and offers the move when they disagree, because the user who has flown east is exactly the user who does not know their 7:00 AM deadline is now judged at 10:00 AM local.

The offer names the two times rather than the two zone identifiers, and it is only made for an `active` challenge: the server refuses to move instants under a challenge in `recovery_pending`, whose one open decision is measured from a missed task, and a paused challenge is accepted because travelling and pausing go together.

Declining is remembered for as long as the app is open, so a weekend away is not a banner on every launch, and the device is checked again on the next launch.

The move is not confirmation-gated - it gives nothing up and can be made again in either direction - but travelling east pulls the next deadline earlier and can land it in the past, which the sweep will treat as missed, so the app says so before the press.

### Deadlines and the receipt grace

The server clock decides whether acknowledgment and pause commands arrive in time.

A completion is accepted when it is received no later than the task deadline plus a fixed sixty-second receipt grace, and the reported local completion timestamp falls inside the task window and at or before the deadline.

The grace exists because the product makes server acknowledgment a hard condition for credit, which would otherwise let a cold start, a slow handshake, or a moment of weak signal decide a user's deposit.
It is a deliberate leniency of bounded size.
A client could misreport its local timestamp by up to sixty seconds, and that exposure is accepted as smaller than the cost of failing honest users on network variance.

## Challenge state

### Task states

```text
scheduled ─────▶ completed
    │
    ├──────────▶ skipped
    │
    └──────────▶ missed ─────▶ forgiven
```

`skipped` is the state of a task the challenge's pause mode consumed.

`completed`, `skipped`, and `forgiven` are terminal.
`missed` is terminal unless Emergency Recovery supersedes it, which may happen at most once for a given task.

### Challenge states

```text
active ────────▶ succeeded
   │
   ├───────────▶ expired
   │
   ├───────────▶ recovery_pending ─────▶ failed
   │                    │
   │                    └──────────────▶ active
   │
   └───────────▶ failed
```

`succeeded`, `failed`, and `expired` are terminal.

`expired` is a challenge that spent a year paused.
It is neither outcome: the authorization is released, nothing is charged, and the account's Emergency Recovery is untouched.
It exists because a held deposit must be re-authorized for as long as the challenge does, and renewing forever against a forgotten card serves nobody, least of all while paused, when nothing is at stake and nothing can be failed.

It applies to zero deposit challenges too, which have no authorization to release.
There, the reason is different and equally real: one active challenge per account means a forgotten paused challenge would otherwise lock the account out permanently.
`expired` guarantees the slot always comes back.

`recovery_pending` exists so that recovery has something left to reverse.
When a task is missed and the account still holds its lifetime Emergency Recovery, the challenge enters `recovery_pending` and no funds move.
When the account has already spent its recovery, there is nothing to reverse, so the challenge goes directly to `failed` and settlement is created immediately.

Recovery is one per account for life, so an account can reach `recovery_pending` at most once ever.
Every subsequent failure, on that challenge or any later one, goes straight to `failed`.
The direct path is the common case, not the exception.

### Emergency Recovery

Recovery is never consumed by an `expired` challenge, which failed nothing.

Recovery applies only to funded challenges.
A zero deposit challenge that misses a task goes straight to `failed`, and the account's recovery stays unspent.
A lifetime allowance must not be consumable on a challenge that costs nothing to fail.

Recovery is offered, never applied automatically.
When a challenge enters `recovery_pending` the app asks whether the user wants to spend their one lifetime recovery to undo the miss.
Choosing to spend it consumes it, whatever happens to the challenge afterward.

Recovery is an explicit, audited transaction that, in one commit:

1. Consumes the account's lifetime recovery.
2. Transitions the missed task from `missed` to `forgiven`, preserving its history rather than deleting it.
3. Appends one new `scheduled` task, per the materialization rule, so the challenge can still reach its required completion count.
4. Cancels the pending settlement command.
5. Returns the challenge from `recovery_pending` to `active`.

Step 3 is not optional.
A forgiven task never becomes a completion, so without an appended task the challenge could never reach its required count and would remain active indefinitely.

A window is required because the offer cannot wait forever without settlement waiting with it.
If it expires without the user acting, the challenge moves from `recovery_pending` to `failed`, settlement executes, and the recovery remains unspent.
The window is 24 hours from the miss, recorded in the challenge's policy version and disclosed before the user deposits.

### Invariants the database must enforce

- One active challenge per account.
- One completion result per scheduled task.
- One terminal outcome per scheduled task, with `missed` supersedable by `forgiven` at most once.
- One terminal outcome per challenge.
- Task rows in `scheduled` or `completed` status equal the required task count, while the challenge is `active`.
- Emergency Recovery is consumed at most once per account.
- A challenge succeeds only after its required completion count is reached.
- Ledger entries for a challenge balance to zero.

These are constraints, not conventions.
Express them as unique indexes, check constraints, foreign keys, and exclusion constraints wherever PostgreSQL can carry them, so they hold for code paths that do not exist yet.

Two of them are aggregates and cannot be written that way.
The task count is a count across many rows and the ledger balance is a sum across many rows, while a check constraint sees one row and a unique index sees one key.
Both need deferred constraint triggers that fire at commit, and the task count trigger must also read the challenge status, since the rule is false by design between a miss and its resolution.
Plan that work rather than discovering it during schema review.

## Scheduled evaluation

EventBridge Scheduler invokes the Lambda with a scheduled event.

A daily invocation satisfies correctness on its own, because nothing is required to happen within minutes of a deadline.
Schedule additional invocations across the hours containing common deadlines.
Those extra ticks keep both the Lambda execution environment and the autosuspending Neon compute warm through the window when users are actually completing tasks, at no cost at this volume.

The sweep, in one pass:

0. Transitions to `skipped` any task belonging to a paused challenge whose pause cutoff has passed, appending one replacement `scheduled` task, in one transaction per task. Moves any challenge paused for 365 days to `expired`, releasing its authorization.
1. Selects tasks whose deadline plus receipt grace has passed and that have no acknowledged completion.
2. Locks a bounded batch with `FOR UPDATE SKIP LOCKED` so concurrent invocations take disjoint work.
3. Marks those tasks `missed`.
4. Moves each affected challenge to `recovery_pending` or `failed`, according to whether the account still holds its recovery.
5. Creates settlement commands with an `execute_after` instant, which is immediate for `failed` and the end of the recovery window for `recovery_pending`.
6. Executes any settlement command whose `execute_after` has passed and which has not been cancelled.
7. Renews any authorization approaching its `capture_before` instant, and releases the authorization of any challenge that has succeeded.
8. Repeats until no due batch remains.

Step 0 must precede step 1 in every invocation.
A skipped task's deadline passes like any other, so evaluating overdue tasks first would fail a challenge the user had already paused.

Separating steps 5 and 6 is what makes recovery possible.
No capture happens in the transaction that fails the challenge, so a user who opens the app later in the day still has an intact authorization to recover.

Step 7 must keep renewing through `recovery_pending`.
An authorization that lapses while a recovery offer is open would leave nothing to capture when the offer expires.

The sweep is idempotent.
Running it twice produces the same result as running it once.

Keep each invocation's batch small enough that a single run stays well inside the Lambda timeout, and rely on frequency rather than batch size to clear backlogs.

No permanent worker, queue, or workflow engine is required initially.

## Payments and ledger

The payment provider is not selected yet.
The funds flow is.

**Authorize on funding, capture only on failure.**
The deposit is authorized against the user's card when the challenge is funded and is never captured unless the challenge fails.
On success, and on expiry after a year-long pause, the authorization is cancelled and nothing is ever charged.

Processing fees attach to capture, not to authorization, so a cancelled or expired authorization costs nothing.
This is the whole reason for the design: a successful user, which is the outcome the product exists to produce, costs the platform nothing at all, and the fee on a failure comes out of money the user has already forfeited.
Capturing up front and refunding on success would instead have burned roughly 4% of every successful deposit permanently, since processors have not returned fees on refunds since 2020.

Three further consequences follow.

The platform never holds user money, so the money transmission question narrows to what happens after a forfeit rather than covering the whole challenge.
There is no refund, so the card network's 180-day refund window imposes no limit and the maximum duration is governed by authorization renewal instead.
And no funds move during `recovery_pending` without any special arrangement, because nothing has moved at any point before it.

**The hold is not the collection mechanism.**
Collection is an off-session charge against a saved payment method under a stored agreement.
The authorization exists to make the commitment tangible to the user and to detect a failing card early.
Keeping these separate is what makes every renewal failure survivable.

### Keeping the authorization alive

An online card authorization is valid for 7 days by default, and `request_extended_authorization` raises that to as much as 30 days on Visa, Mastercard, American Express, and Discover.

That parameter is `if_available`, so it is best-effort.
Never assume 30 days.
Read `capture_before` from the confirmed intent and schedule renewal from that value, at roughly half the remaining window, so a failed attempt has room to retry.

Authorize the replacement before cancelling the one it replaces.
A brief double hold is a support conversation; a gap is an unsecured challenge.

Enable the card account updater, which pulls reissued numbers and new expiry dates from the networks automatically. It resolves a useful minority of failures without any user action.

### When a renewal fails

The challenge continues.

A failed renewal marks the deposit unsecured, notifies the user, and retries. It never fails a challenge and never forfeits a deposit.
Failing someone for their bank's behavior would be indefensible, and the commitment stands on the stored agreement rather than on the hold being live.

On failure the settlement captures the live authorization if there is one, and otherwise charges the saved payment method off-session.
A charge that cannot be collected is recorded as an uncollected forfeit rather than quietly dropped.

Two risks are accepted rather than solved.
Issuers display and release holds inconsistently, and some drop one before the network window ends, so "your money is locked" is weaker as a literal claim than it reads and will generate support contacts.
And a user can defect deliberately by removing or cancelling their card. The hold makes that visible early; it does not prevent it.

Define a narrow provider interface for:

- Authorizing the deposit and saving the payment method for later off-session use.
- Renewing an authorization, and reporting the instant the current one expires.
- Releasing an authorization when a challenge succeeds.
- Capturing an authorization, or charging the saved method when none is live.
- Recording a forfeiture.
- Receiving and verifying webhooks.
- Looking up provider transaction status for reconciliation.
- Reporting a stable identifier for the payment instrument, for recovery deduplication.

Use a fake provider until legal counsel and a processor approve the exact funds flow.

A captured forfeit is platform revenue in full.
There is no charity recipient in the system, no per-user selection, and no disbursement path to build.
The donation the product promises is made by the platform out of that revenue, outside this system entirely.

This is deliberate and load-bearing.
Routing a user's money to a third party is what attracts money transmitter licensing and, separately, what App Store guideline 3.2.2(iv) forbids an app to collect for.
Keeping the money as revenue and donating separately removes both, and removes charitable solicitation registration with them.
What it does not remove is the obligation to be truthful: the pledge is a public claim, so the accounting behind it has to be real.

Provider records do not replace the product ledger.
PostgreSQL stores immutable, balanced ledger entries and links them to provider transaction IDs.
Payment commands are idempotent, carry an `execute_after` instant, and move through explicit pending, cancelled, confirmed, and failed states.

## Database access

Use Drizzle for schema definitions and migrations.
Write raw SQL inside two areas where it expresses the invariant better than a query builder: the overdue sweep's locking queries, and ledger and settlement transactions.
Naming those areas explicitly avoids relitigating the choice at every query.

Connect with the Neon serverless driver's WebSocket `Pool`, not its HTTP driver.
This is a correctness requirement, not a preference.
The HTTP driver supports only single statements and non-interactive batches, which cannot express `FOR UPDATE SKIP LOCKED` or the multi-statement transactions this design depends on.

Keep Lambda and Neon in the same supported region to reduce transaction latency.

Do not use Neon-specific data APIs in the domain.
Depend on PostgreSQL semantics so the database can move to RDS, Supabase, or another PostgreSQL provider with a connection string change.

Production requires an appropriate Neon plan, backups, and recovery testing.
The Free plan is suitable for development and a noncritical pilot, not an assumed production service level.

## AWS infrastructure

Define infrastructure with AWS CDK in TypeScript.

Version 1 requires exactly four things:

- One Lambda application with a Function URL.
- EventBridge Scheduler rules for the daily sweep and the warm windows.
- CloudWatch log groups with an explicit retention period, and alarms.
- SSM Parameter Store SecureString entries for secrets, with IAM roles granting each trigger only the permissions it needs.

Two cost-driven specifics:

- Use Parameter Store rather than Secrets Manager. Standard parameters are free, while Secrets Manager bills per secret per month for no benefit this design uses.
- Set log retention explicitly. CloudWatch log groups never expire by default, and storage accrues indefinitely.

Do not add a VPC solely for Lambda.
Neon is reached over its secure public endpoint, so a VPC would add cost and operational work without protecting a private database route.

Add SQS only if payment retries or external delivery failures need durable asynchronous processing beyond the database command table and scheduled sweep.

## Observability

Use structured JSON logs with:

- Request or invocation ID.
- Account and challenge IDs where appropriate.
- Idempotency key.
- Command type and result.
- Payment provider event ID.
- Authorization renewal outcome and the deposit's secured state.
- Error classification.

Never log session tokens, provider ID tokens, raw health data, or payment credentials.

Use CloudWatch for Lambda logs, metrics, and alarms.
Add Sentry to the mobile app for crashes and synchronization failures.
Additional telemetry is deferred until these tools fail to answer an operational question.

Prefer Lambda's built-in metrics and keep custom metrics within the free allowance.

Minimum alarms cover:

- Elevated API error rate.
- Completion acknowledgment latency.
- Overdue sweep failure.
- Payment webhook failure.
- Authorization renewal failure rate, and any deposit unsecured for longer than a day.
- Settlement commands past their `execute_after` instant.
- Uncollected forfeits.
- Rejected client completions, which indicate a contract or logic defect.

## Testing

### Domain tests

Use a deterministic clock and table-driven tests for:

- Weekly schedules and inactive days.
- Daylight saving transitions.
- Time zone changes across the pause cutoff boundary.
- No Regret cutoff boundaries, for entering and for leaving pause mode.
- The receipt grace boundary, on both sides.
- The maximum duration check, on both sides of the boundary.
- A pause spanning many task windows, including one that carries a challenge past its projected end date.
- A pause reaching a year, on both sides of the boundary, for funded and zero deposit challenges.
- The task count invariant across pause and recovery.
- Duplicate and concurrent completion requests sharing an idempotency key.
- Concurrent completion and overdue evaluation.
- Emergency Recovery consumption, including recovery arriving just before and just after the settlement instant.
- Ledger balance and payment retries.
- Authorization renewal, including a renewal that fails and one that lapses entirely.

### Integration tests

Run the Hono application against a disposable PostgreSQL database.
Verify real transactions, constraints, session issuance, idempotency, and webhook signatures.

Assert the invariants directly against the database, including attempts to violate them through paths the application does not normally take.

### Mobile tests

Test movement capture on physical iOS and Android devices.
Include:

- Foreground movement.
- Indoor use.
- Permission denial and revocation.
- App termination after local completion but before acknowledgment.
- Network loss and retry.
- Rejected completion handling.
- Device reboot, which resets the Android hardware step counter.
- The lowest supported operating system versions.

Use automated interface tests only for critical challenge setup, completion, pause, and recovery paths.

## Security and privacy

- Use TLS for every network request.
- Store session material in operating system secure storage.
- Keep database credentials and payment secrets on the server.
- Verify the session and account ownership for every command.
- Rate-limit session, completion, pause, and payment endpoints with counters in PostgreSQL, since there is no gateway layer doing it.
  In-process counters would not work: Lambda instances share no memory, so each one would enforce its own limit and concurrency would multiply the ceiling.
  Client-side throttling is not a substitute either, because an abusive caller does not run our client. It is still worth having as backoff, which is a different problem.
- Set reserved concurrency on the production Lambda as a cost ceiling that holds even if the counters are bypassed. Development leaves it unset so a fresh AWS account with a ten-execution account quota can deploy; that account quota is already the development ceiling.
- Request only movement permissions required by the selected verification method.
- Do not request location merely to infer a time zone.
- Store normalized movement summaries rather than raw sensor or location history.
- Keep financial records append-only and auditable.

## Cost model

At pilot traffic the intended steady-state cost is zero, given the AWS choices recorded under "Stack decisions" and "AWS infrastructure" and Neon's Free plan.

The complete system is still not free:

- Apple Developer membership is an annual fee, and Google Play a one-time fee.
- Payment processing costs nothing for a successful challenge, since fees attach to capture and a successful deposit is never captured.
  A forfeit pays a flat fee plus a percentage out of the forfeited amount, and the flat component dominates small ones: roughly 63% of a 50-cent deposit and 33% of a dollar.
  The processor enforces a minimum charge, 50 cents in USD, which is why the product's own minimum deposit is one dollar. A $1 forfeit still nets 67 cents.
  Forfeits are the only revenue in the design, and most of that is pledged away. The business will need revenue that is not forfeits.
- A production Neon plan is required before real deposits, per the release gates.
- EAS build credits, data transfer, and Sentry have their own limits.

AWS restructured its free tier in 2025, and newer accounts are on a credit-based plan rather than the older always-free arrangement for some services.
Verify current terms against the actual account type before treating any of the above as guaranteed.

Set AWS budgets and billing alarms before deployment.
Recheck vendor pricing before launch rather than encoding current free-tier numbers as a permanent architecture assumption.

## Deferred components

Do not add these until a measured need appears:

- Website or administrative console.
- API Gateway, WAF, or a custom domain.
- Custom Swift and Kotlin movement module.
- Authentication framework or additional sign-in methods.
- Transactional email.
- Redis or another cache.
- SQS or another queue.
- Temporal or another workflow engine.
- Kubernetes or ECS.
- GraphQL.
- Product analytics platform.
- Dedicated data warehouse.
- Microservices.

## Repository layout

```text
app/
  Expo React Native app

server/
  src/
    identity/
    challenges/
    completions/
    pauses/
    recovery/
    payments/
    sweep/
  migrations/
  test/

infra/
  AWS CDK application

docs/
  Product and architecture documents
```

Use one repository and package manager.
Add a workspace or monorepo task tool only when multiple package manifests and their task dependencies make it useful.

## App Store position

**The deposit is not an in-app purchase.**
Guideline 3.1.3(e) requires that goods and services consumed outside the app use payment methods other than IAP, "such as Apple Pay or traditional credit card entry."
An authorization against a card is money movement, not digital content consumed in the app.
Collect it through the payment provider, with Apple Pay and card entry, inside the app.
No web checkout is needed, so the "no website" line under "Deferred components" stands.

IAP is not merely expensive here, it is unusable.
It has no concept of an authorization that is released rather than captured, and apps cannot issue IAP refunds; the user requests one and Apple grants it at its discretion.

**Precedent.**
StepBet stakes money on step goals and returns it on success, on the US App Store, with stakes paid by Apple Pay, Google Pay, or card, and IAP reserved for memberships.
Oath, Commity, Real Stake, and stickK all take real stakes outside IAP.
StepBet is the harder case, because its winners take a share of losers' money; nobody in this design receives another user's money.

**The governing rule at review is 5.3, not 3.1.1.**
Gaming and gambling is among the most strictly enforced sections, and 5.3.3 bars IAP for real money gaming credit outright.
The position is the one Oath and stickK take: no chance element, the outcome turns entirely on the user's own verified actions, and no user profits from another's failure.
That last property is an invariant to protect, not an incidental fact.

Three things follow for the build:

1. Deposits go through the payment provider in the app, never IAP.
2. The app stays free and fully usable at zero stake, so paying is not unlocking functionality. This answers a 3.1.1 reviewer and avoids a 4.2 thin-client rejection.
3. Reviewer notes state the commitment contract framing, the absence of chance and of a pot, that a successful user is never charged at all, and that IAP cannot express a released authorization.

Do not build on the current 0% US link-out commission.
The rate is being set in district court now, Apple has proposed 15% standard and 5% for Small Business apps, and the Supreme Court hears the related appeal from October 2026.
Nothing here depends on it.

## Release gates

Implementation can begin with fake payments, but real deposits require all of these:

1. Step counting is proven accurate on supported iOS and Android versions, indoors and after a reboot, using the packaged pedometer.
2. The receipt grace is described to users. A broader server outage policy is deferred.
3. Legal counsel and a payment processor approve the authorize-and-capture funds flow, including what happens to a forfeit after collection.
4. The donation policy is published, states the share accurately, and has a mechanism behind it that the platform can actually honor.
5. Authorization renewal is proven across the full length of a real challenge on a real card, including a deliberate decline and recovery from it.
6. Backup restoration and overdue sweep recovery are tested.
7. Completion, recovery, and ledger invariants pass concurrency tests.
8. Account deletion behaves correctly for accounts with and without an active funded challenge.

## Sources

External facts this document relies on, which should be rechecked before launch rather than trusted indefinitely.

- [Expo Pedometer API](https://docs.expo.dev/versions/latest/sdk/pedometer/)
- [Stripe minimum charge amounts](https://docs.stripe.com/currencies)
- [Stripe: place a hold on a payment method](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method)
- [Stripe: extended authorizations](https://docs.stripe.com/payments/extended-authorization)
- [Stripe: fees on refunded payments](https://support.stripe.com/questions/understanding-fees-for-refunded-payments)
- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [StepBet rules](https://stepbet.com/rules)
- [Study: iPhone step tracking is solid, distance measurement is not](https://www.mobihealthnews.com/news/study-iphones-step-tracker-solid-dont-rely-its-distance-measurement-features)
