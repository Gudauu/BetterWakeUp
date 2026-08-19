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
`app/src/ui/components.tsx` owns how the recurring pieces are drawn: the screen frame, cards, buttons, banners, progress bars, labelled rows, the status pill that names the state a challenge is in, the row of days a month is read as, and the form controls a screen collects a configuration with - a labelled field with its own complaint or read-back line, a selectable chip, a statement toggle.

A screen names a role - `textMuted`, a `danger` banner, a `primary` button - and never a hex code or a font size.
That is what lets the app follow the device between light and dark without a single screen asking which one is in force, and it is why a change to the look of a button is one edit rather than nine.

`useTheme` reads the device setting, which `app.json` already declares the app honours with `userInterfaceStyle: automatic`.

`app/src/ui/format.ts` owns how instants and dates are read out loud, so no screen prints an ISO string at a person.
A deadline is only true in the challenge's own time zone, so every screen that shows one formats it there rather than in the device's zone, and falls back to the raw instant when the runtime has no zone data.

### The wake-up time being typed

The contract's `localTime` is a strict 24-hour `HH:MM`, and it stays strict: the server computes a real instant from it, so a loosely parsed schedule entry would be a wrong deadline rather than a rejected one.

What is loose is the typing. `app/src/challenges/wake-time.ts` reads what a person actually enters - `7`, `700`, `7am`, `7:30 pm`, `19:30` - and answers either the canonical form or one sentence saying it is not a time yet.
It refuses rather than guesses where a guess would be a real cost: `7:5` is ambiguous between five past and half past, and `19 pm` is not a correctable typo but a contradiction, so both are refused. `12 AM` is midnight and `12 PM` is noon, which is the one pair the arithmetic has to state explicitly.

The complaint is drawn under the field that caused it, because a user fixing a value should not have to find the complaint about it somewhere else on a long form.
That is what `Field`'s `problem` and `reading` are for: what is wrong, or - once the text is understood - what it comes to, so nobody has to guess whether a typed `7` means seven in the morning.

The draft only ever receives text that reads as a time, so the schedule it holds is always valid. Text that does not read as one is therefore invisible to `configurationOf`, and the setup screen holds the affected weekdays itself and withholds the action that commits while any of them stands.
Without that, a challenge could be started against the last accepted deadline while the field on screen showed something else. A weekday turned off drops out of that set, so a half-typed Saturday cannot block a form from a field that is no longer drawn.

### The numbers being typed

The same split applies to the three whole numbers a challenge is configured with - days to complete, step target, No Regret Time - and `app/src/challenges/counts.ts` reads them.

The reading exists for two reasons. The first is that a field which writes its own value back on every keystroke cannot be cleared: emptying the box used to be stored as zero and read back as `0` under the cursor, so a `30` could only be replaced by selecting it first.
The second is that the zero it stored was then judged by the contract's schema, which answered with a path into the request body drawn in a banner two cards below the field that caused it.

So an empty box is not a zero: it is a field whose value has not been typed yet, held as text in the field and reported upward the way an unreadable deadline is, with the action that commits withheld while any of them stands.
A number below its field's minimum is read but refused, and the sentence naming what is wrong belongs to the field rather than to the reader, because "at least one day" and "at least one step" are different sentences about the same rule.

`configurationOf` states its remaining complaints in the same words. A path into the request body is the right thing to log and the wrong thing to show, so the schema's issues are mapped to sentences, sharing the fields' own wording so the banner and the line under the box cannot disagree.

### The month as a row of days

`challengeView.days` is the challenge's own calendar: every day it holds, oldest first, each with the status the server gave it.
The whole task set is materialized when a challenge activates, so this is the challenge rather than a window over it, and the app needs no second call and no history endpoint to draw a month.

`app/src/challenges/history.ts` re-reads those statuses from the user's side - kept, missed, forgiven, skipped, due, ahead - and finds the day being asked for right now, which is the earliest still-scheduled one.
That day is split out from the ones behind it because it is the only day the user can still act on, and a row that drew it like next Thursday would hide the one that matters.

