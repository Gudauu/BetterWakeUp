/**
 * The daily completion screen.
 *
 * The acceptance boundary of issue 32 is the second test: a completion that is
 * recorded locally and never acknowledged shows the local check passed, the
 * server check waiting, and nowhere on the screen says the day is done.
 */

import type { ChallengeView, TaskView } from "@betterwakeup/contract";
import { act, render, screen, userEvent, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ApiError } from "../src/api/errors.ts";
import {
  openPendingCompletionStore,
  type PendingCompletionStore,
} from "../src/completions/store.ts";
import { type CompletionSync, createCompletionSync } from "../src/completions/sync.ts";
import { createMovementCapture, type MovementCapture } from "../src/movement/capture.ts";
import { DailyCompletionScreen } from "../src/screens/daily-completion-screen.tsx";
import { challengeView, type FakeApi, fakeApi } from "./support/fake-api.ts";
import { createFakeForeground, createFakePedometer } from "./support/fake-pedometer.ts";
import { createMemoryDatabase } from "./support/node-sqlite.ts";

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const TASK_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-09-01T13:00:00.000Z");

function task(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: TASK_ID,
    date: "2026-09-01",
    deadline: "2026-09-01T14:00:00.000Z",
    pauseCutoff: "2026-09-01T06:00:00.000Z",
    status: "scheduled",
    acknowledgedAt: null,
    ...overrides,
  };
}

function challenge(currentTask: TaskView | null = task()): ChallengeView {
  return challengeView({ currentTask });
}

const COMPLETION_RESPONSE = {
  task: task({ status: "completed", acknowledgedAt: "2026-09-01T13:00:01.000Z" }),
  replayed: false,
  challengeStatus: "active",
};

interface Harness {
  readonly api: FakeApi;
  readonly store: PendingCompletionStore;
  readonly sync: CompletionSync;
  readonly capture: MovementCapture;
  readonly pedometer: ReturnType<typeof createFakePedometer>;
  readonly foreground: ReturnType<typeof createFakeForeground>;
}

async function harness(api: FakeApi = fakeApi({ createCompletion: COMPLETION_RESPONSE })) {
  let counter = 0;
  const store = await openPendingCompletionStore({
    database: createMemoryDatabase(),
    // expo-crypto's randomUUID does not bind under jest, so the ID generator
    // is supplied here rather than left to the default.
    newRecordId: () => {
      counter += 1;
      return `record-${counter}`;
    },
    now: () => NOW,
  });
  const pedometer = createFakePedometer();
  const foreground = createFakeForeground();
  return {
    api,
    store,
    sync: createCompletionSync({ store, client: api }),
    capture: createMovementCapture({
      pedometer,
      foreground,
      platform: "ios",
      now: () => NOW,
    }),
    pedometer,
    foreground,
  } satisfies Harness;
}

function tree(
  given: Harness,
  view: ChallengeView,
  onAcknowledged?: () => void,
  onFinished?: () => void,
  now: Date = NOW,
) {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <DailyCompletionScreen
        challenge={view}
        capture={given.capture}
        sync={given.sync}
        store={given.store}
        appVersion="1.0.0"
        now={() => now}
        {...(onAcknowledged === undefined ? {} : { onAcknowledged })}
        {...(onFinished === undefined ? {} : { onFinished })}
      />
    </SafeAreaProvider>
  );
}

async function renderScreen(
  given: Harness,
  view = challenge(),
  onAcknowledged?: () => void,
  onFinished?: () => void,
) {
  await render(tree(given, view, onAcknowledged, onFinished));
  await waitFor(() =>
    expect(
      screen.queryByTestId("daily-completion") ?? screen.queryByTestId("no-task-today"),
    ).not.toBeNull(),
  );
}

/** The same screen, read at a stated moment of the morning. */
async function renderAt(now: Date, given: Harness, view = challenge()) {
  await render(tree(given, view, undefined, undefined, now));
  await waitFor(() => expect(screen.queryByTestId("daily-completion")).not.toBeNull());
}

/** Run a full capture window that reaches the target and record it. */
async function completeLocally(given: Harness, steps = 400) {
  const user = userEvent.setup();
  await user.press(screen.getByTestId("start-capture"));
  await act(async () => {
    given.pedometer.deliver(steps);
  });
  await user.press(screen.getByTestId("stop-capture"));
}

