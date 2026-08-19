/**
 * Home is the screen a signed-in account lands on, so these tests are about
 * what it says the account is in the middle of, and about the one thing it
 * must never do: offer to start a second challenge over a live one.
 */

import type { ChallengeDay } from "@betterwakeup/contract";
import { act, fireEvent, render, screen, userEvent, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { ApiClient } from "../src/api/client.ts";
import { ApiError } from "../src/api/errors.ts";
import type { AppReturnTrigger } from "../src/challenges/app-return.ts";
import { HomeScreen } from "../src/screens/home-screen.tsx";
import { SessionProvider } from "../src/session/session-context.tsx";
import { createMemorySessionStore } from "../src/session/session-store.ts";
import { CLOCK_INTERVAL_MS } from "../src/ui/clock.ts";
import {
  challengeDays,
  challengeView,
  endedChallenge,
  type FakeApi,
  fakeApi,
  fundedChallengeView,
  PAUSE_EXPIRES_AT,
  PAUSED_AT,
  taskView,
} from "./support/fake-api.ts";
import { fakeAppReturn } from "./support/fake-app-return.ts";
import {
  type FakeCompletionRuntime,
  type FakeRuntimeOptions,
  fakeCompletionRuntimeFactory,
} from "./support/fake-completion-runtime.ts";
import { type FakeNotifier, fakeNotifier } from "./support/fake-notifier.ts";
import { type FakePaymentSheet, fakePaymentSheet } from "./support/fake-payment-sheet.ts";
import { fakeProviders } from "./support/fake-providers.ts";
import { type FakeSettingsLauncher, fakeSettings } from "./support/fake-settings.ts";

const SESSION = {
  accountId: "11111111-1111-4111-8111-111111111111",
  token: "session-token",
  expiresAt: "2027-01-01T00:00:00.000Z",
};

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/**
 * The moment every test reads home at, unless it says otherwise. It sits two
 * hours before the fixture task's 7:00 AM deadline - far enough out that the
 * morning reads as quiet - and well ahead of the recovery offer the fixtures
 * carry, so the offer reads as open for the tests that are about something else.
 */
const NOW = new Date("2026-09-01T12:00:00.000Z");

async function renderHome(
  api: ApiClient,
  options: {
    onSignOut?: () => void;
    onRuntimeOpened?: (runtime: FakeCompletionRuntime) => void;
    /**
     * Where the device is standing. Stated rather than read from the machine,
     * so a test suite run in another zone does not decide whether home offers
     * to move the challenge's deadlines. It defaults to the fixture's own zone,
     * which is the "user has not travelled" case every other test is about.
     */
    deviceTimeZone?: string;
    /**
     * How reminders reach the device. Stated so that no test asks a machine
     * with no notification centre for permission, and so that what home would
     * have scheduled is readable.
     */
    notifier?: FakeNotifier;
    /** How a card is asked for, once home offers to replace one that lapsed. */
    paymentSheet?: FakePaymentSheet;
    /** How the device's settings page is opened, once home offers the press. */
    settings?: FakeSettingsLauncher;
    /** Walks already recorded on this device and not yet sent. */
    seed?: FakeRuntimeOptions["seed"];
    /**
     * How home hears that the app came back to the front. Stated so a return
     * is a call in the test rather than an operating system event.
     */
    appReturn?: AppReturnTrigger;
    /**
     * What the clock says while home is on screen. Stated rather than read
     * from the machine, so how long is left on a recovery offer is a fact of
     * the fixture instead of a fact of the day the suite is run on.
     *
     * A single instant stands still, which is what almost every test wants. A
     * function is how a test lets time pass: home re-reads it on a timer, so a
     * clock that answers a later instant is a morning going by under a screen
     * nobody is touching.
     */
    now?: Date | (() => Date);
  } = {},
) {
  const stated = options.now;
  const readClock = typeof stated === "function" ? stated : () => stated ?? NOW;
  // Home holds a completion runtime for as long as it is on screen, so every
  // one of these tests gets one with no device under it.
  const createRuntime = fakeCompletionRuntimeFactory({
    ...(options.onRuntimeOpened === undefined ? {} : { onOpened: options.onRuntimeOpened }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  });
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <SessionProvider
        store={createMemorySessionStore(SESSION)}
        createClient={() => api}
        providers={fakeProviders()}
      >
        <HomeScreen
          createRuntime={createRuntime}
          notifier={options.notifier ?? fakeNotifier()}
          deviceTimeZone={options.deviceTimeZone ?? "America/Los_Angeles"}
          now={readClock}
          {...(options.paymentSheet === undefined ? {} : { paymentSheet: options.paymentSheet })}
          {...(options.settings === undefined ? {} : { settings: options.settings })}
          {...(options.appReturn === undefined ? {} : { appReturn: options.appReturn })}
          {...(options.onSignOut === undefined ? {} : { onSignOut: options.onSignOut })}
        />
      </SessionProvider>
    </SafeAreaProvider>,
  );
}

/** How many times the account's challenge has been asked for. */
function reads(api: FakeApi): number {
  return api.names().filter((name) => name === "getCurrentChallenge").length;
}

/** A running challenge with today's task open, which is what a return re-reads. */
function runningChallenge() {
  return { lastEnded: null, challenge: challengeView({ currentTask: taskView() }) };
}

/** A read that never comes back, for asserting what is on screen meanwhile. */
function pending(): () => Promise<never> {
  return () => new Promise<never>(() => {});
}

/**
 * One answer per call, the last one repeating. A refresh is only interesting
 * when the second answer differs from the first.
 */
function answers(...values: readonly unknown[]): (input: unknown) => unknown {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return typeof value === "function" ? (value as () => unknown)() : value;
  };
}

