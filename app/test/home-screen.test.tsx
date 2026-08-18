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
import { challengeView, type FakeApi, fakeApi, taskView } from "./support/fake-api.ts";
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
          {...(options.onSignOut === undefined ? {} : { onSignOut: options.onSignOut })}
        />
      </SessionProvider>
    </SafeAreaProvider>,
  );
}

describe("home reads the account's current challenge", () => {
  it("offers to start one when the account holds none", async () => {
    await renderHome(fakeApi({ getCurrentChallenge: { challenge: null } }));

    expect(await screen.findByTestId("home-no-challenge")).toBeOnTheScreen();
    expect(screen.getByTestId("home-create-challenge")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-challenge")).toBeNull();
  });

  it("shows the running challenge and never offers to start another", async () => {
    // Only one challenge runs at a time, and a home screen that offered the
    // form anyway would be sending the user at a request the server refuses.
    const api = fakeApi({
      getCurrentChallenge: {
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
        return { challenge: challengeView() };
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
      getCurrentChallenge: () => ({ challenge: created ? challengeView() : null }),
      createChallenge: () => {
        created = true;
        return { challenge: challengeView() };
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
    const api = fakeApi({ getCurrentChallenge: { challenge: null } });

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
      fakeApi({ getCurrentChallenge: { challenge: challengeView({ currentTask: taskView() }) } }),
    );
    await userEvent.press(await screen.findByTestId("home-open-task"));

    expect(await screen.findByTestId("daily-completion")).toBeOnTheScreen();
    expect(screen.getByTestId("start-capture")).toBeOnTheScreen();
  });

  it("offers no way in when nothing is due", async () => {
    await renderHome(fakeApi({ getCurrentChallenge: { challenge: challengeView() } }));

    expect(await screen.findByTestId("home-no-task")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-open-task")).toBeNull();
  });

  it("comes back to home and re-reads the challenge", async () => {
    const api = fakeApi({
      getCurrentChallenge: { challenge: challengeView({ currentTask: taskView() }) },
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
    const api = fakeApi({ getCurrentChallenge: { challenge: null } });

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

describe("home's own actions", () => {
  it("asks the server again when refreshed", async () => {
    const api = fakeApi({ getCurrentChallenge: { challenge: null } });

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
