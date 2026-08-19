/**
 * The morning that just counted.
 *
 * The defect these tests pin is the sentence a user read after every walk: the
 * screen promised a morning "tomorrow" on a challenge whose next one could be
 * four days out, because it never looked at the challenge's own calendar.
 */

import {
  acknowledgedAtText,
  keptMorningText,
  nextMorningAfter,
} from "../src/completions/kept-morning.ts";
import { challengeView, taskView } from "./support/fake-api.ts";

const KEPT = taskView({ date: "2026-09-01", status: "completed" });

/** The fixture's calendar, with a stated status per day from 2026-09-01. */
function days(...statuses: ReadonlyArray<"scheduled" | "completed" | "missed" | "skipped">) {
  const start = Date.UTC(2026, 8, 1);
  return statuses.map((status, index) => ({
    date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
    status,
  }));
}

describe("the morning after the one just kept", () => {
  it("is the next day the challenge still holds, named as tomorrow", () => {
    const next = nextMorningAfter(
      challengeView({
        days: days("completed", "scheduled", "scheduled"),
        configuration: {
          ...challengeView().configuration,
          schedule: [{ weekday: "wednesday", deadline: "07:30" }],
        },
      }),
      KEPT,
    );

    expect(next).toEqual({ date: "2026-09-02", tomorrow: true, deadline: "07:30" });
  });

  it("skips days that are already behind the user and is then not tomorrow", () => {
    // A weekday challenge kept on the Friday: the next morning it holds is the
    // Monday, and the screen had been saying "tomorrow" for exactly this case.
    const next = nextMorningAfter(
      challengeView({
        days: days("completed", "skipped", "missed", "scheduled"),
      }),
      KEPT,
    );

    expect(next).toEqual({ date: "2026-09-04", tomorrow: false, deadline: null });
  });

  it("answers nothing when the challenge holds no morning after this one", () => {
    expect(nextMorningAfter(challengeView({ days: days("completed") }), KEPT)).toBeNull();
    expect(nextMorningAfter(challengeView({ days: [] }), KEPT)).toBeNull();
  });

  it("reads the deadline off the schedule for that day's own weekday", () => {
    const next = nextMorningAfter(
      challengeView({
        days: days("completed", "scheduled"),
        configuration: {
          ...challengeView().configuration,
          schedule: [
            { weekday: "monday", deadline: "07:00" },
            { weekday: "wednesday", deadline: "08:15" },
          ],
        },
      }),
      KEPT,
    );

    expect(next?.deadline).toBe("08:15");
  });
});

describe("what the screen says about a kept day", () => {
  it("names tomorrow as a word, with the time it is due", () => {
    expect(keptMorningText({ date: "2026-09-02", tomorrow: true, deadline: "07:30" })).toBe(
      "This day is yours. The next morning is tomorrow, Wednesday, September 2, by 7:30 AM.",
    );
  });

  it("leaves the time out rather than inventing one the schedule does not name", () => {
    expect(keptMorningText({ date: "2026-09-02", tomorrow: true, deadline: null })).toBe(
      "This day is yours. The next morning is tomorrow, Wednesday, September 2.",
    );
  });

  it("says nothing is due until the day it is, when that is not tomorrow", () => {
    expect(keptMorningText({ date: "2026-09-07", tomorrow: false, deadline: "07:00" })).toBe(
      "This day is yours. Nothing is due until Monday, September 7, by 7:00 AM.",
    );
  });

  it("promises no morning at all when the challenge holds none", () => {
    expect(keptMorningText(null)).toBe(
      "This day is yours. No more mornings are scheduled on this challenge.",
    );
  });
});

describe("the acknowledgment receipt", () => {
  it("reads the instant the server accepted it in the challenge's own zone", () => {
    expect(
      acknowledgedAtText(
        taskView({ status: "completed", acknowledgedAt: "2026-09-01T13:00:01.000Z" }),
        "America/Los_Angeles",
      ),
    ).toBe("The server accepted this walk at 6:00 AM.");
  });

  it("says nothing about a walk the server has not acknowledged", () => {
    expect(
      acknowledgedAtText(taskView({ acknowledgedAt: null }), "America/Los_Angeles"),
    ).toBeNull();
  });
});