describe("the two checks", () => {
  it("are shown separately and both start waiting", async () => {
    await renderScreen(await harness());

    expect(screen.getByTestId("local-check-state")).toHaveTextContent("waiting");
    expect(screen.getByTestId("server-check-state")).toHaveTextContent("waiting");
    expect(screen.getByTestId("progression")).toHaveTextContent("Not done yet");
  });

  it("never render a locally complete but unsynced task as complete", async () => {
    const given = await harness(
      fakeApi({ createCompletion: new TypeError("Network request failed") }),
    );
    await renderScreen(given);

    await completeLocally(given);

    await waitFor(() =>
      expect(screen.getByTestId("local-check-state")).toHaveTextContent("passed"),
    );
    expect(screen.getByTestId("server-check-state")).toHaveTextContent("waiting");
    expect(screen.getByTestId("progression")).toHaveTextContent(
      "Recorded on this device, waiting for the server",
    );
    // The record is still on disk, waiting, rather than having been dropped.
    expect(await given.store.listPending()).toHaveLength(1);
  });

  it("report the day done only once the server's task view says so", async () => {
    const given = await harness();
    const onAcknowledged = jest.fn();
    await renderScreen(given, challenge(), onAcknowledged);

    await completeLocally(given);

    await waitFor(() => expect(onAcknowledged).toHaveBeenCalled());
    expect(await given.store.list()).toHaveLength(0);

    // The acknowledgement carried the server's own task view, so the screen is
    // already in its acknowledged state: the record has left the store, and
    // without that view the screen would read as not done yet and offer to
    // start the day a second time.
    expect(screen.getByTestId("progression")).toHaveTextContent("Done. Both checks passed");
    expect(screen.queryByTestId("start-capture")).toBeNull();

    // And it stays there once the parent re-reads the challenge and hands down
    // the same task from a fresh read.
    await act(async () => {
      screen.rerender(
        tree(
          given,
          challenge(task({ status: "completed", acknowledgedAt: "2026-09-01T13:00:01.000Z" })),
          onAcknowledged,
        ),
      );
    });
    expect(screen.getByTestId("progression")).toHaveTextContent("Done. Both checks passed");
    expect(screen.getByTestId("server-check-state")).toHaveTextContent("passed");
  });
});

describe("what the screen says to do", () => {
  it("names the day and the deadline in words rather than an ISO string", async () => {
    await renderScreen(await harness());

    // The fake challenge runs in America/Los_Angeles, so a 14:00Z deadline is
    // a 7am walk. Neither line contains a T or a Z.
    expect(screen.getByText("Tuesday, September 1")).toBeTruthy();
    expect(screen.getByTestId("deadline")).toHaveTextContent("250 steps by 7:00 AM");
  });

  it("follows each status with the move that status calls for", async () => {
    const given = await harness(
      fakeApi({ createCompletion: new TypeError("Network request failed") }),
    );
    await renderScreen(given);

    expect(screen.getByTestId("daily-status")).toHaveTextContent(/Start the walk when you are up/);

    await completeLocally(given);

    await waitFor(() =>
      expect(screen.getByTestId("daily-status")).toHaveTextContent(
        /saved on this phone\. Keep the app open/,
      ),
    );
  });

  it("shows the walk against its target while the steps are being counted", async () => {
    const given = await harness();
    await renderScreen(given);
    const user = userEvent.setup();

    expect(screen.queryByTestId("capture-progress")).toBeNull();

    await user.press(screen.getByTestId("start-capture"));
    await act(async () => {
      given.pedometer.deliver(100);
    });

    expect(screen.getByTestId("capture-progress")).toHaveProp("accessibilityValue", {
      min: 0,
      max: 250,
      now: 100,
    });
    expect(screen.getByTestId("capture-steps")).toHaveTextContent("100 steps so far, target 250.");
  });
});

