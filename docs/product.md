# BetterWakeUp (Working Name)

## Vision

Help people build difficult habits by creating real financial accountability.

Users voluntarily put their own money up as collateral, not as a wager.
Complete every required day and nothing is ever taken; fail once and it is forfeited.
The outcome is determined entirely by the user's own actions, so this is a commitment contract rather than gambling.

The goal is not to profit from failure but to make the cost of failure feel real enough to motivate follow-through.
A successful user is one who is never charged at all, and the platform should be built to encourage that: accountability, trust, and habit formation over revenue from forfeits.

## First Goal: Wake Up Early

Version 1 supports one goal.
Before each day's deadline the app must detect a step target on the device, for example 250 steps.

The target is expressed in steps rather than distance.
The device pedometer counts steps directly, while any distance figure is that same step count multiplied by an estimated stride length, which no device calibrates to the individual user.
Counting steps measures what the sensor actually observes.

## Challenge Parameters

The user sets all of these at creation. None can be changed after the challenge is funded.

| Parameter | Meaning | Example |
|---|---|---|
| Required task days | Count of scheduled tasks that must be completed | 30 or 90 |
| Weekly schedule | Which weekdays are active, and each active day's wake-up deadline | Monday through Friday at 9:00 AM, weekends inactive |
| Step target | Steps the device must record before the deadline | 250 steps |
| Deposit | Amount held for the duration. Either nothing, or at least $1 | $20 |
| No Regret Time | Minimum advance notice required to pause the next task | 8 hours |
| Time zone | Time zone the schedule is evaluated in | Confirmed by the user |

Each active weekday may carry a different deadline.
The app derives upcoming task dates and an expected end date from the required task count, the weekly schedule, and the confirmed time zone, and shows that end date before the user deposits.

### Deposit amounts

A deposit is either nothing at all, or at least $1. There is nothing in between, and no upper limit.

The gap is not a product preference.
A deposit of a few cents would cost more to collect than it is worth, and card processors reject charges below roughly 50 cents for that same reason.
Anyone who wants the lowest possible stake should take no stake, which is a supported mode rather than a workaround.

**A zero deposit challenge never reaches the payment provider at all.**
It is not a $0 charge, it is the absence of a charge: no authorization, no saved card, no renewal, no settlement.
Every other part of the product behaves identically, so this is one branch at the payment boundary rather than a separate kind of challenge.

Two product rules are scoped to funded challenges:

- The maximum duration, since there is no hold to keep alive.
- Emergency Recovery, which is neither offered nor consumed, because there is nothing to recover and a once-in-a-lifetime allowance should not be spendable on a challenge that costs nothing to fail.

Running a challenge at zero stake is worth doing on its own.
A commitment means something without money behind it, and someone should be able to run a week and see how the product behaves before deciding to fund one.

### Maximum duration

A challenge with a deposit is rejected at creation if its projected end date falls more than 365 days after funding.

Card holds expire and must be renewed periodically for the length of the challenge.
Every renewal is another chance for a card to decline, so a longer challenge carries a higher chance of ending up unsecured.
A year is a limit on that accumulated risk rather than a technical boundary.

The limit is on the plan, not the outcome.
Pausing extends a challenge past its projected end date, and a challenge that runs long because the user paused is not cut short.

## Core Flow

An account may hold one active challenge at a time.

Setting up a challenge is one sitting.
Nothing is saved until the deposit is authorized, so leaving the app partway through discards the configuration.

1. User configures the challenge and reviews the projected end date.
2. User commits the deposit. The full amount is placed on hold against their card and stays held for the duration. Nothing is charged. A user who set no deposit skips this step and the challenge starts at once.
3. On every active task day, the user opens the app and keeps it open until both daily checks pass.
4. All required task days pass both checks, so the hold is released and nothing was ever charged.
5. Either check is missing at a deadline, so the challenge ends. If the account still holds its Emergency Recovery, nothing is charged while that offer stands. Otherwise the deposit is charged and forfeited.

It is all or nothing. There is no partial forfeit.

## Daily Completion

A day counts only when **both** checks pass before that day's deadline.
The app displays them separately and must not show the day as complete while synchronization is pending.

**1. Local task completion.** The device evaluates the step target and records the result locally before attempting to send it.

**2. Server synchronization.** The server must receive and acknowledge that result before the same deadline.
A locally completed task that the server has not acknowledged does not count.

While open, the app evaluates recorded movement, stores the local result, finds any unsynchronized results, sends them, and retries until the server acknowledges.
Retries happen automatically whenever the app is open.
Background execution is never required.

### Disclosure

Network delivery cannot be guaranteed in every environment, so the user carries the responsibility of opening the app early enough and keeping it open until both checks appear.
Before accepting a challenge, the app must clearly explain that:

- Local task completion alone is insufficient.
- The server synchronization check is required before the deadline.
- A poor or unavailable connection can prevent synchronization.
- Closing the app before acknowledgment can leave the result unsynchronized.
- The user is responsible for confirming that both checks appear.

The interface should warn the user when a deadline is near and synchronization is still pending.

## Task Counting

