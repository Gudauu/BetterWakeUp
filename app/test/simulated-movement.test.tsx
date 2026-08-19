/**
 * The development build's step counter.
 *
 * Today's task is the one screen that cannot be reached by opening the app on a
 * simulator, so this is the seam that makes it reachable. Two things are worth
 * proving: the typed-in steps travel the real capture and end up in a real
 * observation, and a build that was not given a simulation shows none of it -
 * the panel is what keeps invented steps from being indistinguishable from
 * walked ones, and a store build must never render it.
 */

import type { ChallengeView } from "@betterwakeup/contract";
import { act, render, screen, userEvent, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  openPendingCompletionStore,
  type PendingCompletionStore,
} from "../src/completions/store.ts";
import { type CompletionSync, createCompletionSync } from "../src/completions/sync.ts";
import { createMovementCapture, type MovementCapture } from "../src/movement/capture.ts";
import {
  createSimulatedMovement,
  type MovementSimulation,
} from "../src/movement/simulated-pedometer.ts";
import { DailyCompletionScreen } from "../src/screens/daily-completion-screen.tsx";
import { challengeView, fakeApi } from "./support/fake-api.ts";
import { createMemoryDatabase } from "./support/node-sqlite.ts";

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const TASK_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-09-01T13:00:00.000Z");

/** The step target every test here walks up to. */
const STEP_TARGET = 250;

function challenge(): ChallengeView {
  const view = challengeView();
  return {
    ...view,
    currentTask: {
      id: TASK_ID,
      date: "2026-09-01",
      deadline: "2026-09-01T14:00:00.000Z",
      pauseCutoff: "2026-09-01T06:00:00.000Z",
      status: "scheduled",
      acknowledgedAt: null,
    },
  };
}

const COMPLETION_RESPONSE = {
  task: {
    id: TASK_ID,
    date: "2026-09-01",
    deadline: "2026-09-01T14:00:00.000Z",
    pauseCutoff: "2026-09-01T06:00:00.000Z",
    status: "completed",
    acknowledgedAt: "2026-09-01T13:00:01.000Z",
  },
  replayed: false,
  challengeStatus: "active",
};

interface Harness {
  readonly store: PendingCompletionStore;
  readonly sync: CompletionSync;
  readonly capture: MovementCapture;
  readonly simulation: MovementSimulation;
}

/**
 * The pieces the simulated build assembles, minus the native database. Only the
 * pedometer and the foreground are simulated here, exactly as they are in the
 * runtime this exercises.
 */
async function harness(): Promise<Harness> {
  let counter = 0;
  const store = await openPendingCompletionStore({
    owner: "account-1",
    database: createMemoryDatabase(),
    newRecordId: () => {
      counter += 1;
      return `record-${counter}`;
    },
    now: () => NOW,
  });
  const movement = createSimulatedMovement();
  return {
    store,
    sync: createCompletionSync({
      store,
      client: fakeApi({ createCompletion: COMPLETION_RESPONSE }),
    }),
    capture: createMovementCapture({
      pedometer: movement.pedometer,
      foreground: movement.foreground,
      platform: "ios",
      now: () => NOW,
    }),
    simulation: movement.simulation,
  };
}

async function renderScreen(
  given: Harness,
  simulation: MovementSimulation | undefined,
  onAcknowledged?: () => void,
) {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <DailyCompletionScreen
        challenge={challenge()}
        capture={given.capture}
        sync={given.sync}
        store={given.store}
        appVersion="1.0.0"
        now={() => NOW}
        simulation={simulation}
        {...(onAcknowledged === undefined ? {} : { onAcknowledged })}
      />
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId("daily-completion")).not.toBeNull());
}