The streak counts walks in an unbroken run ending at the last decided day.
Only a walk continues a run: a missed, skipped or forgiven day ends it, because the streak is a count of mornings the user actually got up.
It is the current run rather than the best one, and it says nothing at all below two - "1 day in a row" on the morning after the first walk reads as a machine counting.
A broken run is not mentioned either: the row already shows the day that broke it, and a sentence about it would be the app scolding someone who turned up today.

`DayStrip` draws the row as one accessible element carrying a sentence its caller wrote, not as thirty unlabelled squares.
Colour is the whole of what the row says visually, so without that sentence a screen reader would reach thirty announcements of nothing.

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

### The answer on screen going out of date

Everything home shows is tied to a wall-clock moment: which task is open, when it is due, whether the recovery offer has expired, how many days are done.
The read happens when home mounts, so a phone that has been in a pocket since last night shows last night's answer, and home is the one screen where being out of date is indistinguishable from being wrong.

`app/src/challenges/app-return.ts` turns the app coming back to the front into a re-read.
It is the same event the pending-completion sync already treats as its "try again now", kept separate because sync's triggers are built inside a runtime that opens a database, while a screen has to be able to take this one on its own.

The re-read is quiet: `useCurrentChallenge` gained `refresh` beside `reload`, which leaves the previous answer on screen until a better one arrives.
`reload` blanks the screen to a spinner, which is right for a first read and for a retry after a failure, and wrong for a re-read of something the user is already looking at - including the one they asked for by pressing Refresh.

A quiet re-read that does not come back is not an error screen.
The user is holding a phone showing a challenge, and taking that away because one request did not land is a worse answer than the slightly old one, so home keeps what it has and says under the title that it is the last connection's answer.

Home asks for returns only while it is itself what is on screen.
A re-read landing under the task screen, the form or the pause decision would pull that screen out from under the user mid-use.

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

### The card that stopped working

A hold does not last a month.
The server renews it, and a renewal fails when a card expires, is replaced by the bank, or is declined; the sweep's answer is to set `depositSecured` to false and keep the challenge running.
Home has always shown that field as a warning, and until now there was nothing behind the sentence to press.

The same port answers it, with `collect()` beside `present()`.
The two are different questions: presenting authorizes one particular hold and reports only that the user finished, while collecting saves an instrument and hands back the identifier the server takes a fresh hold with.
That is why a decline on the replacement path is the server's answer - `POST /challenges/:challengeId/payment-method` authorizes off-session - rather than the sheet's.

`needsPaymentMethod` decides where the offer appears: the challenge has to be running or waiting on a recovery decision, and it has to have staked something.
A terminal challenge has no hold left to keep alive, and a zero deposit challenge is always reported as secured because it has nothing to secure.

The screen opens the sheet from a press rather than on arrival, since a card modal thrown at someone the moment they tap a warning asks for a card before they have read why.
This build has no processor, so `collect()` answers `unavailable` there too - and it says the challenge keeps running and that nothing can be charged while no card secures it, which is the true and useful thing to tell someone whose challenge is already under way.

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

#### The walk as the user experiences it

The foreground-only rule is enforced by the capture and explained by `app/src/movement/walk-progress.ts`, which reads a `CaptureState` and answers the two things the capture does not state: whether the open window has already met the step target, and whether the last window closed without the user asking it to.

Both exist because the capture answers an abandoned walk and a finished walk with the same `stopped` state.
Without the second, a user who glanced at a message mid-walk came back to a screen offering to "Start moving", identical to the one they left, with the counted steps gone and nobody having said so.
The screen now names what ended the walk and how many steps it cost, and the start button reads "Start the walk again".

The first is the other half of the same rule: while a window is open the screen says how many steps are left and that leaving the app ends the walk, and the moment the target is met it says so and turns the button into "Save my walk", because the walk is earned at that step and every second after it is a second the window can still be lost.

#### The press that ended the walk

