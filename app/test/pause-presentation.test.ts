/**
 * The pause derivation.
 *
 * Half of issue 33's acceptance boundary lives here: a paused challenge is
 * never presented as if it were running, which is a property of this function
 * rather than of any layout, and the task pausing would skip is named from the
 * server's own cutoff instead of guessed.
 */

import { MAXIMUM_PAUSE_DAYS } from "@betterwakeup/contract";
import {
  PAUSE_EXPIRY_WARNING_DAYS,
  pausedForSentence,
  pausedRestSentence,
  pauseExpirySentence,
  pausePresentation,
} from "../src/challenges/pause.ts";
import { challengeView, taskView } from "./support/fake-api.ts";

const NOW = new Date("2026-09-01T13:00:00.000Z");

describe("pausePresentation while running", () => {
  it("names the task a pause would skip when its cutoff is still ahead", () => {
    const view = pausePresentation({
      challenge: challengeView({
        currentTask: taskView({ pauseCutoff: "2026-09-01T18:00:00.000Z" }),
      }),
      now: NOW,
    });

    expect(view.running).toBe(true);
    expect(view.nextSkippedTask?.date).toBe("2026-09-01");
    expect(view.cutoffPassed).toBe(false);
  });

  it("names no task once the cutoff has passed, and says why", () => {
    const view = pausePresentation({
      challenge: challengeView({
        currentTask: taskView({ pauseCutoff: "2026-09-01T06:00:00.000Z" }),
      }),
      now: NOW,
    });

    expect(view.nextSkippedTask).toBeNull();
    expect(view.cutoffPassed).toBe(true);
  });

  it("treats a cutoff exactly at the current instant as passed", () => {
    const view = pausePresentation({
      challenge: challengeView({
        currentTask: taskView({ pauseCutoff: NOW.toISOString() }),
      }),
      now: NOW,
    });

    expect(view.cutoffPassed).toBe(true);
  });

  it("names nothing and blames no cutoff when there is no open task", () => {
    const view = pausePresentation({ challenge: challengeView({ currentTask: null }), now: NOW });

    expect(view.nextSkippedTask).toBeNull();
    expect(view.cutoffPassed).toBe(false);
  });

  it("reports no pause age or expiry while running", () => {
    const view = pausePresentation({ challenge: challengeView(), now: NOW });

    expect(view.pausedDays).toBeNull();
    expect(view.daysUntilExpiry).toBeNull();
    expect(view.expiryWarning).toBe(false);
  });
});

describe("pausePresentation while paused", () => {
  const paused = (pausedAt: string, expiresAt: string | null, currentTask = taskView()) =>
    challengeView({ pause: { pausedAt, expiresAt }, currentTask });

  it("reports the challenge as not running and names no skippable task", () => {
    const view = pausePresentation({
      challenge: paused("2026-08-01T00:00:00.000Z", "2027-08-01T00:00:00.000Z"),
      now: NOW,
    });

    expect(view.running).toBe(false);
    // A task is still on the challenge view; a paused challenge must not offer
    // it as something a pause is about to skip.
    expect(view.nextSkippedTask).toBeNull();
  });

  it("counts whole days since the pause began", () => {
    const view = pausePresentation({
      challenge: paused("2026-08-30T01:00:00.000Z", null),
      now: NOW,
    });

    expect(view.pausedDays).toBe(2);
  });

  it("warns once the year is within the warning window", () => {
    const view = pausePresentation({
      challenge: paused("2025-09-15T13:00:00.000Z", "2026-09-15T13:00:00.000Z"),
      now: NOW,
    });

    expect(view.daysUntilExpiry).toBe(14);
    expect(view.expiryWarning).toBe(true);
  });

  it("stays quiet while the year is far away", () => {
    const view = pausePresentation({
      challenge: paused("2026-08-01T00:00:00.000Z", "2027-08-01T00:00:00.000Z"),
      now: NOW,
    });

    expect(view.expiryWarning).toBe(false);
  });

  it("warns at the boundary of the window", () => {
    const expiresAt = new Date(
      NOW.getTime() + PAUSE_EXPIRY_WARNING_DAYS * 86_400_000,
    ).toISOString();
    const view = pausePresentation({
      challenge: paused("2025-10-01T13:00:00.000Z", expiresAt),
      now: NOW,
    });

    expect(view.daysUntilExpiry).toBe(PAUSE_EXPIRY_WARNING_DAYS);
    expect(view.expiryWarning).toBe(true);
  });
});

describe("pauseExpirySentence", () => {
  it("states the outcome and asks for nothing", () => {
    const sentence = pauseExpirySentence(5);

    expect(sentence).toContain("In 5 days");
    expect(sentence).toContain(`${MAXIMUM_PAUSE_DAYS} days`);
    expect(sentence).toContain("neither a success nor a failure");
    expect(sentence).not.toMatch(/\b(must|should|hurry|act now)\b/i);
  });

  it("reads naturally on the last day", () => {
    expect(pauseExpirySentence(0)).toMatch(/^Today /);
    expect(pauseExpirySentence(1)).toMatch(/^Tomorrow /);
  });
});

describe("pausedForSentence", () => {
  it("says today rather than zero days for a pause set this morning", () => {
    expect(pausedForSentence(0)).toBe("Paused since today.");
    expect(pausedForSentence(null)).toBe("Paused since today.");
    // A pause the clock has not caught up with yet still reads as today.
    expect(pausedForSentence(-1)).toBe("Paused since today.");
  });

  it("counts whole days, singular and plural", () => {
    expect(pausedForSentence(1)).toBe("Paused for 1 day.");
    expect(pausedForSentence(12)).toBe("Paused for 12 days.");
  });
});

describe("pausedRestSentence", () => {
  it("says the challenge never resumes itself, and that nothing will ring", () => {
    const sentence = pausedRestSentence(false);

    expect(sentence).toContain("never starts again on its own");
    expect(sentence).toContain("no alarm will sound");
    expect(sentence).toContain("resume");
  });

  it("stops promising that no deadline counts while a task stayed live", () => {
    // A task past its pause cutoff runs through the pause, so the promise the
    // other sentence makes would be a lie about the one day that still counts.
    const sentence = pausedRestSentence(true);

    expect(sentence).toContain("its deadline still counts");
    expect(sentence).not.toContain("No deadline counts");
    expect(sentence).toContain("never starts again on its own");
  });
});
