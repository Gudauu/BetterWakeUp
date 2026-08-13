# BetterWakeUp (Working Name)

## Vision

Help people build difficult habits by creating real financial accountability.

Instead of rewarding users for success, users voluntarily lock up their own money. If they successfully complete every day's commitment until the end of the challenge, they receive all of their money back. If they fail even once, the commitment is forfeited.

The goal is not to make money from users failing, but to make the cost of failure feel real enough that users are motivated to follow through.

---

# Core User Flow

1. User creates a challenge.
2. User chooses:
   - Goal (Wake up early)
   - Wake-up deadline (e.g. 9:00 AM)
   - Challenge duration (e.g. 30 days, 90 days, 1 year)
   - Deposit amount (e.g. $20)
3. User deposits the money.
4. Every day before the deadline, the user opens the app and keeps it open until both daily checks are complete:
   - The verification task is completed on the device.
   - The result is synchronized to and acknowledged by the server.
5. If every day receives both checks until the challenge ends:
   - 100% of the deposit is returned.
6. If either check is missing at the deadline:
   - The challenge immediately ends.
   - The deposit is forfeited.

---

# First Goal

Wake Up Early

User specifies:

- Wake-up deadline
- Daily movement target

Example:

Wake up before 9:00 AM.

Before 9:00 AM, the app must detect at least 200 meters of movement.

The user must open the app before 9:00 AM.

While open, the app:

- Evaluates the movement recorded on the device.
- Stores the local completion result.
- Finds any unsynchronized results.
- Sends them to the server.
- Keeps retrying while the app remains open until the server acknowledges them.

The app shows two separate checks:

- Task completed on this device.
- Result synchronized with the server.

Today's requirement is complete only when both checks appear before the deadline.

---

# Challenge Structure

Example:

Duration:
90 days

Deposit:
$20

Requirements:

Complete the wake-up verification every single day.

Missing either the local completion check or the server synchronization check on any day ends the challenge.

No partial refunds.

---

# Completion and Synchronization Policy

Daily completion has two required parts.

## 1. Local Task Completion

The device evaluates whether the user completed the movement target before the deadline.

The app records this result locally before attempting to synchronize it.

## 2. Server Synchronization

The server must receive and acknowledge the local result before the same deadline.

A locally completed task that has not been acknowledged by the server does not count as a completed daily requirement.

The user is responsible for opening the app early enough and keeping it open until the synchronization check appears.

The app must make the synchronization state obvious and must not show the day as fully complete while synchronization is pending.

The app automatically retries unsynchronized results whenever it is open.

Mobile background execution is not required for task completion or synchronization.

## Network and Device Responsibility

Network delivery cannot be guaranteed in every environment.

Before accepting a challenge, the app must clearly explain that:

- Local task completion alone is insufficient.
- The server synchronization check is required before the deadline.
- A poor or unavailable connection can prevent synchronization.
- Closing the app before acknowledgment can leave the result unsynchronized.
- The user is responsible for confirming that both checks appear.

The interface should warn the user when the deadline is near and synchronization is still pending.

---

# Time Zone Policy

The user confirms a time zone when creating a challenge.

The schedule continues to use that time zone until the user explicitly changes it.

The app may suggest the device's current time zone, but the user must confirm the choice.

Automatic travel detection does not change an active challenge's time zone.

The rules for changing the time zone during an active challenge must be shown before the user starts the challenge.

---

# Deposit Rules

The entire deposit is locked when the challenge begins.

The money remains unavailable until either:

- The challenge is completed successfully.
- The challenge fails.

Users cannot withdraw early.

Users cannot reduce the commitment after starting.

---

# Failed Challenge

When a challenge fails because either daily check is missing at the deadline:

Deposit is permanently forfeited.

Distribution:

20%
Platform maintenance

80%
Donated to charity

The donation policy should be transparent and publicly documented.

---

# Grace Recovery

Each account receives one lifetime Emergency Recovery.

If a challenge fails:

The user may spend their Emergency Recovery to reverse the failure.

Effects:

- The challenge continues.
- The missed day is forgiven.
- The Emergency Recovery is permanently consumed.

Each account receives exactly one.

It never replenishes.

---

# Business Philosophy

The product is not gambling.

The outcome is entirely determined by the user's own actions.

Users voluntarily enter a commitment contract.

The money is not a prize.

It is collateral for completing a self-selected goal.

---

# Success Metric

A successful user is one who gets all of their own money back.

The platform should encourage users to succeed rather than profit from failure.

The business model should emphasize accountability, trust, and habit formation.

---

# Future Expansion

The first version focuses only on waking up early.

Later versions may support additional commitment-based habits, such as:

- Exercise
- Reading
- Meditation
- Studying
- Walking
- Limiting social media
- Daily journaling

The long-term vision is to become a general-purpose commitment contract platform where users can put meaningful financial accountability behind any habit.