describe("the simulated pedometer", () => {
  it("needs no device: it is available and already granted", async () => {
    const movement = createSimulatedMovement();

    expect(await movement.pedometer.isAvailable()).toBe(true);
    expect(await movement.pedometer.getPermission()).toBe("granted");
    expect(movement.foreground.isForeground()).toBe(true);
  });

  it("puts the steps it is given through the real capture", async () => {
    const given = await harness();
    await given.capture.start();

    given.simulation.addSteps(100);
    given.simulation.addSteps(150);
    const stopped = await given.capture.stop();

    expect(given.simulation.stepsSoFar()).toBe(0);
    expect(stopped.status === "stopped" ? stopped.observation : null).toMatchObject({
      steps: 250,
      provenance: "live-foreground",
      source: "expo-pedometer-ios",
    });
  });

  it("delivers nothing to a window that has already closed", async () => {
    const given = await harness();
    await given.capture.start();
    given.simulation.addSteps(100);
    await given.capture.stop();

    given.simulation.addSteps(500);

    // The closed window kept the 100 it was given, and the capture is not
    // recording again, so there is nothing for the later steps to join.
    expect(given.capture.getState()).toMatchObject({ status: "stopped" });
    expect(given.simulation.stepsSoFar()).toBe(0);
  });

  it("ignores a request for no steps at all", async () => {
    const given = await harness();
    await given.capture.start();

    given.simulation.addSteps(0);
    given.simulation.addSteps(-5);

    expect(given.capture.getState()).toMatchObject({ status: "recording", steps: 0 });
  });
});

describe("the task screen in a simulated build", () => {
  it("says so, and offers nothing to press until a window is open", async () => {
    const given = await harness();
    await renderScreen(given, given.simulation);

    expect(screen.getByTestId("simulated-movement-banner")).toHaveTextContent(/simulates movement/);
    expect(screen.queryByTestId("simulate-enough-steps")).toBeNull();
  });

  it("walks the day to its target and records it", async () => {
    const given = await harness();
    const onAcknowledged = jest.fn();
    await renderScreen(given, given.simulation, onAcknowledged);
    const user = userEvent.setup();

    await user.press(screen.getByTestId("start-capture"));
    // The button names the exact remainder, so finishing is one press rather
    // than a count of hundreds.
    expect(screen.getByTestId("simulate-enough-steps")).toHaveTextContent(
      new RegExp(`\\+${STEP_TARGET} to target`),
    );
    await act(async () => {
      await user.press(screen.getByTestId("simulate-enough-steps"));
    });
    expect(screen.getByTestId("capture-steps")).toHaveTextContent(
      new RegExp(`${STEP_TARGET} steps so far`),
    );
    await user.press(screen.getByTestId("stop-capture"));

    // The server acknowledged it, which is the only thing that makes a day
    // count, and the record is off the disk because nothing is left to send.
    await waitFor(() => expect(onAcknowledged).toHaveBeenCalled());
    expect(await given.store.list()).toHaveLength(0);
  });

  it("reaches the shortfall path with a small push", async () => {
    const given = await harness();
    await renderScreen(given, given.simulation);
    const user = userEvent.setup();

    await user.press(screen.getByTestId("start-capture"));
    await act(async () => {
      await user.press(screen.getByTestId("simulate-some-steps"));
    });
    // Short of the target, ending the walk is a two-press action: the first
    // opens what it costs and the second spends it.
    await user.press(screen.getByTestId("stop-capture"));
    await user.press(screen.getByTestId("stop-capture-confirm"));

    await waitFor(() =>
      expect(screen.getByTestId("shortfall")).toHaveTextContent(
        new RegExp(`${STEP_TARGET - 100} more steps`),
      ),
    );
    // Nothing short of the target is written down, simulated or not.
    expect(await given.store.list()).toHaveLength(0);
  });

  it("shows none of it in a build that was given no simulation", async () => {
    const given = await harness();
    await renderScreen(given, undefined);

    expect(screen.queryByTestId("simulated-movement")).toBeNull();
    expect(screen.queryByTestId("simulated-movement-banner")).toBeNull();
  });
});
