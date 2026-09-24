/**
 * The other end of the morning's window.
 *
 * A completion is refused when its walk started before the task's `opensAt`,
 * and the open task is the next morning's from the moment this one is kept -
 * so "can this walk be walked now" is a question with two wrong answers, and
 * the answer has to come from the instant rather than from the task's date.
 */

import {
  hasOpened,
  localDate,
  opensAtText,
  walkedTodayText,
  walkWindow,
} from "../src/challenges/walk-window.ts";
import { challengeDays, challengeView, taskView } from "./support/fake-api.ts";

/** Early evening in Los Angeles, which is already the next day in UTC. */
const EVENING = new Date("2026-09-02T03:00:00.000Z");

describe("what day it is where the challenge is", () => {
  it("reads the zone rather than UTC", () => {
    expect(localDate(EVENING, "America/Los_Angeles")).toBe("2026-09-01");
    expect(localDate(EVENING, "UTC")).toBe("2026-09-02");
  });

  it("answers nothing for a zone the runtime cannot read", () => {
    expect(localDate(EVENING, "Mars/Olympus")).toBeNull();
  });
});

describe("whether the walk on offer can be walked yet", () => {
  /** A challenge whose first day was kept, with the next morning's task open. */
  function afterTodaysWalk(currentTaskDate: string) {
    return challengeView({
      days: [
        { date: "2026-09-01", status: "completed" },
        ...challengeDays(3, "scheduled").slice(1),
      ],
      currentTask: taskView({
        date: currentTaskDate,
        deadline: `${currentTaskDate}T14:00:00.000Z`,
      }),
    });
  }

  it("says nothing about a challenge with no open task", () => {
    expect(walkWindow(challengeView(), EVENING)).toBeNull();
  });

  it("reads today's own task as open now", () => {
    const challenge = challengeView({ currentTask: taskView() });

    expect(walkWindow(challenge, EVENING)?.opensLater).toBe(false);
  });

  it("reads tomorrow's task as one that has not opened", () => {
    const window = walkWindow(afterTodaysWalk("2026-09-02"), EVENING);

    expect(window).toMatchObject({ opensLater: true, opensTomorrow: true, walkedToday: true });
  });

  it("keeps a day further out from being called tomorrow", () => {
    const window = walkWindow(afterTodaysWalk("2026-09-07"), EVENING);

    expect(window).toMatchObject({ opensLater: true, opensTomorrow: false });
  });

  it("does not claim today was walked when the calendar does not say so", () => {
    const challenge = challengeView({
      days: challengeDays(3, "scheduled"),
      currentTask: taskView({ date: "2026-09-02", deadline: "2026-09-02T14:00:00.000Z" }),
    });

    expect(walkWindow(challenge, EVENING)?.walkedToday).toBe(false);
  });
});

describe("the opening instant, not the date", () => {
  /** A 12:30 AM deadline with an hour's window: 11:30 PM the night before. */
  const LATE = taskView({
    date: "2026-09-02",
    opensAt: "2026-09-02T06:30:00.000Z",
    deadline: "2026-09-02T07:30:00.000Z",
  });

  it("is closed a millisecond before the opening and open at the opening itself", () => {
    expect(hasOpened(LATE, new Date("2026-09-02T06:29:59.999Z"))).toBe(false);
    expect(hasOpened(LATE, new Date("2026-09-02T06:30:00.000Z"))).toBe(true);
  });

  it("opens a walk at 11:30 PM on the date before its own", () => {
    const challenge = challengeView({ currentTask: LATE });

    // 11:29 PM on September 1 in Los Angeles: not yet, and it opens tonight.
    expect(walkWindow(challenge, new Date("2026-09-02T06:29:00.000Z"))).toMatchObject({
      opensLater: true,
      opensTomorrow: false,
    });
    // 11:30 PM on September 1, although the task is dated September 2.
    expect(walkWindow(challenge, new Date("2026-09-02T06:30:00.000Z"))?.opensLater).toBe(false);
  });

  it("names the opening against today", () => {
    const zone = "America/Los_Angeles";

    expect(opensAtText(LATE, zone, new Date("2026-09-02T01:00:00.000Z"))).toBe("today at 11:30 PM");
    expect(opensAtText(LATE, zone, new Date("2026-09-01T01:00:00.000Z"))).toBe(
      "tomorrow at 11:30 PM",
    );
  });

  it("reads the instant across a clock change, where the same wall time happens twice", () => {
    // Santiago falls back at midnight on April 5, 2026, so 11:30 PM on April 4
    // happens twice. A 12:30 AM deadline with an hour's window opens an hour of
    // real time before it: the second 11:30 PM, which is what the server sends.
    const task = taskView({
      date: "2026-04-05",
      opensAt: "2026-04-05T03:30:00.000Z",
      deadline: "2026-04-05T04:30:00.000Z",
    });
    const challenge = challengeView({
      configuration: { ...challengeView().configuration, timeZone: "America/Santiago" },
      currentTask: task,
    });

    // The first 11:30 PM is an hour too early.
    expect(walkWindow(challenge, new Date("2026-04-05T02:30:00.000Z"))?.opensLater).toBe(true);
    expect(opensAtText(task, "America/Santiago", new Date("2026-04-05T02:30:00.000Z"))).toBe(
      "today at 11:30 PM",
    );
    expect(walkWindow(challenge, new Date("2026-04-05T03:30:00.000Z"))?.opensLater).toBe(false);
  });

  it("reads an opening it cannot parse as open, since hiding the walk is what costs a morning", () => {
    expect(hasOpened(taskView({ opensAt: "not an instant" }), EVENING)).toBe(true);
  });
});

describe("what a morning already kept is told", () => {
  it("states the day as done when there is no run behind it", () => {
    expect(walkedTodayText(1)).toBe("Today's walk is done. Nothing else is due today.");
  });

  it("names the run once there is one", () => {
    expect(walkedTodayText(4)).toBe("Today's walk is done. That is 4 days in a row.");
  });
});
