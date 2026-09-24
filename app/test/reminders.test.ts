/**
 * What the device is asked to wake the user for.
 *
 * These are the rules a missed morning turns on: a reminder is scheduled for
 * the task the server actually handed over, it disappears the moment that task
 * stops being live, and it never fires for a challenge that is paused or over.
 */

import { nextAlarmAt, RECOVERY_LEAD_MINUTES, remindersFor } from "../src/reminders/reminders.ts";
import { challengeView, taskView } from "./support/fake-api.ts";

/** Well before the fixture's 7:00 AM Los Angeles deadline. */
const NIGHT_BEFORE = new Date("2026-08-31T20:00:00.000Z");

/** The walk opens ten minutes before its 7:00 AM deadline. */
const OPENS_AT = "2026-09-01T13:50:00.000Z";

const RUNNING = challengeView({ currentTask: taskView({ opensAt: OPENS_AT }) });

describe("what a running challenge asks to be reminded of", () => {
  it("sets one reminder per walk, exactly at the instant the server says it opens", () => {
    const reminders = remindersFor(RUNNING, NIGHT_BEFORE);

    expect(reminders.map((reminder) => reminder.at)).toEqual([OPENS_AT]);
  });

  it("follows a walk that opens the evening before its date", () => {
    // A 12:30 AM deadline with an hour's window opens at 11:30 PM the night
    // before; the reminder rings then, not at some time on the task's own date.
    const late = challengeView({
      currentTask: taskView({
        date: "2026-09-02",
        opensAt: "2026-09-02T06:30:00.000Z",
        deadline: "2026-09-02T07:30:00.000Z",
      }),
    });

    expect(remindersFor(late, NIGHT_BEFORE).map((reminder) => reminder.at)).toEqual([
      "2026-09-02T06:30:00.000Z",
    ]);
  });

  it("names the step target and the deadline in the challenge's own zone", () => {
    // The user reads this half asleep, from a lock screen: the two things worth
    // carrying are how many steps and by when, in the time they set.
    const [reminder] = remindersFor(RUNNING, NIGHT_BEFORE);

    expect(reminder?.title).toBe("Your walk is open");
    expect(reminder?.body).toBe("250 steps by 7:00 AM. Open BetterWakeUp and walk.");
  });

  it("identifies the reminder by the task it belongs to", () => {
    // The scheduled set is replaced whole on every read of the challenge, so a
    // stable identifier is what keeps a second read from stacking a duplicate.
    const ids = remindersFor(RUNNING, NIGHT_BEFORE).map((reminder) => reminder.id);

    expect(ids).toEqual(["44444444-4444-4444-8444-444444444444:opens"]);
  });

  it("says what tapping it should open, since the tap may launch the app", () => {
    // The point of the reminder is the walk. Working out where to send someone
    // from the notification alone is only possible if the notification carries
    // it: a tap on a locked phone starts the app knowing nothing at all.
    expect(remindersFor(RUNNING, NIGHT_BEFORE).map((reminder) => reminder.opens)).toEqual(["walk"]);
  });

  it("drops the reminder once the walk has opened", () => {
    expect(remindersFor(RUNNING, new Date(OPENS_AT))).toEqual([]);
    expect(remindersFor(RUNNING, new Date(Date.parse(OPENS_AT) - 1))).toHaveLength(1);
  });
});

describe("what is never reminded about", () => {
  it("says nothing for an account with no challenge", () => {
    expect(remindersFor(null, NIGHT_BEFORE)).toEqual([]);
  });

  it("says nothing while the challenge is paused", () => {
    // Nothing is due, so a 6:50 AM alarm would be waking someone for a walk the
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

describe("the reminder the challenge page names", () => {
  it("is the instant the walk opens, whatever the clock says", () => {
    // The challenge page shows this beside the switch, so it has to describe
    // the setting rather than appear and disappear as the walk opens.
    expect(nextAlarmAt(RUNNING)).toBe(OPENS_AT);
  });

  it("is absent when there is nothing to be woken for", () => {
    expect(nextAlarmAt(challengeView({ currentTask: null }))).toBeNull();
  });
});