- Only active weekdays produce tasks.
- Inactive weekdays do not count toward the required total and cannot cause failure.
- A task skipped while the challenge is paused does not count toward the required total, so pausing pushes the expected end date to a later active weekday, for as long as the pause lasts.
- Missing either check on an active, unpaused task day ends the challenge.

## Pausing

Pause is a mode the challenge is in, not an action applied to a single day.

When the user pauses, every subsequent active task is skipped until the user explicitly resumes.
This suits the situations pausing exists for, such as illness or travel, where the user does not know in advance how many days they will need.

A pause lasts until the user resumes. There is no allowance to run out and no limit on how many times a challenge may be paused.

The one bound is on a single pause running past a year, described below.

A skipped task:

- Does not count as a completed task.
- Extends the expected end date.
- Cannot be reinstated afterward.

The app must name the next task that pausing will skip before the user confirms, and must make it obvious while paused that the challenge is not running.

A challenge never resumes on its own.
The only thing that ends a pause is the user ending it, which means no user is ever surprised by a deadline they did not expect to face.

### A pause of a year ends the challenge

A pause that reaches 365 days closes the challenge as neither a success nor a failure.

Nothing is charged, the hold is released, and the Emergency Recovery is untouched.
The user simply stops being in a challenge, and is free to start another.

This is a technical bound made honest rather than a rule with a purpose.
A held deposit has to be re-authorized every few weeks for as long as the challenge exists, and each renewal is another chance for a card to decline or expire.
Renewing indefinitely against a card the user has forgotten about serves nobody, least of all while paused, when nothing is at stake and nothing can be failed.

The app warns as the pause approaches a year. Because the outcome costs the user nothing, the warning tells them what will happen rather than pressing them to act.

### No Regret Time

No Regret Time is the minimum advance notice required to skip a task.

```
Pause cutoff = task deadline - No Regret Time
```

With a Tuesday 8:00 AM deadline and 8 hours of No Regret Time, the cutoff is Tuesday 12:00 AM.

Pausing before a task's cutoff skips that task.
Pausing at or after it does not, so that task stays live and must be completed.

Resuming follows the same boundary.
A resume takes effect on the next task whose cutoff has not yet passed, so the user is never dropped into a task window they can no longer plan around.

## Time Zone

The user confirms a time zone at creation, and the schedule keeps using it until the user explicitly changes it.
The app may suggest the device's current time zone, but the user must confirm the choice.
Automatic travel detection never changes an active challenge's time zone.

A time zone change applies only to tasks whose pause cutoff has not yet passed.
It does not alter completed, missed, skipped, or currently live task days.
The rules for changing time zone mid-challenge must be shown before the user starts.

## Deposit and Forfeiture

The deposit is placed on hold against the user's card when the challenge is funded.
The money never leaves their account, but it is reserved against their available balance and cannot be spent elsewhere.
There is no early release.

On success the hold is released and the user is never charged anything.
The deposit is only ever collected from someone who fails.

### Keeping the hold alive

Card holds expire, typically after 7 to 30 days depending on the card, so the app renews the hold for as long as the challenge runs.

A renewal can fail for reasons that have nothing to do with the user's behavior: a card expires, a bank reissues it, or available credit runs short.
When that happens the challenge continues normally. The user is told their deposit is no longer secured and asked to update their payment method.

A failed renewal never fails a challenge and never costs a user their deposit.
Being punished for a bank's behavior would be indefensible, and the commitment the user made stands regardless of whether the hold happens to be live.

A forfeited deposit becomes platform revenue.

The platform commits to donating the majority of that revenue, 80% of what remains after processing costs, to charity.

That is a promise the platform makes about its own money, not a transfer the user directs.
The user does not choose a recipient, and no part of any deposit is routed to a third party.
The donation happens outside this system.

The distinction matters in three places.
It keeps the product from collecting funds on a charity's behalf, which is a category with its own registration requirements and its own App Store rule.
It keeps the platform from moving a user's money to a third party, which is the shape that attracts money transmitter licensing.
And it means the product owes users an accurate public accounting rather than a per-transaction receipt.

Because the pledge is a public claim rather than a mechanism, it has to stay true.
Publish the policy, publish what was actually given, and change the stated share by announcement rather than quietly.

## Grace Recovery

Each account receives exactly one lifetime Emergency Recovery, which never replenishes.

It applies only to challenges with a deposit, and is never applied automatically.
When a task is missed and the recovery is still held, the app asks whether the user wants to spend it to undo the miss.
Choosing to spend it reverses the failure: the challenge continues, the missed day is forgiven, and the Emergency Recovery is permanently consumed.

The offer stands for 24 hours after the miss.
Nothing is charged while it stands.
Declining, or letting the 24 hours pass, charges the deposit and leaves the recovery unspent for a future challenge.

Because it exists at most once per account, most failures are never offered it.
Any failure once the recovery is spent forfeits the deposit immediately.

The length of the offer must be disclosed before the user deposits.

## Future Expansion

Later versions may support other commitment-based habits: exercise, reading, meditation, studying, walking, limiting social media, and daily journaling.

The long-term vision is a general-purpose commitment contract platform where users can put meaningful financial accountability behind any habit.