describe("the walk itself", () => {
  it("says the walk depends on the screen staying open, and how far there is to go", async () => {
    const given = await harness();
    await renderScreen(given);
    const user = userEvent.setup();

    await user.press(screen.getByTestId("start-capture"));
    await act(async () => {
      given.pedometer.deliver(100);
    });

    expect(screen.getByTestId("capture-hint")).toHaveTextContent(
      /150 to go\. Keep this screen open - leaving the app ends the walk\./,
    );
  });

  it("marks the target as reached and turns the button into saving it", async () => {
    const given = await harness();
    await renderScreen(given);
    const user = userEvent.setup();

    await user.press(screen.getByTestId("start-capture"));
    await act(async () => {
      given.pedometer.deliver(249);
    });
    expect(screen.getByTestId("capture")).toHaveTextContent(/WALK IN PROGRESS/);
    expect(screen.getByTestId("stop-capture")).toHaveTextContent(/Stop and check/);

    await act(async () => {
      given.pedometer.deliver(250);
    });

    expect(screen.getByTestId("capture")).toHaveTextContent(/TARGET REACHED/);
    expect(screen.getByTestId("capture-hint")).toHaveTextContent(
      /That is the walk\. Save it and the morning is yours\./,
    );
    expect(screen.getByTestId("stop-capture")).toHaveTextContent(/Save my walk/);
  });

  it("explains a walk the app itself ended rather than offering a fresh start", async () => {
    const given = await harness();
    await renderScreen(given);
    const user = userEvent.setup();

    await user.press(screen.getByTestId("start-capture"));
    await act(async () => {
      given.pedometer.deliver(120);
    });

    // The user glances at a message. The capture rule closes the window, and
    // without this the screen would look exactly as it did before they walked.
    await act(async () => {
      given.foreground.set(false);
    });

    await waitFor(() => expect(screen.queryByTestId("walk-interrupted")).not.toBeNull());
    expect(screen.getByTestId("walk-interrupted")).toHaveTextContent(
      /the 120 steps it had counted were not saved/,
    );
    expect(screen.getByTestId("start-capture")).toHaveTextContent(/Start the walk again/);
    expect(screen.queryByTestId("capture")).toBeNull();
  });

  it("puts the explanation down once the walk is started again", async () => {
    const given = await harness();
    await renderScreen(given);
    const user = userEvent.setup();

    await user.press(screen.getByTestId("start-capture"));
    await act(async () => {
      given.foreground.set(false);
    });
    await waitFor(() => expect(screen.queryByTestId("walk-interrupted")).not.toBeNull());

    await act(async () => {
      given.foreground.set(true);
    });
    await user.press(screen.getByTestId("start-capture"));

    expect(screen.queryByTestId("walk-interrupted")).toBeNull();
    expect(screen.getByTestId("capture")).toBeTruthy();
  });
});

describe("the completion that ends the whole challenge", () => {
  /** The same harness, with a server that says this one finished the challenge. */
  async function finishing(deposit = 0) {
    const given = await harness(
      fakeApi({ createCompletion: { ...COMPLETION_RESPONSE, challengeStatus: "succeeded" } }),
    );
    const onFinished = jest.fn();
    const view = challengeView({
      currentTask: task(),
      configuration: {
        ...challengeView().configuration,
        deposit: { amount: deposit, currency: "USD" },
      },
    });
    await renderScreen(given, view, undefined, onFinished);
    return { given, onFinished };
  }

  it("celebrates the finish and tells the caller the challenge is over", async () => {
    const { given, onFinished } = await finishing();

    expect(screen.queryByTestId("challenge-finished")).toBeNull();

    await completeLocally(given);

    await waitFor(() => expect(screen.queryByTestId("challenge-finished")).not.toBeNull());
    expect(onFinished).toHaveBeenCalled();
    expect(screen.getByTestId("challenge-finished-days")).toHaveTextContent(/all 30 days/);
  });

  it("does not promise a tomorrow the challenge no longer has", async () => {
    const { given } = await finishing();

    await completeLocally(given);

    await waitFor(() => expect(screen.queryByTestId("challenge-finished")).not.toBeNull());
    expect(screen.getByTestId("daily-status")).toHaveTextContent(
      /That was the last day this challenge needed\./,
    );
    expect(screen.getByTestId("daily-status")).not.toHaveTextContent(/until tomorrow/);
  });

  it("says the staked deposit was never charged", async () => {
    const { given } = await finishing(2000);

    await completeLocally(given);

    await waitFor(() => expect(screen.queryByTestId("challenge-finished")).not.toBeNull());
    expect(screen.getByTestId("challenge-finished-deposit")).toHaveTextContent(
      /\$20\.00 deposit stays yours/,
    );
  });

  it("leaves an ordinary day saying nothing about a finish", async () => {
    const given = await harness();
    await renderScreen(given);

    await completeLocally(given);

    await waitFor(() =>
      expect(screen.getByTestId("progression")).toHaveTextContent("Done. Both checks passed"),
    );
    expect(screen.queryByTestId("challenge-finished")).toBeNull();
    expect(screen.getByTestId("daily-status")).toHaveTextContent(/until tomorrow/);
  });
});

