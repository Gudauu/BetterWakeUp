/**
 * What a created challenge came to, said back from the challenge the server
 * made.
 *
 * The press that starts a challenge commits the user to a month of mornings and
 * on the funded path to a hold on their card, and the app used to answer it by
 * closing the screen. These pin the four things the answer has to carry: which
 * morning is first and how long is left on it, what a morning asks for, how
 * long the whole thing runs, and what is at stake.
 */

import { creationResult } from "../src/challenges/creation-outcome.ts";
import { challengeView, taskView } from "./support/fake-api.ts";

/** Well ahead of the fixture task's 14:00Z deadline, so the morning is not urgent. */
const NOW = new Date("2026-09-01T04:00:00.000Z");

const started = challengeView({ currentTask: taskView() });

describe("the first morning", () => {
  it("is named with the date and the time it is due, in the challenge's own zone", () => {
    const result = creationResult({ challenge: started, now: NOW });

    expect(result.first).toContain("Tuesday, September 1");
    // 14:00Z read in America/Los_Angeles.
    expect(result.first).toContain("7:00");
    expect(result.first).not.toContain("2026-09-01T14:00");
  });

  it("counts the deadline down from the task's own instant", () => {
    const result = creationResult({ challenge: started, now: NOW });

    expect(result.countdown?.minutes).toBe(600);
    expect(result.countdown?.urgency).toBe("ample");
  });

  it("reads as closing once the first deadline is inside the alarm's own lead", () => {
    // Set up at 6:30 in the morning, which is what a challenge made at bedtime
    // in a western zone looks like by the time the first deadline lands.
    const result = creationResult({
      challenge: started,
      now: new Date("2026-09-01T13:30:00.000Z"),
    });

    expect(result.countdown?.urgency).toBe("closing");
    expect(result.countdown?.sentence).toMatch(/30 minutes/);
  });

  it("says no morning is live yet rather than nothing, when none is", () => {
    // The server materializes every day at activation, but the first scheduled
    // one can still be ahead of the day the challenge was made on.
    const result = creationResult({
      challenge: challengeView({ currentTask: null }),
      now: NOW,
    });

    expect(result.first).toMatch(/No morning is live yet/);
    expect(result.countdown).toBeNull();
  });
});

describe("what was taken on", () => {
  it("states the step target and that a late walk counts for nothing", () => {
    const result = creationResult({ challenge: started, now: NOW });

    expect(result.proof).toContain("250 steps");
    expect(result.proof).toMatch(/once the deadline has passed/);
  });

  it("counts a one step target as one step", () => {
    const challenge = challengeView({
      configuration: { ...challengeView().configuration, stepTarget: 1 },
    });

    expect(creationResult({ challenge, now: NOW }).proof).toContain("1 step ");
  });

  it("names the number of mornings, the end date, and what a pause does to it", () => {
    const result = creationResult({ challenge: started, now: NOW });

    expect(result.length).toContain("30 mornings");
    expect(result.length).toContain("Monday, October 12");
    expect(result.length).toMatch(/one day later/);
  });

  it("words a single morning as one, and promises no pause arithmetic for it", () => {
    const challenge = challengeView({
      progress: { ...challengeView().progress, requiredTaskCount: 1 },
    });

    expect(creationResult({ challenge, now: NOW }).length).toMatch(/one morning in all/);
    expect(creationResult({ challenge, now: NOW }).length).not.toMatch(/never pause/);
  });
});

describe("what is at stake", () => {
  it("says the hold is a hold, and names the one thing that would take it", () => {
    const funded = challengeView({
      configuration: {
        ...challengeView().configuration,
        deposit: { amount: 2000, currency: "USD" },
      },
    });

    const result = creationResult({ challenge: funded, now: NOW });

    expect(result.stake).toContain("$20.00");
    expect(result.stake).toMatch(/held on your card, not charged/);
    expect(result.stake).toMatch(/only if this challenge ends short/);
  });

  it("says nothing can be charged when nothing was staked", () => {
    const result = creationResult({ challenge: started, now: NOW });

    expect(result.stake).toMatch(/Nothing is staked/);
    expect(result.stake).not.toContain("$");
  });
});

describe("the reminders", () => {
  it("states the two leads as a condition rather than as a promise", () => {
    const result = creationResult({ challenge: started, now: NOW });

    // The alarms only exist on a phone that has allowed notifications, so the
    // sentence must not read as one that is already set.
    expect(result.reminders).toMatch(/Once notifications are allowed/);
    expect(result.reminders).toContain("45 minutes");
    expect(result.reminders).toContain("10 minutes");
  });
});
