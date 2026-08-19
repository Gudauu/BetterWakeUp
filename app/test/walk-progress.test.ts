/**
 * How a walk in progress reads.
 *
 * The case that matters is the third describe: the capture answers a walk the
 * user abandoned by leaving the app with the same `stopped` shape it answers a
 * finished walk with, so nothing but this rule stands between a lost walk and
 * a screen that silently offers to start one.
 */

import type { MovementObservation } from "@betterwakeup/contract";
import type { CaptureState } from "../src/movement/capture.ts";
import {
  abandonWalkText,
  interruptionText,
  type WalkProgress,
  walkingHintText,
  walkProgress,
} from "../src/movement/walk-progress.ts";

/** The sentence a walk's interruption produces, or a failure if there is none. */
function interruptionOf(walk: WalkProgress): string {
  if (walk.interruption === null) {
    throw new Error("expected the walk to have been interrupted");
  }
  return interruptionText(walk.interruption);
}

const OBSERVATION: MovementObservation = {
  startedAt: "2026-09-01T13:00:00.000Z",
  endedAt: "2026-09-01T13:10:00.000Z",
  steps: 120,
  provenance: "live-foreground",
  source: "expo-pedometer-ios",
};

function recording(steps: number): CaptureState {
  return { status: "recording", startedAt: new Date("2026-09-01T13:00:00.000Z"), steps };
}

describe("a walk being counted", () => {
  it("reports the steps owed and does not celebrate short of the target", () => {
    const walk = walkProgress(recording(100), 250);

    expect(walk.recording).toBe(true);
    expect(walk.steps).toBe(100);
    expect(walk.remaining).toBe(150);
    expect(walk.reachedTarget).toBe(false);
    expect(walk.interruption).toBeNull();
  });

  it("reaches the target on the step that meets it and owes nothing beyond it", () => {
    expect(walkProgress(recording(250), 250).reachedTarget).toBe(true);
    expect(walkProgress(recording(400), 250).remaining).toBe(0);
    expect(walkProgress(recording(400), 250).reachedTarget).toBe(true);
  });

  it("does not call a walk nobody took complete", () => {
    expect(walkProgress(recording(0), 0).reachedTarget).toBe(false);
  });
});

describe("no walk open", () => {
  it("owes the whole target and holds no steps", () => {
    for (const state of [{ status: "idle" } as const, { status: "unsupported" } as const]) {
      const walk = walkProgress(state, 250);
      expect(walk.recording).toBe(false);
      expect(walk.steps).toBe(0);
      expect(walk.remaining).toBe(250);
      expect(walk.interruption).toBeNull();
    }
  });

  it("says nothing about an interruption after a walk the user stopped", () => {
    const stopped: CaptureState = {
      status: "stopped",
      reason: "requested",
      observation: OBSERVATION,
    };

    expect(walkProgress(stopped, 250).interruption).toBeNull();
  });
});

describe("a walk that ended on its own", () => {
  it("names the backgrounding and the steps it took with it", () => {
    const walk = walkProgress(
      { status: "stopped", reason: "backgrounded", observation: OBSERVATION },
      250,
    );

    expect(walk.interruption).toEqual({ reason: "backgrounded", steps: 120 });
    expect(interruptionOf(walk)).toMatch(/120 steps it had counted were not saved/);
  });

  it("counts a backgrounded window that produced no observation as no steps", () => {
    const walk = walkProgress(
      { status: "stopped", reason: "backgrounded", observation: null },
      250,
    );

    expect(walk.interruption).toEqual({ reason: "backgrounded", steps: 0 });
    expect(interruptionOf(walk)).toMatch(/nothing was counted/);
  });

  it("blames the revoked permission rather than the app leaving the screen", () => {
    const walk = walkProgress(
      { status: "stopped", reason: "permission-revoked", observation: null },
      250,
    );

    expect(walk.interruption).toEqual({ reason: "permission-revoked", steps: 0 });
    expect(interruptionOf(walk)).toMatch(/Motion access was turned off/);
  });

  it("clears once a new walk begins", () => {
    expect(walkProgress(recording(10), 250).interruption).toBeNull();
  });
});

describe("what a walking user is told while the window is open", () => {
  it("promises the screen stays on and names the one thing that still ends the walk", () => {
    expect(walkingHintText(150)).toBe(
      "150 to go. The screen stays on while you walk - leave the app, though, and the walk ends.",
    );
  });
});

describe("what ending a walk short of the target costs", () => {
  it("names the steps that go and says a later walk cannot inherit them", () => {
    const text = abandonWalkText(180, 70);

    expect(text).toContain("70 steps short");
    expect(text).toContain("the 180 steps counted so far are discarded");
    expect(text).toContain("a new walk starts from zero");
  });

  it("reads as English for a single step either side", () => {
    const text = abandonWalkText(1, 1);

    expect(text).toContain("1 step short");
    expect(text).toContain("the 1 step counted so far is discarded");
    expect(text).not.toContain("1 steps");
  });
});
