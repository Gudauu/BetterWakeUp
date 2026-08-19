/**
 * The other end of the morning's window.
 *
 * A completion is refused when its observation falls outside the task's own
 * local day, and the open task is the next morning's from the moment this one
 * is kept - so "can this walk be walked now" is a question with two wrong
 * answers, and home had been giving the second one.
 */

import {
  localDate,
  walkedTodayText,
  walkOpensText,
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

describe("what a walk that has not opened is told", () => {
  const tomorrow = { opensLater: true, opensTomorrow: true, walkedToday: true };
  const later = { opensLater: true, opensTomorrow: false, walkedToday: false };

  it("names tomorrow as a word and its deadline as a time", () => {
    expect(walkOpensText(tomorrow, "Wednesday, September 2", "7:00 AM")).toBe(
      "This one opens tomorrow morning and has to be walked then, by 7:00 AM. Steps taken before it opens cannot count for it.",
    );
  });

  it("names a further day by its date", () => {
    expect(walkOpensText(later, "Monday, September 7", "7:00 AM")).toContain(
      "opens on Monday, September 7",
    );
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