Below the target, the button that closes a window had read "Stop and check".
That promises a look at a number the screen is already showing live and delivers something else entirely: a window cannot be resumed, because the observation the server accepts is one continuous stretch of foreground time, so the steps in a window closed early are thrown away and the next walk starts at zero.
One tap of a control labelled as a check therefore cost a user their whole walk.

The press is now split by what it does rather than sharing a label.
With the target met, stopping saves the morning and is offered outright.
Short of it, the control reads "End this walk" and opens `abandonWalkText` - how far short the walk is, how many steps go, and that a later walk cannot inherit them - before a second, danger-toned press ends it; backing out reads "Keep walking", because a walk is kept by carrying on with it rather than by keeping things as they are, which is what `ConfirmAction`'s default cancel says.
A window that has counted nothing is closed by a single press: there is nothing to lose, and a confirmation over it would be ceremony.

#### Why the phone does not lock during a walk

The foreground-only rule and the device's auto-lock timer were in direct conflict, and the timer won.
Walking is precisely the activity during which nobody touches their phone, so a screen that goes dark after its default idle timeout backgrounds the app, closes the window, and discards every step counted - a failure that needed nothing from the user but doing exactly what the screen asked.

`app/src/movement/screen-lock.ts` holds the screen awake for exactly as long as a window is open.
It is a port for the same reason the pedometer is one: the rule of when to hold and when to release is worth testing without a device, and `native-screen-lock.ts` is the only module importing `expo-keep-awake`.
The lock is taken under this app's own tag rather than the shared default, so nothing else in the app can drop a walk's lock or be held on by one.

It is owned by the completion runtime rather than by the task screen, because the window and the screen have different lifetimes: a capture left open when its screen unmounts is still counting, and the phone must not lock under it.
Requests are queued rather than issued as they arrive, since activating and releasing are separate round trips that could otherwise land in the opposite order and leave a phone in a pocket awake indefinitely; disposal releases whatever is held for the same reason.
A device that will not hold its screen on fails silently - the walk is being counted either way, and an error a walking user cannot act on is noise.

The wording on the walk card follows the guarantee: it now leads with the screen staying on, and names leaving the app as the one thing left that ends the walk, rather than reading as an instruction to keep touching the phone.

#### The permission the app cannot grant itself

Three of the app's dead ends belong to the operating system rather than to the app: motion access refused before a walk, motion access revoked during one, and notifications refused so no alarm can be scheduled.
In all three the app knows exactly what has to change, cannot change it, and until now said so as prose - "Turn it on in Settings" - which leaves a user who has just been stopped from walking to go and find the right page themselves, on the morning they have least patience for it.

`app/src/device/settings.ts` is the port for opening this app's own page in the device's settings, and `app/src/screens/open-settings-action.tsx` is the one press all three places draw.
It is a port for the same reasons the notifier and the pedometer are: a test must be able to press the button without the machine leaving for a settings app, and a platform with no such page has to be able to refuse.
A refusal is reported rather than swallowed - the prose instruction the button replaced is drawn under the button that just failed - because at that point walking there by hand is the only route left, and a press that silently did nothing reads as the app being broken on top of the permission already being off.

A walk the app was merely switched away from gets no such press: nothing in Settings would have saved it, the fix is to start again, and a button pointing elsewhere would be a wrong instruction.

#### Asking the phone before asking for the money

Every morning of a challenge is settled by one fact - the step counter in the user's pocket - and both ways that fact can be missing were discoverable only at the first press of "Start the walk".
A phone with no pedometer answers `unsupported`, and a phone whose motion access has been refused answers `permission-denied`, and both of those answers arrived on the first morning, after a deposit was already held against a challenge no day of which could ever be completed.

`app/src/movement/device-readiness.ts` asks the question while the challenge is still a draft.
It is a narrow port - availability and the standing permission, taken as a subset of `Pedometer` - because nothing here watches anything, and a capture would open a window over a walk nobody is taking.
The same fake pedometer that drives a capture in a test drives this, and the configured device is the simulated pedometer in a build that simulates movement, so a simulator build is not barred by a sensor it was never going to use.

