/**
 * The month as a row of days.
 *
 * The row is the first thing on home that says anything about *which* mornings
 * went how, so the rules that decide it are pinned one at a time: where the day
 * being asked for right now sits, what continues a run and what ends one, and
 * what the row says to someone who is listening to it rather than looking.
 */

import type { ChallengeDay } from "@betterwakeup/contract";
import {
  challengeHistory,
  historyLabel,
  historyLegend,
  streakSentence,
} from "../src/challenges/history.ts";
import { challengeView } from "./support/fake-api.ts";

/** A challenge whose calendar is exactly these statuses, in order. */
function withDays(statuses: readonly ChallengeDay["status"][]) {
  return challengeView({
    days: statuses.map((status, index) => ({
      date: `2026-09-${String(index + 1).padStart(2, "0")}`,
      status,
    })),
  });
}

describe("the row of days", () => {
  it("draws a challenge that has not been materialized as no days at all", () => {
    const history = challengeHistory(challengeView({ days: [] }));

    expect(history.days).toEqual([]);
    expect(history.streak).toBe(0);
    expect(history.decided).toBe(0);
  });

  it("reads each day from the user's side, keeping the calendar's order", () => {
    const history = challengeHistory(
      withDays(["completed", "missed", "forgiven", "skipped", "scheduled", "scheduled"]),
    );

    expect(history.days.map((day) => day.state)).toEqual([
      "kept",
      "missed",
      "forgiven",
      "skipped",
      "due",
      "ahead",
    ]);
    expect(history.days[0]?.date).toBe("2026-09-01");
  });

  it("counts only the days already decided as behind the user", () => {
    const history = challengeHistory(withDays(["completed", "missed", "scheduled", "scheduled"]));

    expect(history.decided).toBe(2);
  });

  it("marks the next morning as due even when nothing is open on it", () => {
    // A paused challenge has no current task, and the row still has to say
    // which day the user comes back to.
    const history = challengeHistory(withDays(["completed", "scheduled", "scheduled"]));

    expect(history.days.map((day) => day.state)).toEqual(["kept", "due", "ahead"]);
  });
});

describe("the streak", () => {
  it("counts the walks in an unbroken run ending at the last decided day", () => {
    expect(challengeHistory(withDays(["completed", "completed", "scheduled"])).streak).toBe(2);
  });

  it("counts the current run rather than the best one", () => {
    // Ten kept, one missed, two kept: the ten are over, and congratulating
    // someone for them would be congratulating them for the wrong month.
    const statuses: ChallengeDay["status"][] = [
      ...Array.from({ length: 10 }, () => "completed" as const),
      "missed",
      "completed",
      "completed",
      "scheduled",
    ];

    expect(challengeHistory(withDays(statuses)).streak).toBe(2);
  });

  it("ends a run at a day that was not walked, however forgivingly it ended", () => {
    expect(challengeHistory(withDays(["completed", "forgiven"])).streak).toBe(0);
    expect(challengeHistory(withDays(["completed", "skipped"])).streak).toBe(0);
    expect(challengeHistory(withDays(["completed", "missed"])).streak).toBe(0);
  });

  it("is not disturbed by the days still ahead", () => {
    const history = challengeHistory(
      withDays(["completed", "completed", "scheduled", "scheduled", "scheduled"]),
    );

    expect(history.streak).toBe(2);
  });

  it("says nothing about a run of one, and speaks from two", () => {
    expect(streakSentence(challengeHistory(withDays(["completed", "scheduled"])))).toBeNull();
    expect(streakSentence(challengeHistory(withDays(["completed", "missed"])))).toBeNull();
    expect(streakSentence(challengeHistory(withDays(["completed", "completed"])))).toBe(
      "2 days in a row.",
    );
  });
});

describe("the row read aloud", () => {
  it("names the counts, leaving out the ones that did not happen", () => {
    const label = historyLabel(challengeHistory(withDays(["completed", "scheduled", "scheduled"])));

    expect(label).toBe("Your days: 1 kept, 2 still to come.");
  });

  it("names a missed day and a forgiven one when there are any", () => {
    const label = historyLabel(
      challengeHistory(withDays(["completed", "missed", "forgiven", "skipped", "scheduled"])),
    );

    expect(label).toBe("Your days: 1 kept, 1 missed, 1 forgiven, 1 skipped, 1 still to come.");
  });
});

describe("the key to the row", () => {
  it("names only the marks the row actually draws", () => {
    // Four days into a clean challenge there is no missed day and no forgiven
    // one. Naming them anyway would read as a list of things that happened.
    const legend = historyLegend(
      challengeHistory(withDays(["completed", "scheduled", "scheduled"])),
    );

    expect(legend.map((entry) => entry.label)).toEqual(["Walked", "Due now", "Still to come"]);
  });

  it("names every outcome once the challenge has had them", () => {
    const legend = historyLegend(
      challengeHistory(withDays(["completed", "missed", "forgiven", "skipped", "scheduled"])),
    );

    expect(legend.map((entry) => entry.state)).toEqual([
      "kept",
      "missed",
      "forgiven",
      "skipped",
      "due",
    ]);
  });

  it("reads a skipped day back as the pause that caused it", () => {
    // "Skipped" is what the sweep did. The user paused, and never chose to skip
    // anything.
    const legend = historyLegend(challengeHistory(withDays(["skipped", "scheduled"])));

    expect(legend.map((entry) => entry.label)).toContain("Paused");
    expect(legend.map((entry) => entry.label)).not.toContain("Skipped");
  });

  it("has nothing to explain about a challenge with no days", () => {
    expect(historyLegend(challengeHistory(challengeView({ days: [] })))).toEqual([]);
  });
});