describe("a refusal", () => {
  it("is surfaced with the server's own message and no retry offered", async () => {
    const given = await harness(
      fakeApi({
        createCompletion: new ApiError("task_already_resolved", "This task is already resolved."),
      }),
    );
    await renderScreen(given);

    await completeLocally(given);

    await waitFor(() =>
      expect(screen.getByTestId("progression")).toHaveTextContent(
        "The server refused this one. Action needed",
      ),
    );
    expect(screen.getByTestId("rejected-detail")).toHaveTextContent(
      /This task is already resolved\./,
    );
    expect(screen.getByTestId("server-check-state")).toHaveTextContent("failed");
    expect(screen.queryByTestId("retry-sync")).toBeNull();
  });
});

describe("the deadline warning", () => {
  it("appears when the deadline is near and the server has not acknowledged", async () => {
    const given = await harness(
      fakeApi({ createCompletion: new TypeError("Network request failed") }),
    );
    await renderScreen(given, challenge(task({ deadline: "2026-09-01T13:10:00.000Z" })));

    expect(screen.queryByTestId("deadline-warning")).toBeNull();

    await completeLocally(given);

    await waitFor(() => expect(screen.queryByTestId("deadline-warning")).not.toBeNull());
    expect(screen.getByTestId("deadline-warning")).toHaveTextContent(
      /10 minutes left and the server has not acknowledged yet\./,
    );
  });
});

describe("a window that misses the target", () => {
  it("records nothing and says how far short it fell", async () => {
    const given = await harness();
    await renderScreen(given);

    await completeLocally(given, 100);

    await waitFor(() => expect(screen.queryByTestId("shortfall")).not.toBeNull());
    expect(screen.getByTestId("shortfall")).toHaveTextContent(/150 more steps needed/);
    expect(given.api.names()).toHaveLength(0);
    expect(await given.store.list()).toHaveLength(0);
    expect(screen.getByTestId("local-check-state")).toHaveTextContent("waiting");
  });
});

describe("no open task", () => {
  it("says there is nothing due", async () => {
    await renderScreen(await harness(), challenge(null));

    expect(screen.queryByTestId("daily-completion")).toBeNull();
    expect(screen.getByTestId("no-task-today")).toBeTruthy();
  });
});

describe("the clock on the morning", () => {
  /** Ten minutes to go, and the deadline half an hour behind. */
  const CLOSING = new Date("2026-09-01T13:50:00.000Z");
  const AFTER = new Date("2026-09-01T14:30:00.000Z");

  it("counts the deadline down rather than only naming the time it falls at", async () => {
    await renderAt(NOW, await harness());

    expect(screen.getByTestId("time-left")).toHaveTextContent("1 hour left to walk.");
  });

  it("counts in minutes once the deadline is inside the alarm's own lead", async () => {
    await renderAt(CLOSING, await harness());

    expect(screen.getByTestId("time-left")).toHaveTextContent("10 minutes left to walk.");
  });

  it("tells a walker racing the clock that it is the finish that is judged", async () => {
    const given = await harness();
    await renderAt(CLOSING, given);
    const user = userEvent.setup();

    expect(screen.queryByTestId("capture-deadline")).toBeNull();
    await user.press(screen.getByTestId("start-capture"));

    expect(screen.getByTestId("capture-deadline")).toHaveTextContent(
      /Save it before 7:00 AM - a walk finished after the deadline does not count\./,
    );
  });

  it("leaves a walk with the morning ahead of it saying nothing about the clock", async () => {
    const given = await harness();
    await renderAt(NOW, given);
    const user = userEvent.setup();

    await user.press(screen.getByTestId("start-capture"));

    expect(screen.queryByTestId("capture-deadline")).toBeNull();
  });

  it("stops offering a walk once the deadline has passed, and says what that means", async () => {
    await renderAt(AFTER, await harness());

    expect(screen.getByTestId("deadline-missed")).toHaveTextContent(
      /The 7:00 AM deadline has passed, so a walk now cannot count for today\./,
    );
    expect(screen.getByTestId("deadline-missed")).toHaveTextContent(/Emergency Recovery/);
    expect(screen.getByTestId("daily-status")).toHaveTextContent(
      /This morning's window has closed\./,
    );
    // The invitation is gone: the server judges the instant the walk was
    // saved, so anything started now ends in a refusal.
    expect(screen.queryByTestId("start-capture")).toBeNull();
    expect(screen.queryByTestId("time-left")).toBeNull();
  });

  it("says nothing about a countdown once the day is acknowledged", async () => {
    const given = await harness();
    await renderAt(NOW, given);

    await completeLocally(given);

    await waitFor(() =>
      expect(screen.getByTestId("progression")).toHaveTextContent("Done. Both checks passed"),
    );
    expect(screen.queryByTestId("time-left")).toBeNull();
  });
});
