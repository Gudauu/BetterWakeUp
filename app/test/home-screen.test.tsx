/**
 * Home is the screen a signed-in account lands on, so these tests are about
 * what it says the account is in the middle of, and about the one thing it
 * must never do: offer to start a second challenge over a live one.
 */

import { fireEvent, render, screen, userEvent, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { ApiClient } from "../src/api/client.ts";
import { ApiError } from "../src/api/errors.ts";
import { HomeScreen } from "../src/screens/home-screen.tsx";
import { SessionProvider } from "../src/session/session-context.tsx";
import { createMemorySessionStore } from "../src/session/session-store.ts";
import {
  challengeView,
  endedChallenge,
  type FakeApi,
  fakeApi,
  PAUSE_EXPIRES_AT,
  PAUSED_AT,
  taskView,
} from "./support/fake-api.ts";
import {
  type FakeCompletionRuntime,
  fakeCompletionRuntimeFactory,
} from "./support/fake-completion-runtime.ts";
import { fakeProviders } from "./support/fake-providers.ts";

const SESSION = {
  accountId: "11111111-1111-4111-8111-111111111111",
  token: "session-token",
  expiresAt: "2027-01-01T00:00:00.000Z",
};

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

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
  } = {},
) {
  // Home holds a completion runtime for as long as it is on screen, so every
  // one of these tests gets one with no device under it.
  const createRuntime = fakeCompletionRuntimeFactory(
    options.onRuntimeOpened === undefined ? {} : { onOpened: options.onRuntimeOpened },
  );
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <SessionProvider
        store={createMemorySessionStore(SESSION)}
        createClient={() => api}
        providers={fakeProviders()}
      >
        <HomeScreen
          createRuntime={createRuntime}
          deviceTimeZone={options.deviceTimeZone ?? "America/Los_Angeles"}
          {...(options.onSignOut === undefined ? {} : { onSignOut: options.onSignOut })}
        />
      </SessionProvider>
    </SafeAreaProvider>,
  );
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
          challenge: challengeView({
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

  it("offers sign out only when the caller owns it", async () => {
    await renderHome(fakeApi());
    expect(await screen.findByTestId("home")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-sign-out")).toBeNull();
  });
});