describe("home reads the account's current challenge", () => {
  it("offers to start one when the account holds none", async () => {
    await renderHome(fakeApi({ getCurrentChallenge: { challenge: null, lastEnded: null } }));

    expect(await screen.findByTestId("home-no-challenge")).toBeOnTheScreen();
    expect(screen.getByTestId("home-create-challenge")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-challenge")).toBeNull();
  });

  it("shows the running challenge and never offers to start another", async () => {
    // Only one challenge runs at a time, and a home screen that offered the
    // form anyway would be sending the user at a request the server refuses.
    const api = fakeApi({
      getCurrentChallenge: {
        lastEnded: null,
        challenge: challengeView({
          progress: {
            requiredTaskCount: 30,
            completedTaskCount: 4,
            skippedTaskCount: 1,
            forgivenTaskCount: 0,
          },
          currentTask: taskView(),
        }),
      },
    });

    await renderHome(api);

    expect(await screen.findByTestId("home-challenge")).toBeOnTheScreen();
    expect(screen.getByTestId("home-challenge-status")).toHaveTextContent("Challenge running");
    expect(screen.getByTestId("home-progress")).toHaveTextContent("4 of 30 days done, 25 to go.");
    expect(screen.getByTestId("home-current-task")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-create-challenge")).toBeNull();
  });

  it("says a paused challenge is paused rather than running", async () => {
    await renderHome(
      fakeApi({
        getCurrentChallenge: {
          lastEnded: null,
          challenge: challengeView({
            pause: { pausedAt: "2026-09-02T00:00:00.000Z", expiresAt: "2027-09-02T00:00:00.000Z" },
          }),
        },
      }),
    );

    expect(await screen.findByTestId("home-challenge-status")).toHaveTextContent("Paused");
  });

  it("raises the recovery offer and the unsecured deposit where they are read", async () => {
    await renderHome(
      fakeApi({
        getCurrentChallenge: {
          lastEnded: null,
          challenge: fundedChallengeView({
            status: "recovery_pending",
            depositSecured: false,
            recoveryOffer: {
              taskId: "44444444-4444-4444-8444-444444444444",
              offeredAt: "2026-09-01T15:00:00.000Z",
              expiresAt: "2026-09-02T15:00:00.000Z",
            },
          }),
        },
      }),
    );

    expect(await screen.findByTestId("home-recovery-offer")).toBeOnTheScreen();
    expect(screen.getByTestId("home-deposit-unsecured")).toBeOnTheScreen();
  });
});

describe("home's row of days", () => {
  /** A challenge whose calendar is exactly these statuses, in order. */
  const withDays = (statuses: readonly ChallengeDay["status"][]) =>
    fakeApi({
      getCurrentChallenge: {
        lastEnded: null,
        challenge: challengeView({
          days: statuses.map((status, index) => ({
            date: `2026-09-${String(index + 1).padStart(2, "0")}`,
            status,
          })),
        }),
      },
    });

  it("draws one mark per day and says the same thing to a screen reader", async () => {
    await renderHome(withDays(["completed", "missed", "completed", "scheduled", "scheduled"]));

    const strip = await screen.findByTestId("home-day-strip");
    expect(strip.children).toHaveLength(5);
    expect(strip).toHaveProp("accessibilityLabel", "Your days: 2 kept, 1 missed, 2 still to come.");
  });

  it("names a run the user is on, and stays quiet about one day", async () => {
    await renderHome(withDays(["completed", "completed", "completed", "scheduled"]));

    expect(await screen.findByTestId("home-streak")).toHaveTextContent("3 days in a row.");
  });

  it("says nothing about a run that has just been broken", async () => {
    // The row already shows the missed day. A sentence about it would be the
    // app scolding someone who turned up this morning.
    await renderHome(withDays(["completed", "completed", "missed", "scheduled"]));

    expect(await screen.findByTestId("home-day-strip")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-streak")).toBeNull();
  });

  it("draws no row for a challenge whose days do not exist yet", async () => {
    await renderHome(withDays([]));

    expect(await screen.findByTestId("home-challenge")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-day-strip")).toBeNull();
  });
});

describe("home when a card stopped securing the deposit", () => {
  it("offers the way to add one, and opens it", async () => {
    const user = userEvent.setup();
    await renderHome(
      fakeApi({
        getCurrentChallenge: {
          lastEnded: null,
          challenge: fundedChallengeView({ depositSecured: false }),
        },
      }),
      { paymentSheet: fakePaymentSheet() },
    );

    await user.press(await screen.findByTestId("home-open-payment-method"));

    expect(await screen.findByTestId("payment-method-screen")).toBeOnTheScreen();
  });

  it("says nothing about a card while the deposit is secured", async () => {
    await renderHome(
      fakeApi({
        getCurrentChallenge: {
          lastEnded: null,
          challenge: fundedChallengeView(),
        },
      }),
    );

    expect(await screen.findByTestId("home-challenge")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-deposit-unsecured")).toBeNull();
  });

  it("re-reads the challenge once a card secures it again", async () => {
    const user = userEvent.setup();
    const unsecured = fundedChallengeView({ depositSecured: false });
    let reads = 0;
    const api = fakeApi({
      getCurrentChallenge: () => {
        reads += 1;
        return { lastEnded: null, challenge: reads === 1 ? unsecured : fundedChallengeView() };
      },
      replacePaymentMethod: { challenge: fundedChallengeView() },
    });
    await renderHome(api, { paymentSheet: fakePaymentSheet() });

    await user.press(await screen.findByTestId("home-open-payment-method"));
    await user.press(await screen.findByTestId("payment-method-add"));
    await user.press(await screen.findByTestId("payment-method-done-back"));

    expect(await screen.findByTestId("home-challenge")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-deposit-unsecured")).toBeNull();
    expect(reads).toBe(2);
  });
});

describe("home when the user has travelled", () => {
  it("says nothing while the device is where the challenge is", async () => {
    await renderHome(
      fakeApi({
        getCurrentChallenge: {
          lastEnded: null,
          challenge: challengeView({ currentTask: taskView() }),
        },
      }),
    );

    expect(await screen.findByTestId("home-challenge")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-time-zone-move")).toBeNull();
  });

  it("names both times when the deadline is read in a zone the user has left", async () => {
    // The fixture's 7:00 AM Los Angeles deadline is 10:00 AM in New York, and
    // a user standing in New York would have walked three hours too late.
    await renderHome(
      fakeApi({
        getCurrentChallenge: {
          lastEnded: null,
          challenge: challengeView({ currentTask: taskView() }),
        },
      }),
      { deviceTimeZone: "America/New_York" },
    );

    const banner = await screen.findByTestId("home-time-zone-move");
    expect(banner).toHaveTextContent(/7:00 AM walk is due at 10:00 AM here/);
    expect(screen.getByTestId("home-open-time-zone")).toBeOnTheScreen();
  });

  it("opens the move, and stops asking once the user chooses to stay put", async () => {
    const user = userEvent.setup();
    await renderHome(
      fakeApi({
        getCurrentChallenge: {
          lastEnded: null,
          challenge: challengeView({ currentTask: taskView() }),
        },
      }),
      { deviceTimeZone: "America/New_York" },
    );

    await user.press(await screen.findByTestId("home-open-time-zone"));
    expect(await screen.findByTestId("time-zone-screen")).toBeOnTheScreen();

    await user.press(screen.getByTestId("time-zone-back"));
    expect(await screen.findByTestId("home-challenge")).toBeOnTheScreen();
    // A weekend away is a reason to keep the deadlines where they are, and a
    // banner that came straight back would be nagging rather than helping.
    expect(screen.queryByTestId("home-time-zone-move")).toBeNull();
  });
});

describe("home when the read fails", () => {
  it("offers a retry rather than an empty screen, and asks again when tapped", async () => {
    // A read that failed is not an account with no challenge, so the screen
    // must not offer the form: it would create a second one.
    let attempts = 0;
    const api: FakeApi = fakeApi({
      getCurrentChallenge: () => {
        attempts += 1;
        if (attempts === 1) {
          throw new ApiError("internal_error", "database unreachable", { status: 500 });
        }
        return { challenge: challengeView(), lastEnded: null };
      },
    });

    await renderHome(api);

    expect(await screen.findByTestId("home-error")).toBeOnTheScreen();
    expect(screen.getByTestId("home-error-message")).not.toHaveTextContent("database");
    expect(screen.queryByTestId("home-create-challenge")).toBeNull();

    await userEvent.press(screen.getByTestId("home-retry"));

    expect(await screen.findByTestId("home-challenge")).toBeOnTheScreen();
  });

  it("names the network when there was no connection at all", async () => {
    await renderHome(
      fakeApi({
        getCurrentChallenge: new ApiError("internal_error", "fetch failed", { status: null }),
      }),
    );

    expect(await screen.findByTestId("home-error-message")).toHaveTextContent(/No connection/);
  });

  it("says the walks on this phone are safe when the read fails with work held", async () => {
    // The read fails exactly when there is no connection, which is exactly when
    // a walk stays on the phone: an error screen alone reads, to someone who
    // walked ten minutes ago, as though the walk went with the challenge.
    await renderHome(
      fakeApi({
        getCurrentChallenge: new ApiError("internal_error", "fetch failed", { status: null }),
      }),
      {
        seed: [
          {
            input: {
              challengeId: "33333333-3333-4333-8333-333333333333",
              taskId: "44444444-4444-4444-8444-444444444444",
              completedAt: "2026-09-01T13:40:00.000Z",
              observation: {
                startedAt: "2026-09-01T13:30:00.000Z",
                endedAt: "2026-09-01T13:40:00.000Z",
                steps: 300,
                provenance: "live-foreground",
                source: "expo-pedometer-ios",
              },
              appVersion: "1.0.0-test",
              verificationPolicyVersion: "live-foreground-steps.1",
            },
          },
        ],
      },
    );

    expect(await screen.findByTestId("home-error-held-walks")).toHaveTextContent(
      /A walk you saved is still on this phone/,
    );
    expect(screen.getByTestId("home-error-held-walks")).toHaveTextContent(/no need to walk again/);
  });

  it("says nothing about held walks when the device is holding none", async () => {
    await renderHome(
      fakeApi({
        getCurrentChallenge: new ApiError("internal_error", "fetch failed", { status: null }),
      }),
    );

    expect(await screen.findByTestId("home-error")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-error-held-walks")).toBeNull();
  });
});

describe("home is the door to creating a challenge", () => {
  it("opens the form and reads the challenge back once it is created", async () => {
    let created = false;
    const api = fakeApi({
      getCurrentChallenge: () => ({ challenge: created ? challengeView() : null, lastEnded: null }),
      createChallenge: () => {
        created = true;
        return { challenge: challengeView(), lastEnded: null };
      },
    });

    await renderHome(api);
    await userEvent.press(await screen.findByTestId("home-create-challenge"));

    expect(screen.getByTestId("create-challenge")).toBeOnTheScreen();

    // The form is filled in far enough to be startable: zero deposit, so no
    // payment step stands between the tap and a challenge.
    await fireEvent(screen.getByTestId("confirm-time-zone"), "valueChange", true);
    for (const disclosure of screen.getAllByTestId(/^disclosure-/)) {
      await fireEvent(disclosure, "valueChange", true);
    }
    await waitFor(() => expect(screen.getByTestId("start-challenge")).toBeOnTheScreen());
    await userEvent.press(screen.getByTestId("start-challenge"));

    expect(await screen.findByTestId("home-challenge")).toBeOnTheScreen();
    expect(api.names()).toContain("createChallenge");
  });

  it("comes back to home when the form is left without creating anything", async () => {
    const api = fakeApi({ getCurrentChallenge: { challenge: null, lastEnded: null } });

    await renderHome(api);
    await userEvent.press(await screen.findByTestId("home-create-challenge"));
    await userEvent.press(screen.getByTestId("cancel-create"));

    expect(await screen.findByTestId("home-no-challenge")).toBeOnTheScreen();
    expect(api.names()).not.toContain("createChallenge");
  });
});

describe("home is the door to today's task", () => {
  it("opens the task screen for the task home is showing", async () => {
    // Before this route existed the completion screen was unreachable from the
    // running app, so this is the test that says the app can record a day.
    await renderHome(
      fakeApi({
        getCurrentChallenge: {
          challenge: challengeView({ currentTask: taskView() }),
          lastEnded: null,
        },
      }),
    );
    await userEvent.press(await screen.findByTestId("home-open-task"));

    expect(await screen.findByTestId("daily-completion")).toBeOnTheScreen();
    expect(screen.getByTestId("start-capture")).toBeOnTheScreen();
  });

  it("offers no way in when nothing is due", async () => {
    await renderHome(
      fakeApi({ getCurrentChallenge: { challenge: challengeView(), lastEnded: null } }),
    );

    expect(await screen.findByTestId("home-no-task")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-open-task")).toBeNull();
  });

  it("comes back to home and re-reads the challenge", async () => {
    const api = fakeApi({
      getCurrentChallenge: {
        challenge: challengeView({ currentTask: taskView() }),
        lastEnded: null,
      },
    });

    await renderHome(api);
    await userEvent.press(await screen.findByTestId("home-open-task"));
    await screen.findByTestId("daily-completion");
    const before = api.names().filter((name) => name === "getCurrentChallenge").length;

    await userEvent.press(screen.getByTestId("daily-back"));

    expect(await screen.findByTestId("home-challenge")).toBeOnTheScreen();
    expect(api.names().filter((name) => name === "getCurrentChallenge").length).toBe(before + 1);
  });

  it("hands the task screen a live runtime and disposes it on the way out", async () => {
    // A runtime left open would hold a database handle and a foreground
    // listener nothing can reach, so the tear-down is part of the contract.
    let opened: FakeCompletionRuntime | null = null;
    const api = fakeApi({ getCurrentChallenge: { challenge: null, lastEnded: null } });

    await renderHome(api, {
      onRuntimeOpened: (runtime) => {
        opened = runtime;
      },
    });
    await screen.findByTestId("home-no-challenge");

    await waitFor(() => expect(opened).not.toBeNull());
    const runtime = opened as unknown as FakeCompletionRuntime;
    expect(runtime.disposals()).toBe(0);

    screen.unmount();

    await waitFor(() => expect(runtime.disposals()).toBe(1));
  });
});

describe("home says what this device is still holding", () => {
  const TASK_ID = "44444444-4444-4444-8444-444444444444";

  function walk(taskId: string) {
    return {
      challengeId: "33333333-3333-4333-8333-333333333333",
      taskId,
      completedAt: "2026-09-01T13:40:00.000Z",
      observation: {
        startedAt: "2026-09-01T13:30:00.000Z",
        endedAt: "2026-09-01T13:40:00.000Z",
        steps: 300,
        provenance: "live-foreground",
        source: "expo-pedometer-ios",
      },
      appVersion: "1.0.0-test",
      verificationPolicyVersion: "live-foreground-steps.1",
    } as const;
  }

  const runningWithTask = fakeApi({
    getCurrentChallenge: {
      challenge: challengeView({ currentTask: taskView({ id: TASK_ID }) }),
      lastEnded: null,
    },
  });

  it("shows the step target when nothing has been walked yet", async () => {
    await renderHome(runningWithTask);

    expect(await screen.findByTestId("home-current-task")).toHaveTextContent(
      /250 steps to keep the day/,
    );
    expect(screen.queryByTestId("home-task-waiting")).toBeNull();
    expect(screen.getByTestId("home-open-task")).toHaveTextContent("Open today's task");
  });

  it("says today's walk is saved here and not yet at the server", async () => {
    // The case that used to be invisible: a walk taken with no signal left home
    // reading exactly as it did before the user got up.
    await renderHome(runningWithTask, { seed: [{ input: walk(TASK_ID) }] });

    expect(await screen.findByTestId("home-task-waiting")).toHaveTextContent(
      /Walked and saved on this phone/,
    );
    expect(screen.getByTestId("home-open-task")).toHaveTextContent("See today's walk");
  });

  it("says the server refused today's walk, which no retry will change", async () => {
    await renderHome(runningWithTask, {
      seed: [
        {
          input: walk(TASK_ID),
          rejected: { code: "validation_failed", message: "The observation was not accepted." },
        },
      ],
    });

    expect(await screen.findByTestId("home-task-refused")).toHaveTextContent(
      /would not take today's walk/,
    );
    expect(screen.queryByTestId("home-task-waiting")).toBeNull();
  });

  it("names a walk left over from an earlier day", async () => {
    await renderHome(runningWithTask, {
      seed: [{ input: walk("66666666-6666-4666-8666-666666666666") }],
    });

    expect(await screen.findByTestId("home-earlier-unsent")).toHaveTextContent(
      /An earlier walk is still waiting/,
    );
    // Today is untouched by it: the user has still not walked today.
    expect(screen.queryByTestId("home-task-waiting")).toBeNull();
  });
});

/**
 * Home is the screen most people open first, and it named the deadline as a
 * wall-clock time and then said nothing about how near it was - including once
 * it had gone by, where the card still offered a walk the server can no longer
 * accept.
 */
describe("the clock on this morning's walk", () => {
  const TASK_ID = "44444444-4444-4444-8444-444444444444";
  const withTask = fakeApi({
    getCurrentChallenge: {
      challenge: challengeView({ currentTask: taskView({ id: TASK_ID }) }),
      lastEnded: null,
    },
  });

  /** A walk recorded on this device for today, waiting to be sent. */
  const heldWalk = [
    {
      input: {
        challengeId: "33333333-3333-4333-8333-333333333333",
        taskId: TASK_ID,
        completedAt: "2026-09-01T13:40:00.000Z",
        observation: {
          startedAt: "2026-09-01T13:30:00.000Z",
          endedAt: "2026-09-01T13:40:00.000Z",
          steps: 300,
          provenance: "live-foreground",
          source: "expo-pedometer-ios",
        },
        appVersion: "1.0.0-test",
        verificationPolicyVersion: "live-foreground-steps.1",
      },
    },
  ] as const;

  it("counts the morning down quietly while there is time in it", async () => {
    await renderHome(withTask, { now: new Date("2026-09-01T12:00:00.000Z") });

    expect(await screen.findByTestId("home-task-time-left")).toHaveTextContent(
      /2 hours left to walk/,
    );
  });

  it("counts the last stretch down from the moment the alarm would have gone", async () => {
    await renderHome(withTask, { now: new Date("2026-09-01T13:40:00.000Z") });

    expect(await screen.findByTestId("home-task-time-left")).toHaveTextContent(
      /20 minutes left to walk/,
    );
  });

  it("stops asking for a walk once the deadline has gone by", async () => {
    await renderHome(withTask, { now: new Date("2026-09-01T14:30:00.000Z") });

    expect(await screen.findByTestId("home-task-morning-gone")).toHaveTextContent(
      /7:00 AM deadline passed with no walk saved/,
    );
    // The step target is the answer to a question the morning no longer asks.
    expect(screen.getByTestId("home-current-task")).not.toHaveTextContent(
      /250 steps to keep the day/,
    );
    expect(screen.getByTestId("home-open-task")).toHaveTextContent("See what happened");
    // A countdown to a deadline that passed would be counting to nothing.
    expect(screen.queryByTestId("home-task-time-left")).toBeNull();
  });

  it("withdraws the walk as the deadline goes by under an untouched screen", async () => {
    // The case the countdown exists for: a phone put down at 6:59 with the
    // walk still on offer. Home read the clock once when it drew, so without a
    // tick it would go on inviting a walk the server has stopped accepting -
    // and the user would find out by pressing it.
    jest.useFakeTimers();
    try {
      const instants = [new Date("2026-09-01T13:59:00.000Z"), new Date("2026-09-01T14:01:00.000Z")];
      let index = 0;
      await renderHome(withTask, { now: () => instants[Math.min(index++, 1)] as Date });

      expect(await screen.findByTestId("home-task-time-left")).toHaveTextContent(
        /1 minute left to walk/,
      );
      expect(screen.getByTestId("home-open-task")).toHaveTextContent("Open today's task");

      await act(async () => {
        jest.advanceTimersByTime(CLOCK_INTERVAL_MS);
      });

      expect(screen.getByTestId("home-task-morning-gone")).toHaveTextContent(
        /7:00 AM deadline passed with no walk saved/,
      );
      expect(screen.queryByTestId("home-task-time-left")).toBeNull();
      expect(screen.getByTestId("home-open-task")).toHaveTextContent("See what happened");
    } finally {
      jest.useRealTimers();
    }
  });

  it("stops asking a held walk's owner to find signal once the deadline has gone", async () => {
    await renderHome(withTask, { seed: heldWalk, now: new Date("2026-09-01T14:30:00.000Z") });

    expect(await screen.findByTestId("home-task-waiting")).toHaveTextContent(
      /deadline passed before it reached the server/,
    );
    expect(screen.getByTestId("home-task-waiting")).not.toHaveTextContent(
      /keep the app open where there is signal/,
    );
    expect(screen.queryByTestId("home-task-morning-gone")).toBeNull();
  });
});

describe("home is the door to pausing", () => {
  it("opens the pause screen for a running challenge", async () => {
    await renderHome(
      fakeApi({ getCurrentChallenge: { challenge: challengeView(), lastEnded: null } }),
    );
    await userEvent.press(await screen.findByTestId("home-open-pause"));

    expect(await screen.findByTestId("pause-screen")).toBeOnTheScreen();
    expect(screen.getByTestId("pause-status")).toHaveTextContent("Your challenge is running");
  });

  it("names the action for what it does to a paused challenge", async () => {
    await renderHome(
      fakeApi({
        getCurrentChallenge: {
          lastEnded: null,
          challenge: challengeView({ pause: { pausedAt: PAUSED_AT, expiresAt: PAUSE_EXPIRES_AT } }),
        },
      }),
    );

    expect(await screen.findByTestId("home-open-pause")).toHaveTextContent("Resume the challenge");
  });

  it("says how long a pause has stood and that it never ends by itself", async () => {
    // The pill says "Paused" and nothing else, which reads like a state the app
    // is managing. It is not: no deadline arrives and no alarm sounds until the
    // user comes back here, so home says so rather than leaving it to the one
    // screen they have no reason to open again.
    await renderHome(
      fakeApi({
        getCurrentChallenge: {
          lastEnded: null,
          challenge: challengeView({
            currentTask: null,
            pause: { pausedAt: "2026-08-29T12:00:00.000Z", expiresAt: PAUSE_EXPIRES_AT },
          }),
        },
      }),
    );

    expect(await screen.findByTestId("home-paused-days")).toHaveTextContent("Paused for 3 days.");
    expect(screen.getByTestId("home-paused-explainer")).toHaveTextContent(
      /never starts again on its own/,
    );
    expect(screen.getByTestId("home-paused-explainer")).toHaveTextContent(/no alarm will sound/);
    expect(screen.queryByTestId("home-pause-expiry")).toBeNull();
  });

  it("names the walk that stayed live rather than promising no deadline counts", async () => {
    // A task past its pause cutoff runs through the pause, and home still draws
    // it, so the banner beside it must not claim nothing is due.
    await renderHome(
      fakeApi({
        getCurrentChallenge: {
          lastEnded: null,
          challenge: challengeView({
            currentTask: taskView(),
            pause: { pausedAt: PAUSED_AT, expiresAt: PAUSE_EXPIRES_AT },
          }),
        },
      }),
    );

    expect(await screen.findByTestId("home-current-task")).toBeOnTheScreen();
    expect(screen.getByTestId("home-paused-explainer")).toHaveTextContent(
      /its deadline still counts/,
    );
  });

  it("states what happens when the pause reaches the year", async () => {
    await renderHome(
      fakeApi({
        getCurrentChallenge: {
          lastEnded: null,
          challenge: challengeView({
            currentTask: null,
            pause: {
              pausedAt: "2025-09-15T12:00:00.000Z",
              expiresAt: "2026-09-15T12:00:00.000Z",
            },
          }),
        },
      }),
    );

    expect(await screen.findByTestId("home-pause-expiry")).toHaveTextContent(/In 14 days/);
    expect(screen.getByTestId("home-pause-expiry")).toHaveTextContent(
      /neither a success nor a failure/,
    );
  });

  it("opens the pause screen from the banner a paused challenge draws", async () => {
    await renderHome(
      fakeApi({
        getCurrentChallenge: {
          lastEnded: null,
          challenge: challengeView({ pause: { pausedAt: PAUSED_AT, expiresAt: PAUSE_EXPIRES_AT } }),
        },
      }),
    );

    await userEvent.press(await screen.findByTestId("home-open-pause"));

    expect(await screen.findByTestId("pause-screen")).toBeOnTheScreen();
    expect(screen.getByTestId("pause-status")).toHaveTextContent("Your challenge is paused");
  });

  it("draws no pause banner over a challenge that is running", async () => {
    await renderHome(
      fakeApi({ getCurrentChallenge: { challenge: challengeView(), lastEnded: null } }),
    );

    expect(await screen.findByTestId("home-challenge")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-paused")).toBeNull();
    expect(screen.getByTestId("home-open-pause")).toHaveTextContent("Pause the challenge");
  });

  it("offers no pause for a challenge that has already ended", async () => {
    // Pausing a finished challenge is a press the server refuses, so it is not
    // offered rather than offered and rejected.
    await renderHome(
      fakeApi({
        getCurrentChallenge: { challenge: challengeView({ status: "succeeded" }), lastEnded: null },
      }),
    );

    expect(await screen.findByTestId("home-challenge")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-open-pause")).toBeNull();
  });

  it("comes back and re-reads the challenge once a pause went through", async () => {
    const api = fakeApi({ getCurrentChallenge: { challenge: challengeView(), lastEnded: null } });

    await renderHome(api);
    await userEvent.press(await screen.findByTestId("home-open-pause"));
    const before = api.names().filter((name) => name === "getCurrentChallenge").length;

    await userEvent.press(screen.getByTestId("pause"));
    await userEvent.press(await screen.findByTestId("pause-confirm"));

    expect(await screen.findByTestId("home-challenge")).toBeOnTheScreen();
    expect(api.names()).toContain("pauseChallenge");
    expect(api.names().filter((name) => name === "getCurrentChallenge").length).toBe(before + 1);
  });

  it("comes back without asking again when the screen is only left", async () => {
    const api = fakeApi({ getCurrentChallenge: { challenge: challengeView(), lastEnded: null } });

    await renderHome(api);
    await userEvent.press(await screen.findByTestId("home-open-pause"));
    const before = api.names().filter((name) => name === "getCurrentChallenge").length;

    await userEvent.press(screen.getByTestId("pause-back"));

    expect(await screen.findByTestId("home-challenge")).toBeOnTheScreen();
    expect(api.names()).not.toContain("pauseChallenge");
    expect(api.names().filter((name) => name === "getCurrentChallenge").length).toBe(before);
  });
});

describe("home is the door to the recovery offer", () => {
  const OFFERED = challengeView({
    status: "recovery_pending",
    recoveryOffer: {
      taskId: "44444444-4444-4444-8444-444444444444",
      offeredAt: "2026-09-01T15:00:00.000Z",
      expiresAt: "2026-09-02T15:00:00.000Z",
    },
  });

  it("opens the decision from the alert that raised it", async () => {
    await renderHome(fakeApi({ getCurrentChallenge: { challenge: OFFERED, lastEnded: null } }));
    await userEvent.press(await screen.findByTestId("home-open-recovery"));

    expect(await screen.findByTestId("recovery-screen")).toBeOnTheScreen();
    expect(screen.getByTestId("recovery-permanence")).toBeOnTheScreen();
  });

  it("offers no way in when nothing is waiting on a decision", async () => {
    await renderHome(
      fakeApi({ getCurrentChallenge: { challenge: challengeView(), lastEnded: null } }),
    );

    expect(await screen.findByTestId("home-challenge")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-open-recovery")).toBeNull();
  });

  it("comes back and re-reads the challenge once the recovery was spent", async () => {
    const api = fakeApi({ getCurrentChallenge: { challenge: OFFERED, lastEnded: null } });

    await renderHome(api);
    await userEvent.press(await screen.findByTestId("home-open-recovery"));
    const before = api.names().filter((name) => name === "getCurrentChallenge").length;

    await userEvent.press(screen.getByTestId("accept-recovery"));
    await userEvent.press(await screen.findByTestId("accept-recovery-confirm"));

    expect(await screen.findByTestId("home-challenge")).toBeOnTheScreen();
    expect(api.names()).toContain("acceptRecovery");
    expect(api.names().filter((name) => name === "getCurrentChallenge").length).toBe(before + 1);
  });

  it("comes back spending nothing when the allowance is kept", async () => {
    const api = fakeApi({ getCurrentChallenge: { challenge: OFFERED, lastEnded: null } });

    await renderHome(api);
    await userEvent.press(await screen.findByTestId("home-open-recovery"));
    await userEvent.press(screen.getByTestId("decline-recovery"));

    expect(await screen.findByTestId("home-challenge")).toBeOnTheScreen();
    expect(api.names()).not.toContain("acceptRecovery");
  });

  // The offer is the clock that decides whether the deposit is charged, and the
  // banner named only the instant it closes - a fact about the future, where
  // the question is whether to act now.
  it("says how long is left to decide, before it says when the window closes", async () => {
    await renderHome(fakeApi({ getCurrentChallenge: { challenge: OFFERED, lastEnded: null } }), {
      now: new Date("2026-09-02T12:30:00.000Z"),
    });

    expect(await screen.findByTestId("home-recovery-summary")).toHaveTextContent(
      /2 hours 30 minutes left to decide/,
    );
    expect(screen.getByTestId("home-recovery-summary")).toHaveTextContent(/closes at/);
  });

  it("withdraws the decision once the window has gone by", async () => {
    await renderHome(fakeApi({ getCurrentChallenge: { challenge: OFFERED, lastEnded: null } }), {
      now: new Date("2026-09-02T15:30:00.000Z"),
    });

    expect(await screen.findByTestId("home-recovery-summary")).toHaveTextContent(
      /the missed day stands/,
    );
    // Pressing it would have sent nothing and answered with a refusal.
    expect(screen.queryByTestId("home-open-recovery")).toBeNull();
  });
});

describe("home says what happened to the challenge that ended", () => {
  // A failure or an expiry is decided by a server sweep the app never hears,
  // so `lastEnded` on the next read is the only notice the user ever gets. Home
  // showing the empty state instead would mean a charged deposit was something
  // they found out from their card statement.
  it("names the deposit a failed challenge charged", async () => {
    await renderHome(
      fakeApi({
        getCurrentChallenge: {
          challenge: null,
          lastEnded: endedChallenge({
            status: "failed",
            requiredTaskCount: 30,
            completedTaskCount: 12,
            deposit: { amount: 2000, currency: "USD" },
            depositOutcome: "charged",
          }),
        },
      }),
    );

    expect(await screen.findByTestId("home-finished")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-no-challenge")).toBeNull();
    expect(screen.getByTestId("home-finished-status")).toHaveTextContent(/ended short/);
    expect(screen.getByTestId("home-finished-days")).toHaveTextContent(/12 \/ 30 days done/);
    expect(screen.getByTestId("home-finished-deposit")).toHaveTextContent(
      /\$20\.00 deposit was charged/,
    );
  });

  it("says an expired challenge kept its deposit", async () => {
    await renderHome(
      fakeApi({
        getCurrentChallenge: {
          challenge: null,
          lastEnded: endedChallenge({ status: "expired", depositOutcome: "kept" }),
        },
      }),
    );

    expect(await screen.findByTestId("home-finished-status")).toHaveTextContent(/expired/);
    expect(screen.getByTestId("home-finished-deposit")).toHaveTextContent(/released, not charged/);
  });

  it("puts the outcome down when the user says they have read it", async () => {
    // The server keeps reporting the last outcome until another challenge
    // exists, which is right for someone opening the app to find out and wrong
    // for someone who came back for something else.
    await renderHome(
      fakeApi({ getCurrentChallenge: { challenge: null, lastEnded: endedChallenge() } }),
    );
    await userEvent.press(await screen.findByTestId("home-finished-dismiss"));

    expect(await screen.findByTestId("home-no-challenge")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-finished")).toBeNull();
  });

  it("does not show it beside a challenge that is running", async () => {
    await renderHome(
      fakeApi({
        getCurrentChallenge: { challenge: challengeView(), lastEnded: endedChallenge() },
      }),
    );

    expect(await screen.findByTestId("home-challenge")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-finished")).toBeNull();
  });
});

describe("home is the door to deleting the account", () => {
  it("is reachable for an account holding no challenge", async () => {
    // The App Store requires deletion from inside the app, and an account with
    // nothing running is exactly the one most likely to want it.
    await renderHome(fakeApi({ getCurrentChallenge: { challenge: null, lastEnded: null } }));
    await userEvent.press(await screen.findByTestId("home-delete-account"));

    expect(await screen.findByTestId("delete-account-screen")).toBeOnTheScreen();
    expect(screen.getByTestId("delete-account")).toBeOnTheScreen();
  });

  it("hands the screen the live challenge, so a funded one blocks deletion", async () => {
    await renderHome(
      fakeApi({
        getCurrentChallenge: {
          lastEnded: null,
          challenge: challengeView({
            configuration: {
              ...challengeView().configuration,
              deposit: { amount: 5000, currency: "USD" },
            },
          }),
        },
      }),
    );
    await userEvent.press(await screen.findByTestId("home-delete-account"));

    expect(await screen.findByTestId("deletion-blocked")).toBeOnTheScreen();
    expect(screen.queryByTestId("delete-account")).toBeNull();
  });

  it("comes back to home when the screen is left", async () => {
    const api = fakeApi({ getCurrentChallenge: { challenge: null, lastEnded: null } });

    await renderHome(api);
    await userEvent.press(await screen.findByTestId("home-delete-account"));
    await userEvent.press(screen.getByTestId("delete-back"));

    expect(await screen.findByTestId("home-no-challenge")).toBeOnTheScreen();
    expect(api.names()).not.toContain("deleteAccount");
  });
});

describe("home's own actions", () => {
  it("asks the server again when refreshed", async () => {
    const api = fakeApi({ getCurrentChallenge: { challenge: null, lastEnded: null } });

    await renderHome(api);
    await screen.findByTestId("home-no-challenge");
    const before = api.names().filter((name) => name === "getCurrentChallenge").length;

    await userEvent.press(screen.getByTestId("home-refresh"));

    await waitFor(() =>
      expect(api.names().filter((name) => name === "getCurrentChallenge").length).toBe(before + 1),
    );
  });

  it("keeps the challenge on screen while a hand refresh is in flight", async () => {
    // Pressing Refresh used to replace the whole screen with a spinner, hiding
    // the numbers the press was there to check.
    const api = fakeApi({ getCurrentChallenge: answers(runningChallenge(), pending()) });

    await renderHome(api);
    await screen.findByTestId("home-challenge");
    await userEvent.press(screen.getByTestId("home-refresh"));

    expect(screen.getByTestId("home-challenge")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-loading")).toBeNull();
    expect(screen.getByTestId("home-refresh")).toHaveTextContent("Checking for updates");
  });

  it("offers sign out only when the caller owns it", async () => {
    await renderHome(fakeApi());
    expect(await screen.findByTestId("home")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-sign-out")).toBeNull();
  });
});

describe("home and a phone picked up again", () => {
  it("asks the server again when the app comes back to the front", async () => {
    // Everything on this screen is tied to a moment: which task is open, when
    // it is due, whether a recovery offer is still there. A phone that has been
    // in a pocket overnight is showing last night's answer.
    const appReturn = fakeAppReturn();
    const api = fakeApi({ getCurrentChallenge: runningChallenge() });

    await renderHome(api, { appReturn: appReturn.trigger });
    await screen.findByTestId("home-challenge");
    const before = reads(api);

    await appReturn.fire();

    await waitFor(() => expect(reads(api)).toBe(before + 1));
    // And settled: the label is the read's own progress indicator, so waiting
    // for it back keeps the answer inside the test that asked for it.
    await waitFor(() => expect(screen.getByTestId("home-refresh")).toHaveTextContent("Refresh"));
  });

  it("leaves what is on screen alone while the re-read is in flight", async () => {
    const appReturn = fakeAppReturn();
    const api = fakeApi({ getCurrentChallenge: answers(runningChallenge(), pending()) });

    await renderHome(api, { appReturn: appReturn.trigger });
    await screen.findByTestId("home-challenge");

    await appReturn.fire();

    expect(screen.getByTestId("home-challenge")).toBeOnTheScreen();
    expect(screen.getByTestId("home-current-task")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-loading")).toBeNull();
  });

  it("shows what the server now says once the re-read lands", async () => {
    const appReturn = fakeAppReturn();
    const api = fakeApi({
      getCurrentChallenge: answers(runningChallenge(), {
        lastEnded: null,
        challenge: challengeView({
          currentTask: taskView(),
          progress: {
            requiredTaskCount: 30,
            completedTaskCount: 7,
            skippedTaskCount: 0,
            forgivenTaskCount: 0,
          },
        }),
      }),
    });

    await renderHome(api, { appReturn: appReturn.trigger });
    await screen.findByTestId("home-challenge");
    expect(screen.getByTestId("home-progress")).toHaveTextContent("0 of 30 days done, 30 to go.");

    await appReturn.fire();

    await waitFor(() =>
      expect(screen.getByTestId("home-progress")).toHaveTextContent("7 of 30 days done, 23 to go."),
    );
  });

  it("does not re-read while another screen is open over home", async () => {
    // A read landing under the pause screen would take it away mid-decision.
    const appReturn = fakeAppReturn();
    const api = fakeApi({ getCurrentChallenge: runningChallenge() });

    await renderHome(api, { appReturn: appReturn.trigger });
    await userEvent.press(await screen.findByTestId("home-open-pause"));
    await screen.findByTestId("pause-screen");
    const before = reads(api);

    await appReturn.fire();

    expect(reads(api)).toBe(before);
    expect(appReturn.listening()).toBe(0);
    expect(screen.getByTestId("pause-screen")).toBeOnTheScreen();
  });

  it("keeps the last answer and says it is the last one when the re-read fails", async () => {
    const appReturn = fakeAppReturn();
    const api = fakeApi({
      getCurrentChallenge: answers(runningChallenge(), () => {
        throw new ApiError("internal_error", "fetch failed", { status: null });
      }),
    });

    await renderHome(api, { appReturn: appReturn.trigger });
    await screen.findByTestId("home-challenge");

    await appReturn.fire();

    expect(await screen.findByTestId("home-refresh-failed")).toHaveTextContent(
      /last connection's answer/,
    );
    expect(screen.getByTestId("home-challenge")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-error")).toBeNull();
  });

  it("clears the stale warning once a later re-read lands", async () => {
    const appReturn = fakeAppReturn();
    const api = fakeApi({
      getCurrentChallenge: answers(
        runningChallenge(),
        () => {
          throw new ApiError("internal_error", "fetch failed", { status: null });
        },
        runningChallenge(),
      ),
    });

    await renderHome(api, { appReturn: appReturn.trigger });
    await screen.findByTestId("home-challenge");
    await appReturn.fire();
    await screen.findByTestId("home-refresh-failed");

    await appReturn.fire();

    await waitFor(() => expect(screen.queryByTestId("home-refresh-failed")).toBeNull());
  });
});

describe("home and the device's reminders", () => {
  const running = (overrides = {}) =>
    fakeApi({
      getCurrentChallenge: {
        lastEnded: null,
        challenge: challengeView({ currentTask: taskView(), ...overrides }),
      },
    });

  it("offers reminders by naming the time it would wake the user", async () => {
    // The whole product is being at the phone before a wall-clock time, so a
    // challenge on a silent device is the quietest way to lose a deposit.
    const notifier = fakeNotifier({ permission: "undetermined" });

    await renderHome(running(), { notifier });

    expect(await screen.findByTestId("home-reminders-offer")).toHaveTextContent(/6:15 AM/);
    expect(screen.getByTestId("home-enable-reminders")).toBeOnTheScreen();
    // Never asked before it is pressed: iOS gives an app one prompt for the
    // lifetime of an install.
    expect(notifier.requests).toBe(0);
    expect(notifier.scheduled).toHaveLength(0);
  });

  it("schedules the challenge's reminders when the user turns them on", async () => {
    const notifier = fakeNotifier({ permission: "undetermined", onRequest: "granted" });

    await renderHome(running(), { notifier });
    await userEvent.press(await screen.findByTestId("home-enable-reminders"));

    expect(await screen.findByTestId("home-reminders-on")).toHaveTextContent(/6:15 AM/);
    await waitFor(() => expect(notifier.scheduled).toHaveLength(1));
    expect(notifier.scheduled.at(-1)?.map((reminder) => reminder.id)).toEqual([
      "44444444-4444-4444-8444-444444444444:alarm",
      "44444444-4444-4444-8444-444444444444:last-call",
    ]);
  });

  it("schedules without asking again once the device has already agreed", async () => {
    const notifier = fakeNotifier({ permission: "granted" });

    await renderHome(running(), { notifier });

    expect(await screen.findByTestId("home-reminders-on")).toBeOnTheScreen();
    await waitFor(() => expect(notifier.scheduled).toHaveLength(1));
    expect(notifier.requests).toBe(0);
    expect(screen.queryByTestId("home-enable-reminders")).toBeNull();
  });

  it("says where to turn them back on when the device has refused", async () => {
    const notifier = fakeNotifier({ permission: "denied" });

    await renderHome(running(), { notifier });

    expect(await screen.findByTestId("home-reminders-denied")).toHaveTextContent(/device settings/);
    expect(screen.queryByTestId("home-enable-reminders")).toBeNull();
  });

  it("opens those settings rather than only naming them", async () => {
    // The app cannot ask again once the device has refused, so the sentence is
    // the whole of the fix and it has to be one press away.
    const notifier = fakeNotifier({ permission: "denied" });
    const settings = fakeSettings();

    await renderHome(running(), { notifier, settings });

    await userEvent.setup().press(await screen.findByTestId("home-reminders-settings"));
    expect(settings.opened).toBe(1);
  });

  it("says nothing about reminders while the challenge is paused", async () => {
    // Nothing is due, so an alarm would be waking someone for a walk the server
    // is not judging them on.
    const notifier = fakeNotifier({ permission: "granted" });

    await renderHome(running({ pause: { pausedAt: PAUSED_AT, expiresAt: PAUSE_EXPIRES_AT } }), {
      notifier,
    });

    expect(await screen.findByTestId("home-challenge")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-reminders-on")).toBeNull();
    await waitFor(() => expect(notifier.scheduled).toHaveLength(1));
    expect(notifier.scheduled.at(-1)).toEqual([]);
  });

  it("clears the device's reminders once the account holds no challenge", async () => {
    const notifier = fakeNotifier({ permission: "granted" });

    await renderHome(fakeApi({ getCurrentChallenge: { challenge: null, lastEnded: null } }), {
      notifier,
    });

    expect(await screen.findByTestId("home-no-challenge")).toBeOnTheScreen();
    await waitFor(() => expect(notifier.scheduled).toHaveLength(1));
    expect(notifier.scheduled.at(-1)).toEqual([]);
  });
});

/**
 * The morning after it is kept. The server hands out one open task at a time,
 * so the moment today's walk lands the open task is tomorrow's - and home drew
 * it exactly as it had drawn today's, down to a button inviting a walk whose
 * completion the server refuses for falling outside that task's own day.
 */
describe("a morning already kept", () => {
  /** Los Angeles teatime on the first day, with that day's walk behind them. */
  const AFTERNOON = new Date("2026-09-01T20:00:00.000Z");

  function afterTodaysWalk(keptDays: number) {
    return fakeApi({
      getCurrentChallenge: {
        lastEnded: null,
        challenge: challengeView({
          progress: {
            requiredTaskCount: 30,
            completedTaskCount: keptDays,
            skippedTaskCount: 0,
            forgivenTaskCount: 0,
          },
          days: challengeDays(30, "scheduled").map((day, index) =>
            index < keptDays ? { ...day, status: "completed" as const } : day,
          ),
          currentTask: taskView({
            id: "44444444-4444-4444-8444-444444444445",
            date: "2026-09-02",
            deadline: "2026-09-02T14:00:00.000Z",
            pauseCutoff: "2026-09-02T06:00:00.000Z",
          }),
        }),
      },
    });
  }

  it("says the day is done rather than only marking a square", async () => {
    await renderHome(afterTodaysWalk(1), { now: AFTERNOON });

    expect(await screen.findByTestId("home-walked-today-text")).toHaveTextContent(
      /Today's walk is done. Nothing else is due today./,
    );
  });

  it("names the run once the walk continues one", async () => {
    await renderHome(afterTodaysWalk(3), { now: AFTERNOON });

    expect(await screen.findByTestId("home-walked-today-text")).toHaveTextContent(
      /That is 3 days in a row./,
    );
  });

  it("offers no way to walk a morning that has not started", async () => {
    await renderHome(afterTodaysWalk(1), { now: AFTERNOON });

    expect(await screen.findByTestId("home-task-opens")).toHaveTextContent(
      /opens tomorrow morning and has to be walked then, by 7:00 AM/,
    );
    // The whole point: the server would refuse a walk taken tonight for it.
    expect(screen.queryByTestId("home-open-task")).toBeNull();
    // Counting twenty hours down to a morning nobody is being asked about yet.
    expect(screen.queryByTestId("home-task-time-left")).toBeNull();
  });

  it("leaves this morning's own walk on offer", async () => {
    await renderHome(
      fakeApi({
        getCurrentChallenge: {
          lastEnded: null,
          challenge: challengeView({ currentTask: taskView() }),
        },
      }),
      { now: new Date("2026-09-01T12:00:00.000Z") },
    );

    expect(await screen.findByTestId("home-open-task")).toHaveTextContent("Open today's task");
    expect(screen.queryByTestId("home-walked-today")).toBeNull();
    expect(screen.queryByTestId("home-task-opens")).toBeNull();
  });
});