Only `unsupported` bars the start, and it bars it outright: there is no press on that device that fixes a missing sensor, so the notice names the way out that exists - signing in on a phone that counts steps.
A refused permission is a warning with the settings press beside it rather than a bar, because it can be turned on at any point before the first morning; a device that would not answer at all is not evidence of anything, and refusing someone a challenge over a failed read would charge the app's fault to them.
The read is repeated on request rather than polled, because motion access is changed on a page the app is not in front of, so the honest moment to ask again is when the user says they have changed it.

The good answer is drawn too, rather than left as silence.
The user is about to put money behind a sensor, and being told the sensor is there is part of what the screen owes them.

#### The clock on the morning

`app/src/completions/time-left.ts` reads the minutes to the deadline that `dailyCompletionState` already carries and answers how much of the morning is left, how urgent that is, and the sentence for each.

The deadline used to be stated only as a wall-clock time - "250 steps by 7:00 AM" - and then not mentioned again until a walk was already saved and waiting to be sent.
That left the two moments the day turns on unspoken.
Someone opening the app at 6:52 was not told they had eight minutes, and someone opening it at 7:20 was told "Not done yet" and offered a button that starts a walk `POST /tasks/:id/completions` has already stopped being able to accept: the command must arrive within the deadline's receipt grace, and the reported completion instant must itself be at or before the deadline, so a walk begun after it cannot count however far it goes.

The boundary between a countdown worth reading quietly and one worth raising is `ALARM_LEAD_MINUTES`, imported rather than restated.
The app has already decided that is the moment a user should be up and walking, and the reminder that fires then and the line that turns amber then are the same judgement.

Past the deadline the screen withdraws the invitation rather than colouring it: the start button is gone, the advice says the window has closed, and a banner names the time that passed and points at the Emergency Recovery, which lives on home because the offer only exists once the server has recorded the missed day.
While a walk is racing the clock the card adds the half of the rule a walker cannot guess - it is the instant the walk is saved that is judged, so a window opened in time and finished late is refused.

Home reads the same clock from the other end.
It holds the task the server sent rather than the state `dailyCompletionState` derives, so `timeLeftUntil` takes the deadline instant directly and the two screens cannot word one clock two ways.
Home is the screen most people open first, and it named "Deadline 7:00 AM" and stopped there, leaving the reader to work out whether that was hours away or eight minutes - and once the deadline had gone it still offered "Open today's task" over a step target, which is an invitation to walk for nothing.
Past it the card says the morning went by with nothing saved, stops short of calling the day lost because the sweep decides that, and mentions the Emergency Recovery only as a condition rather than as a promise, since a challenge that has already spent it gets no offer.
A walk the deadline overtook while it sat unsent on the phone is told so plainly: the sentence that asked its owner to find signal was asking for work that could no longer buy anything.

#### The morning that has not started yet

`app/src/challenges/walk-window.ts` answers the other end of the same window: whether the walk home is showing can be walked at all yet.

The server hands out one open task at a time, so the moment today's walk is acknowledged the open task is tomorrow morning's.
Home drew it exactly as it had drawn today's - a step target, a countdown, and a button reading "Open today's task" - and a completion recorded for it that evening is refused, because `create-completion.ts` requires the observation to fall inside the task's own local day.
That is the same defect as the passed deadline at the opposite edge of the window, and it was reachable every single day of a challenge rather than only on a missed one.

The question is answered by comparing calendar dates in the challenge's own time zone, not instants: a task's `date` is the local day it belongs to, so "has that day started" is "what day is it where the challenge reads its deadlines".
A runtime whose `Intl` cannot read the zone answers nothing and home says what it always said, because a guess about which day it is would be worse than the sentence it replaces.

Once the walk has not opened, the card asks for nothing.
The countdown is gone - twenty hours to a morning nobody is being asked about is noise - the button is gone, and in its place is the rule the missing button would otherwise leave a user to infer: the walk opens tomorrow morning, it has to be walked then, and steps taken before it opens cannot count for it.

