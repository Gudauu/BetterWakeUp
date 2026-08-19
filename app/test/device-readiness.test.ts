/**
 * Reading this phone as what the setup screen has to do about it.
 *
 * The rules are here; what a screen draws for each answer is pinned in the
 * setup screen's own suite.
 */

import {
  canStartChallengeOn,
  MOVEMENT_READINESS_NOTICE,
  type MovementReadiness,
  readinessForPermission,
  runningMovementNotice,
} from "../src/movement/device-readiness.ts";

describe("the standing permission read as an answer", () => {
  it("separates the one the app can ask for from the one only Settings changes", () => {
    expect(readinessForPermission("granted")).toBe("ready");
    expect(readinessForPermission("undetermined")).toBe("askable");
    expect(readinessForPermission("denied")).toBe("refused");
  });
});

describe("whether a challenge may be started", () => {
  it("stops only a phone with no step counter", () => {
    expect(canStartChallengeOn("unsupported")).toBe(false);

    for (const readiness of [
      "checking",
      "ready",
      "askable",
      "refused",
      "unknown",
    ] as MovementReadiness[]) {
      // A refused permission can be turned on before the first morning, and a
      // device that would not answer is not evidence of anything.
      expect(canStartChallengeOn(readiness)).toBe(true);
    }
  });
});

describe("what each answer says", () => {
  it("raises its voice with the cost of the answer", () => {
    expect(MOVEMENT_READINESS_NOTICE.ready.tone).toBe("info");
    expect(MOVEMENT_READINESS_NOTICE.askable.tone).toBe("info");
    expect(MOVEMENT_READINESS_NOTICE.refused.tone).toBe("warning");
    expect(MOVEMENT_READINESS_NOTICE.unsupported.tone).toBe("danger");
  });

  it("tells a phone with no step counter what to do instead", () => {
    // Otherwise the sentence is a dead end: there is no press on this device
    // that fixes a missing sensor.
    expect(MOVEMENT_READINESS_NOTICE.unsupported.text).toMatch(/Sign in on a phone/);
  });
});

describe("what a running challenge's owner is told", () => {
  it("says nothing about a phone that can count a walk", () => {
    expect(runningMovementNotice("ready")).toBeNull();
    // A state that resolves in a moment is not worth drawing.
    expect(runningMovementNotice("checking")).toBeNull();
  });

  it("stays quiet about a read that would not answer", () => {
    // The deposit is already staked, so there is nothing to decide, and this is
    // also the answer a build with no sensor module gives - a warning nobody
    // could ever clear.
    expect(runningMovementNotice("unknown")).toBeNull();
  });

  it("speaks up for every phone that cannot count one", () => {
    for (const readiness of ["askable", "refused", "unsupported"] as MovementReadiness[]) {
      expect(runningMovementNotice(readiness)).not.toBeNull();
    }
  });

  it("is louder than the same answer given before any money was staked", () => {
    // At setup a refused permission is a warning about a decision not yet
    // taken; here the deposit is held and the days are counting.
    expect(MOVEMENT_READINESS_NOTICE.refused.tone).toBe("warning");
    expect(runningMovementNotice("refused")?.tone).toBe("danger");
    expect(MOVEMENT_READINESS_NOTICE.askable.tone).toBe("info");
    expect(runningMovementNotice("askable")?.tone).toBe("warning");
  });

  it("names the morning rather than the decision the user has already made", () => {
    // The setup wording points at a first morning and at whether to start at
    // all; neither is the question once a challenge is running.
    expect(runningMovementNotice("refused")?.text).toMatch(/before your next deadline/);
    expect(runningMovementNotice("askable")?.text).toMatch(/before your next morning/);
    expect(runningMovementNotice("unsupported")?.text).toMatch(
      /the phone you set the challenge up/,
    );
    for (const readiness of ["askable", "refused", "unsupported"] as MovementReadiness[]) {
      expect(runningMovementNotice(readiness)?.text).not.toMatch(/start a challenge/);
    }
  });
});
