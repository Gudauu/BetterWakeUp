/**
 * What the device is asked to wake the user for.
 *
 * These are the rules a missed morning turns on: a reminder is scheduled for
 * the task the server actually handed over, it disappears the moment that task
 * stops being live, and it never fires for a challenge that is paused or over.
 */

import {
  ALARM_LEAD_MINUTES,
  LAST_CALL_LEAD_MINUTES,
  nextAlarmAt,
  RECOVERY_LEAD_MINUTES,
  remindersFor,
} from "../src/reminders/reminders.ts";
import { challengeView, taskView } from "./support/fake-api.ts";

/** Well before the fixture's 7:00 AM Los Angeles deadline. */
const NIGHT_BEFORE = new Date("2026-08-31T20:00:00.000Z");

const RUNNING = challengeView({ currentTask: taskView() });

describe("what a running challenge asks to be reminded of", () => {
  it("sets an alarm before the deadline and a last call after it", () => {
    const reminders = remindersFor(RUNNING, NIGHT_BEFORE);

    expect(reminders.map((reminder) => reminder.at)).toEqual([
      "2026-09-01T13:15:00.000Z",
      "2026-09-01T13:50:00.000Z",
    ]);
    expect(ALARM_LEAD_MINUTES).toBe(45);
    expect(LAST_CALL_LEAD_MINUTES).toBe(10);
  });

  it("names the step target and the deadline in the challenge's own zone", () => {
    // The user reads this half asleep, from a lock screen: the two things worth
    // carrying are how many steps and by when, in the time they set.
    const [alarm, lastCall] = remindersFor(RUNNING, NIGHT_BEFORE);

    expect(alarm?.body).toBe("250 steps by 7:00 AM. Open BetterWakeUp and walk.");
    expect(lastCall?.title).toBe("Last call - 7:00 AM");
    expect(lastCall?.body).toBe("10 minutes left to walk your 250 steps.");
  });

  it("identifies each reminder by the task it belongs to", () => {
    // The scheduled set is replaced whole on every read of the challenge, so a
    // stable identifier is what keeps a second read from stacking a duplicate.
    const ids = remindersFor(RUNNING, NIGHT_BEFORE).map((reminder) => reminder.id);

    expect(ids).toEqual([
      "44444444-4444-4444-8444-444444444444:alarm",
      "44444444-4444-4444-8444-444444444444:last-call",
    ]);
  });

  it("says what tapping it should open, since the tap may launch the app", () => {
    // The point of the alarm is the walk. Working out where to send someone
    // from the notification alone is only possible if the notification carries
    // it: a tap on a locked phone starts the app knowing nothing at all.
    expect(remindersFor(RUNNING, NIGHT_BEFORE).map((reminder) => reminder.opens)).toEqual([
      "walk",
      "walk",
    ]);
  });

  it("drops a reminder whose moment has already passed", () => {
    // Between the two leads: the alarm is behind us and the last call is not.
    const reminders = remindersFor(RUNNING, new Date("2026-09-01T13:30:00.000Z"));

    expect(reminders.map((reminder) => reminder.id)).toEqual([
      "44444444-4444-4444-8444-444444444444:last-call",
    ]);
  });
});

describe("what is never reminded about", () => {
  it("says nothing for an account with no challenge", () => {
    expect(remindersFor(null, NIGHT_BEFORE)).toEqual([]);
  });

  it("says nothing while the challenge is paused", () => {
    // Nothing is due, so a 6:15 AM alarm would be waking someone for a walk the
    // server is not judging them on.
    const paused = challengeView({
      currentTask: taskView(),
      pause: { pausedAt: "2026-08-30T00:00:00.000Z", expiresAt: "2027-08-30T00:00:00.000Z" },
    });

    expect(remindersFor(paused, NIGHT_BEFORE)).toEqual([]);
  });

  it("says nothing about a task that is no longer scheduled", () => {
    const done = challengeView({ currentTask: taskView({ status: "completed" }) });

    expect(remindersFor(done, NIGHT_BEFORE)).toEqual([]);
  });

  it("says nothing for a challenge that has ended", () => {
    const over = challengeView({ status: "succeeded", currentTask: taskView() });

    expect(remindersFor(over, NIGHT_BEFORE)).toEqual([]);
  });
});

describe("the recovery offer", () => {
  it("is reminded about before it expires, because it decides the deposit", () => {
    const offered = challengeView({
      status: "recovery_pending",
      currentTask: null,
      recoveryOffer: {
        taskId: "44444444-4444-4444-8444-444444444444",
        offeredAt: "2026-09-01T15:00:00.000Z",
        expiresAt: "2026-09-02T14:00:00.000Z",
      },
    });

    const reminders = remindersFor(offered, NIGHT_BEFORE);

    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.id).toBe("44444444-4444-4444-8444-444444444444:recovery");
    expect(reminders[0]?.at).toBe("2026-09-02T13:00:00.000Z");
    expect(reminders[0]?.body).toBe("Decide before 7:00 AM or the missed day stands.");
    // The decision, not the walk: there is no open task to walk for.
    expect(reminders[0]?.opens).toBe("recovery");
    expect(RECOVERY_LEAD_MINUTES).toBe(60);
  });
});

describe("the alarm home names", () => {
  it("is the instant the first reminder would fire, whatever the clock says", () => {
    // Home shows this under the next walk, so it has to describe the setting
    // rather than appear and disappear as the deadline passes.
    expect(nextAlarmAt(RUNNING)).toBe("2026-09-01T13:15:00.000Z");
  });

  it("is absent when there is nothing to be woken for", () => {
    expect(nextAlarmAt(challengeView({ currentTask: null }))).toBeNull();
  });
});
