/**
 * Telling a walking user the target is reached.
 *
 * The acceptance boundary is the second describe: a window that crosses its
 * target buzzes and speaks exactly once, however many more steps arrive after
 * it, because the whole point is a signal a pocketed phone can give and the
 * whole risk is giving it over and over.
 */

import { act, render, screen } from "@testing-library/react-native";
import { Text } from "react-native";
import type { CaptureState } from "../src/movement/capture.ts";
import {
  targetReached,
  targetReachedText,
  useTargetReachedAlert,
  type WalkAlerts,
} from "../src/movement/walk-alerts.ts";
import { fakeWalkAlerts } from "./support/fake-walk-alerts.ts";

const STARTED = new Date("2026-09-01T13:00:00.000Z");
const LATER = new Date("2026-09-01T13:20:00.000Z");

function recording(steps: number, startedAt = STARTED): CaptureState {
  return { status: "recording", startedAt, steps };
}

function Probe({
  state,
  target,
  alerts,
}: {
  state: CaptureState;
  target: number;
  alerts: WalkAlerts;
}) {
  useTargetReachedAlert(state, target, alerts);
  return <Text>walking</Text>;
}

/** Another reading arriving from the pedometer, in the stated window. */
async function walked(steps: number, alerts: WalkAlerts, startedAt = STARTED) {
  await act(async () => {
    screen.rerender(<Probe state={recording(steps, startedAt)} target={250} alerts={alerts} />);
  });
}

describe("targetReached", () => {
  it("answers nothing while the open window is still short", () => {
    expect(targetReached(recording(249), 250)).toBeNull();
  });

  it("names the window and its count once the target is met", () => {
    expect(targetReached(recording(250), 250)).toEqual({
      window: "2026-09-01T13:00:00.000Z",
      steps: 250,
    });
  });

  it("gives a second window its own identity", () => {
    // A walk cannot be resumed, so a second window is a second walk and has to
    // be able to earn its own alert.
    expect(targetReached(recording(400, LATER), 250)?.window).toBe("2026-09-01T13:20:00.000Z");
  });

  it("stays quiet for a target of zero", () => {
    // Otherwise the phone would celebrate a walk nobody took.
    expect(targetReached(recording(0), 0)).toBeNull();
  });

  it("stays quiet once the window has closed", () => {
    // A closed window has been saved or lost, and both are drawn for a user who
    // is looking at the screen again.
    const stopped: CaptureState = { status: "stopped", reason: "requested", observation: null };
    expect(targetReached(stopped, 250)).toBeNull();
    expect(targetReached({ status: "idle" }, 250)).toBeNull();
  });
});

describe("what is said out loud", () => {
  it("names the count and the button to press", () => {
    expect(targetReachedText(263)).toBe(
      "Target reached. 263 steps counted. Press Save my walk to finish this morning.",
    );
  });

  it("reads a single step as one", () => {
    expect(targetReachedText(1)).toBe(
      "Target reached. 1 step counted. Press Save my walk to finish this morning.",
    );
  });
});

describe("useTargetReachedAlert", () => {
  it("says nothing while the walk is still short of the target", async () => {
    const alerts = fakeWalkAlerts();
    await render(<Probe state={recording(100)} target={250} alerts={alerts} />);

    expect(alerts.buzzes()).toBe(0);
    expect(alerts.said()).toEqual([]);
  });

  it("buzzes and speaks the step the target is met", async () => {
    const alerts = fakeWalkAlerts();
    await render(<Probe state={recording(100)} target={250} alerts={alerts} />);

    await walked(251, alerts);

    expect(alerts.buzzes()).toBe(1);
    expect(alerts.said()).toEqual([
      "Target reached. 251 steps counted. Press Save my walk to finish this morning.",
    ]);
  });

  it("does it once, however many more steps the same walk counts", async () => {
    const alerts = fakeWalkAlerts();
    await render(<Probe state={recording(100)} target={250} alerts={alerts} />);

    for (const steps of [250, 280, 310, 400]) {
      await walked(steps, alerts);
    }

    expect(alerts.buzzes()).toBe(1);
    expect(alerts.said()).toHaveLength(1);
  });

  it("does it again for the next walk", async () => {
    const alerts = fakeWalkAlerts();
    await render(<Probe state={recording(100)} target={250} alerts={alerts} />);
    await walked(250, alerts);

    await walked(250, alerts, LATER);

    expect(alerts.buzzes()).toBe(2);
  });

  it("does not repeat itself for a walk that was already done when the screen opened", async () => {
    // Coming back to the task screen part-way through a finished walk is not a
    // new fact, and buzzing again would read as a second target.
    const alerts = fakeWalkAlerts();
    await render(<Probe state={recording(400)} target={250} alerts={alerts} />);

    expect(alerts.buzzes()).toBe(0);
    expect(alerts.said()).toEqual([]);
  });
});