The same read is what lets home say a morning was kept.
Until now the only mark of a kept day on home was a square in the row of days: the card that had asked for the walk simply started asking for the next one, on the one screen a user opens after doing the thing the whole product is about.
A run of two or more is named in the same sentence, and a single kept day is stated as itself rather than counted, for the reason `streakSentence` already gives.

#### The mornings the challenge asks for

`app/src/challenges/schedule.ts` reads a configuration's weekly schedule back as text.

The schedule is the whole of what a challenge asks of its owner, it is decided once, and it can never be edited afterwards - the contract carries no endpoint for it, because a deadline that could move is not a commitment.
That makes stating it the only thing left the app can do about it, and nothing past the setup form did: home listed the projected end date, the deposit and the step target, so the days and the times a user is on the hook for were readable only on a day that already had a task open.

The days are grouped by the deadline they share rather than listed one per row.
A challenge is up to seven `ScheduledWeekday` entries with a wall-clock time each, and seven rows is a table to be decoded; "Mon-Fri at 7:00 AM" is the same fact as its owner thinks of it.
Within a group, three or more consecutive days collapse to a range and two stay a list, because "Sat-Sun" saves nothing and reads as a span rather than as two mornings.
Grouping by deadline before contiguity is what keeps a weekend that starts an hour later reading as two arrangements instead of as a run broken in the middle.

The same module answers what home says when no task is open.
"The next task appears on your next active day" is true and asks the reader to hold the schedule in their head; the weekday itself is derivable from the configuration and the calendar date in the challenge's own zone, which is the reading `localDate` already provides.
It is searched strictly forward from today, because this state means today's morning is either not scheduled or already behind the user, and naming today would read as an invitation to walk for a day that is closed.
A runtime that cannot read the zone falls back to the sentence home always said, for the same reason the walk window does.

#### What one missed morning would cost

`app/src/challenges/miss-cost.ts` states, on the challenge card, what would happen if the user slept through tomorrow.

That answer turns on two facts.
One is the deposit, which the challenge carries.
The other is the account's one lifetime Emergency Recovery, which decides whether a miss can be bought back at all - and it is an account-level fact the app is told exactly once, in `accountView` at sign-in, and then discards.
Nothing afterwards could ask for it: there is no account read, and the flag changes as the account's own recoveries are spent.
So the rule the whole product rests on - one missed active day ends the challenge and forfeits the deposit - was stated once at setup, in a list of disclosures acknowledged with a switch, and never again.

`challengeView.recoveryAvailable` closes that.
The server answers it per challenge as `deposit > 0 && the allowance is unspent`, which is exactly the rule `resolveChallenge` in the sweep applies to a miss, so the app never derives what a miss costs from a status - the same reasoning that put `depositOutcome` on `endedChallengeSummary`.
It belongs on the challenge rather than beside it because a lifetime allowance is not spendable on a challenge with no deposit, so "does the account hold one" is the wrong question and "would this challenge be offered one" is the right one.

The app only picks the wording, in three cases: the net still stands, the net is spent, or nothing is staked and Emergency Recovery was never in play.
Only the spent case is toned as a warning; a safety net that is still there is a fact, and colouring it red would train the reader to ignore the tone.
The line is withheld while a recovery offer is already standing - that challenge is living the answer, and home draws the offer and its countdown above the card - and while a pause has taken the morning away, unless a task whose pause cutoff had passed stayed live through it, which is the one case where a paused challenge can still lose a deposit.

### The clock on the recovery offer

`app/src/challenges/recovery-window.ts` does for the Emergency Recovery offer what `time-left.ts` does for the morning: it reads the offer's `expiresAt` against the clock and answers how long is left, how urgent that is, and whether there is still a decision to make.

