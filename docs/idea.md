# BetterWakeUp (Working Name)

## Vision

Help people build difficult habits by creating real financial accountability.

Users voluntarily lock up their own money as collateral, not as a wager.
Complete every required day and 100% is returned; fail once and it is forfeited.
The outcome is determined entirely by the user's own actions, so this is a commitment contract rather than gambling.

The goal is not to profit from failure but to make the cost of failure feel real enough to motivate follow-through.
A successful user is one who gets all of their own money back, and the platform should be built to encourage that: accountability, trust, and habit formation over revenue from forfeits.

## First Goal: Wake Up Early

Version 1 supports one goal.
Before each day's deadline the app must detect a movement target on the device (for example, 200 meters).

## Challenge Parameters

The user sets all of these at creation. None can be changed after the challenge is funded.

| Parameter | Meaning | Example |
|---|---|---|
| Required task days | Count of scheduled tasks that must be completed | 30, 90, or 365 |
| Weekly schedule | Which weekdays are active, and each active day's wake-up deadline | Monday through Friday at 9:00 AM, weekends inactive |
| Movement target | Distance the device must record before the deadline | 200 m |
| Deposit | Amount locked for the duration | $20 |
| Pause allowance | Number of tasks that may be skipped ahead of time without failure | 5 |
| No Regret Time | Minimum advance notice required to pause a task | 8 hours |
| Time zone | Time zone the schedule is evaluated in | Confirmed by the user |

Each active weekday may carry a different deadline.
The app derives upcoming task dates and an expected end date from the required task count, the weekly schedule, and the confirmed time zone, and shows that end date before the user deposits.

## Core Flow

1. User configures the challenge and reviews the projected end date.
2. User deposits. The full amount locks immediately.
3. On every active task day, the user opens the app and keeps it open until both daily checks pass.
4. All required task days pass both checks, so 100% of the deposit is returned.
5. Either check is missing at a deadline, so the challenge ends immediately and the deposit is forfeited.

No partial refunds.

## Daily Completion

A day counts only when **both** checks pass before that day's deadline.
The app displays them separately and must not show the day as complete while synchronization is pending.

**1. Local task completion.** The device evaluates the movement target and records the result locally before attempting to send it.

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
- A paused task does not count toward the required total, so pausing pushes the expected end date to a later active weekday.
- Missing either check on an active, unpaused task day ends the challenge.

## Planned Pauses

Each pause skips one upcoming active task without causing failure. A pause:

- Applies only to the next active task, which may not be the next calendar day.
- Consumes one day from the pause allowance.
- Does not count as a completed task.
- Extends the expected end date.
- Cannot be reversed after confirmation.

The app must name the exact task date before the user confirms.
When no allowance remains, the pause action is unavailable.

### No Regret Time

No Regret Time is the minimum advance notice required to pause the next active task.

```
Pause cutoff = task deadline - No Regret Time
```

With a Tuesday 8:00 AM deadline and 8 hours of No Regret Time, the cutoff is Tuesday 12:00 AM.
The user may pause before then; at or after the cutoff, the pause action is unavailable for that task.

## Time Zone

The user confirms a time zone at creation, and the schedule keeps using it until the user explicitly changes it.
The app may suggest the device's current time zone, but the user must confirm the choice.
Automatic travel detection never changes an active challenge's time zone.

A time zone change applies only to task windows that have not started.
It does not alter completed, failed, paused, or currently active task days.
The rules for changing time zone mid-challenge must be shown before the user starts.

## Deposit and Forfeiture

The deposit is locked when the challenge begins and stays unavailable until the challenge succeeds or fails.
There is no early withdrawal.

A forfeited deposit is distributed:

| Share | Destination |
|---|---|
| 20% | Platform maintenance |
| 80% | Donated to charity |

The donation policy should be transparent and publicly documented.

## Grace Recovery

Each account receives exactly one lifetime Emergency Recovery, which never replenishes.

Spending it on a failed challenge reverses the failure: the challenge continues, the missed day is forgiven, and the Emergency Recovery is permanently consumed.

## Future Expansion

Later versions may support other commitment-based habits: exercise, reading, meditation, studying, walking, limiting social media, and daily journaling.

The long-term vision is a general-purpose commitment contract platform where users can put meaningful financial accountability behind any habit.
