/**
 * What pausing and resuming did, said back from the server's own answer.
 *
 * Both commands carry a task the app used to discard: the morning the pause
 * consumed, and the morning a resume put back in front of the user. The second
 * is the one that costs money, because resuming starts a deadline counting, so
 * these pin that the countdown is read from that task's own instant rather than
 * left to the user to discover.
 */

import { pauseResult, resumeResult } from "../src/challenges/pause-outcome.ts";
import { challengeView, taskView } from "./support/fake-api.ts";

const NOW = new Date("2026-09-01T13:00:00.000Z");

/** The fixture's pause: set, and bounded by the server's year. */
const paused = challengeView({
  pause: { pausedAt: "2026-09-01T12:00:00.000Z", expiresAt: "2027-09-01T12:00:00.000Z" },
  currentTask: null,
});

describe("pauseResult", () => {
  it("names the morning the pause consumed, the way a person says the date", () => {
    const result = pauseResult({ challenge: paused, nextSkippedTask: taskView() });

    expect(result.skipped).toContain("Tuesday, September 1");
    expect(result.skipped).not.toContain("2026-09-01");
    // A skip is not a miss, and the one thing a user pausing over money wants
    // to hear is that nothing was charged for it.
    expect(result.skipped).toMatch(/not a failure/);
  });

  it("says the pause still holds when it consumed no morning at all", () => {
    // `nextSkippedTask` is null when every scheduled cutoff had already passed.
    // That is not "the press did nothing", and the sentence must not read as it.
    const result = pauseResult({ challenge: paused, nextSkippedTask: null });

    expect(result.skipped).toMatch(/No morning was skipped/);
    expect(result.skipped).toMatch(/holds the days after them/);
  });

  it("states the end date and that it keeps moving while the pause stands", () => {
    const result = pauseResult({ challenge: paused, nextSkippedTask: taskView() });

    expect(result.ends).toContain("Monday, October 12");
    expect(result.ends).toMatch(/one day later for every day you stay paused/);
  });

  it("promises nothing is due only when no task stayed live through the pause", () => {
    expect(pauseResult({ challenge: paused, nextSkippedTask: null }).rest).toMatch(
      /No deadline counts/,
    );
    // A task past its own pause cutoff stays live, so the flat promise would be
    // wrong about the one day that can still be lost.
    const live = challengeView({
      pause: { pausedAt: "2026-09-01T12:00:00.000Z", expiresAt: null },
      currentTask: taskView(),
    });
    expect(pauseResult({ challenge: live, nextSkippedTask: null }).rest).toMatch(
      /its deadline still counts/,
    );
  });

  it("reads the year the pause runs to in the challenge's zone, not the machine's", () => {
    const result = pauseResult({ challenge: paused, nextSkippedTask: taskView() });

    // 12:00 UTC is 5:00 AM in the challenge's own zone.
    expect(result.expires).toContain("5:00 AM");
    expect(result.expires).toMatch(/neither a success nor a failure/);
  });

  it("says nothing about a year the server named no date for", () => {
    const unbounded = challengeView({
      pause: { pausedAt: "2026-09-01T12:00:00.000Z", expiresAt: null },
      currentTask: null,
    });

    expect(pauseResult({ challenge: unbounded, nextSkippedTask: null }).expires).toBeNull();
  });
});

describe("resumeResult", () => {
  const running = challengeView({ currentTask: taskView() });

  it("names the morning that is live again and when it is due", () => {
    const result = resumeResult({ challenge: running, nextLiveTask: taskView(), now: NOW });

    expect(result.live).toContain("Tuesday, September 1");
    // The deadline read where the challenge reads its deadlines: 14:00 UTC is
    // 7:00 AM in Los Angeles.
    expect(result.live).toContain("7:00 AM");
    expect(result.live).toMatch(/deadline counts again from now/);
  });

  it("counts that deadline down, because resuming is what started the clock", () => {
    const result = resumeResult({ challenge: running, nextLiveTask: taskView(), now: NOW });

    expect(result.countdown?.minutes).toBe(60);
    expect(result.countdown?.sentence).toMatch(/1 hour left to walk/);
  });

  it("reads a deadline inside the alarm's own lead as closing", () => {
    const result = resumeResult({
      challenge: running,
      nextLiveTask: taskView(),
      now: new Date("2026-09-01T13:30:00.000Z"),
    });

    expect(result.countdown?.urgency).toBe("closing");
  });

  it("counts nothing when the server put no morning back", () => {
    const result = resumeResult({ challenge: running, nextLiveTask: null, now: NOW });

    expect(result.countdown).toBeNull();
    expect(result.live).toMatch(/No morning is live yet/);
  });

  it("states where the challenge ends now that the days are counting again", () => {
    const result = resumeResult({ challenge: running, nextLiveTask: taskView(), now: NOW });

    expect(result.ends).toContain("Monday, October 12");
    expect(result.reminders).toMatch(/wake-up reminders are set again/);
  });
});