This is the most expensive clock in the app.
A missed day puts the challenge into `recovery_pending` and the server holds the settlement open until the offer lapses, so letting it pass is what charges the deposit.
Both screens that mentioned the offer named an absolute time and nothing else, which is a fact about the future rather than an answer to the question the user has, and neither read the clock at all: once the window had closed, home still offered "Decide on your recovery" and the recovery screen still drew the spend-or-keep choice with a live button under it, even though `acceptRecovery` refuses an expired offer before it sends anything.
The user's reward for two presses was a refusal explaining that the decision had already been made for them.

The boundary between a countdown read quietly and one read in red is `RECOVERY_LEAD_MINUTES`, imported from the reminders rather than restated, on the same reasoning as the morning's: the moment the app is willing to wake someone over the offer is the moment the offer stops being background information.

Once the window has closed both surfaces withdraw the decision rather than colouring it.
Home replaces the invitation with what happened and drops the button; the recovery screen replaces the whole choice with the closed window and the one piece of good news left in it, which is that the allowance was never spent.
Neither of them says what became of the money: a zero-deposit challenge settles nothing, and the outcome the server decides in its sweep reaches home as `lastEnded` rather than being guessed at here.

The duration wording itself lives in `app/src/ui/format.ts` as `formatDuration`, because two countdowns now use it and "2 hours 30 minutes" must not be said two ways.

### A countdown that counts

Both of those clocks were read once, at the instant their screen was drawn.
That is correct exactly then and wrong from the next minute on, which is the difference between a countdown and a number that happens to be a duration.
A phone put down at 6:59 with "1 minute left to walk" on it went on saying so at 7:20, still offering a walk the server had already stopped accepting; a user weighing the recovery decision through the last minutes of the window kept both buttons in front of them after the offer had gone.
Neither screen was wrong about a rule - the rules landed in the two sections above - and both drew the state of a moment that had passed.

`app/src/ui/clock.ts` is the fix and the only place a screen gets a moving instant.
`useClock(now)` holds the current instant as state and re-reads it every `CLOCK_INTERVAL_MS`, which is half a minute: everything the app counts down is worded in whole minutes, so a reading is never more than one tick stale.
Home, the daily task screen and the recovery screen all draw from it, so a countdown on one cannot tick while the same countdown on another stands still.

The `now` seam each of those screens already carried is what the hook reads, so a test still states the clock.
A stated clock that keeps answering the same instant publishes nothing: the tick only replaces the instant on screen when it differs from the one already there, so a fixed-clock test renders exactly as still as it did before, and a test that wants time to pass hands in a function that answers a later instant and advances the timer.

### A pause standing still

A pause is the one state in the app that nothing ends but the user.
No deadline arrives, no day is failed, and the reminders that would otherwise be on the device are deliberately not scheduled, so a challenge left paused makes no sound of any kind until the year runs out and it closes as `expired`.

Home used to say the word "Paused" in a pill and nothing else, which reads like a state the app is managing on the user's behalf.
It now draws a banner: how long the pause has stood, that no alarm will sound, that the challenge never starts again on its own, and the way to resume it.
That is also where resuming is pressed - the quiet link under the challenge's numbers stays for pausing a running challenge, but a paused one has the button beside the reason to press it.

The sentences are `pausedForSentence` and `pausedRestSentence` in `app/src/challenges/pause.ts`, beside the derivation that produces the numbers, so the pause screen and home cannot count the same days two ways.

A task whose pause cutoff had already passed stays live through the pause, which is why the sentence is written twice.
With a task still open the banner names the deadline that still counts instead of promising that none does, because the promise would be a lie about the one day that can still be lost.

The year is stated the same way on both screens, through `pauseExpirySentence`, and the banner turns red inside `PAUSE_EXPIRY_WARNING_DAYS`.
It asks for nothing: expiry is neither a success nor a failure, and nothing is charged, so the sentence states the outcome and leaves resuming to the user.

### Being signed out without asking

There are three ways to arrive at the signed-out screen and they are not the same event.
A first launch has never held a session, a sign-out was pressed, and an expiry happens to a user who was in the middle of something - either the stored session's expiry passes while the app is closed, or the server refuses the token on the next request and `onSessionInvalid` moves the whole app back to signed out.

