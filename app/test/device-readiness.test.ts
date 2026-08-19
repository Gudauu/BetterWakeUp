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