The signed-out state therefore carries a `SignedOutReason` (`noSession`, `signedOut`, `expired`) in `app/src/session/session-context.tsx`.
Without it the screen has to sell the app to someone who was three weeks into a challenge a second ago, which reads as the app having forgotten them.

On `expired` the welcome screen leads with what happened and drops the three how-it-works steps, which are for someone who has never seen the app.
The notice says the one thing that changes what the user does next: being signed out is not a pause.
The challenge keeps running, its deadlines keep counting, and only a walk taken in the app can meet one, so signing back in is urgent rather than housekeeping.
It also says that a walk already saved on this phone is still there, because the pending completion store is never cleared by a sign-out and would otherwise look lost.

The two ways a session dies share one reason on purpose: the user experienced the same thing either way, and the difference is only in which side of the request noticed.

Reminders do not survive the session.
`useReminders` only replaces what it schedules while home is mounted, so a session that ends leaves the last set it wrote standing on the device: the phone goes on waking someone for an account it can no longer reach, and the walk the alarm asks for cannot be taken, because taking it needs a session.
An alarm that cannot be acted on is worse than no alarm, so `useRemindersClearedWhenSignedOut` takes them all off on the transition into signed out - including a first launch, where a device with no session should hold no reminders whether it lost one or never had one.
That is also why the welcome screen owns the notifier rather than passing one through: it is the only component mounted both while a session exists and after it is gone.
The expiry notice says the alarms have stopped, because a user relying on tomorrow's has to hear that it will not sound.

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

Home reads the store as well as the challenge.
The task screen shows these states while it is open, but home is the screen someone opens after walking, and a walk still on the phone is invisible in the challenge the server answers with: the task is still scheduled and the day count has not moved.
So home reports what this device is holding - today's walk saved but not yet sent, today's walk refused, or a walk left over from an earlier day - and a walk from an earlier day is reported without any action beside it, because sync retries it on its own and the task it belonged to is closed.
The store is read again whenever sync publishes an outcome, so the moment a walk lands home stops saying it is waiting.

Home reports the store on its error screen too, not only on the loaded one.
The read of the challenge fails exactly when the device has no connection, which is exactly when a walk stays on the phone, so the two coincide rather than being independent.
An error screen that says only that the challenge could not be loaded reads, to someone who got up and walked ten minutes ago, as though the walk went with it - and the one thing they might do about that cannot help, because the record is already written and a second walk would be refused as a duplicate.
So when the read fails and the device is holding records, the screen names how many and says they send themselves; when it is holding none it says nothing, rather than reassuring someone about work they never did.

#### Why a refusal is read from the code

A refused record is the one failure in the app the user is asked to act on, so the task screen has to say what happened.
It says it from the error code and never from the error message: the contract declares the message human-readable and for developers, and it is - a walk that arrived a minute late was reported to the walker as arriving "after the deadline and its 60 second receipt grace", and one counted by the phone's own step history as needing "foreground_pedometer movement only".

`app/src/completions/refusal.ts` owns the wording, one entry per code a saved completion can actually be refused with, and an unlisted or unrecognised code falls back to a single sentence rather than to the server's words.
Each refusal carries what happened, what is left to do, and whether another walk this morning could still be accepted - which is a separate question from what went wrong.
A walk short of the step target or counted outside the app can be taken again while the deadline stands, so the screen offers the walk its own next step asks for; a passed deadline, a settled day and an ended challenge cannot be answered by walking, so no walk is offered at all.

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

Every pool carries an `error` listener, on both drivers.
A pool emits `error` when a connection fails while it is idle - the database restarted, an administrator terminated the backend, a proxy dropped the socket - and a Node `EventEmitter` with no listener for `error` throws, which would end the execution environment over a socket no request was holding.
The pool has already discarded the client by then, so the handler only says what happened and the next query opens a fresh connection.

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
