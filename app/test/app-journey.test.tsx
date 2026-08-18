/**
 * The app from the outside, in one sitting.
 *
 * Every other suite here mounts one screen with its answers arranged. This one
 * starts where a person starts - the signed-out welcome screen - and does not
 * arrange anything: it signs in, finds home empty, fills the real form, walks
 * today's task through the simulated step counter a development build ships,
 * watches home read the result back, pauses and resumes, and deletes the
 * account. Nothing is passed between the steps except what the app itself put
 * on screen.
 *
 * That is the check no per-screen suite can make. A screen whose props are
 * never supplied, a return trip that forgets to re-read, or an action that is
 * offered in a state the server refuses all pass their own tests and fail here.
 */

import { disclosuresFor } from "@betterwakeup/contract";
import { fireEvent, render, screen, userEvent, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { WelcomeScreen } from "../src/screens/welcome-screen.tsx";
import { SessionProvider } from "../src/session/session-context.tsx";
import { createMemorySessionStore } from "../src/session/session-store.ts";
import { simulatedCompletionRuntimeFactory } from "./support/fake-completion-runtime.ts";
import { fakeProviders } from "./support/fake-providers.ts";
import { type JourneyServer, journeyServer } from "./support/journey-server.ts";

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/** The default draft's day count, which the challenge is created with. */
const REQUIRED_TASK_COUNT = 30;

/** The default draft's step target, which the simulation walks up to. */
const STEP_TARGET = 250;

/**
 * The app as `app/index.tsx` renders it, minus the two things a test machine
 * has no version of: the native sign-in SDKs and the device's step counter.
 * The session store, the screens, the navigation, the on-device database and
 * the completion sync are the shipped ones.
 */
async function launch(server: JourneyServer) {
  const store = createMemorySessionStore(null);
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <SessionProvider store={store} createClient={() => server} providers={fakeProviders()}>
        <WelcomeScreen createRuntime={simulatedCompletionRuntimeFactory()} />
      </SessionProvider>
    </SafeAreaProvider>,
  );
  return { store };
}

describe("one account's life through the app's own screens", () => {
  it("signs in, starts a challenge, walks the day, pauses, and deletes the account", async () => {
    const server = journeyServer();
    const { store } = await launch(server);
    const user = userEvent.setup();

    // Signed out, with the provider this build and device can use.
    expect(await screen.findByTestId("welcome-signed-out")).toBeOnTheScreen();

    await user.press(screen.getByTestId("sign-in-apple"));

    // Home, not the create form: a signed-in account lands on the screen that
    // says what it is in the middle of.
    expect(await screen.findByTestId("home-no-challenge")).toBeOnTheScreen();
    expect(await store.read()).not.toBeNull();

    // Start a challenge, through the real form and its real gates.
    await user.press(screen.getByTestId("home-create-challenge"));
    await waitFor(() => expect(screen.queryByTestId("projection")).not.toBeNull());

    await fireEvent(screen.getByTestId("confirm-time-zone"), "valueChange", true);
    for (const disclosure of disclosuresFor(0)) {
      await fireEvent(screen.getByTestId(`disclosure-${disclosure.id}`), "valueChange", true);
    }

    await user.press(screen.getByTestId("start-challenge"));

    // Home read the new challenge back from the server rather than trusting
    // what the form held.
    expect(await screen.findByTestId("home-challenge")).toBeOnTheScreen();
    expect(screen.getByTestId("home-progress")).toHaveTextContent(
      new RegExp(`0 of ${REQUIRED_TASK_COUNT} days done`),
    );
    // A zero deposit challenge is created without any payment step.
    expect(server.names()).not.toContain("createFundingIntent");

    // Today's task, walked with the development build's step controls.
    await user.press(screen.getByTestId("home-open-task"));
    expect(await screen.findByTestId("daily-completion")).toBeOnTheScreen();

    await user.press(screen.getByTestId("start-capture"));
    await user.press(screen.getByTestId("simulate-enough-steps"));
    await user.press(screen.getByTestId("stop-capture"));

    // The server acknowledged it, and the steps that reached it are the ones
    // the capture counted.
    await waitFor(() => expect(server.completions()).toHaveLength(1));
    expect(server.completions()[0]?.observation).toMatchObject({
      steps: STEP_TARGET,
      provenance: "live-foreground",
    });
    // The screen says the day is done rather than offering to start it again:
    // the server's own answer replaced the task view the walk began with.
    await waitFor(() =>
      expect(screen.getByTestId("server-check-state")).toHaveTextContent("passed"),
    );
    expect(screen.getByTestId("progression")).toHaveTextContent(/Done/);
    expect(screen.queryByTestId("start-capture")).toBeNull();

    // Home counts the day once it re-reads the challenge on the way back.
    await user.press(screen.getByTestId("daily-back"));
    expect(await screen.findByTestId("home-progress")).toHaveTextContent(
      new RegExp(`1 of ${REQUIRED_TASK_COUNT} days done`),
    );

    // And the account can be deleted, from home, in two presses.
    await user.press(screen.getByTestId("home-delete-account"));
    await user.press(await screen.findByTestId("delete-account"));
    await user.press(screen.getByTestId("delete-account-confirm"));

    // Deleting signs out: there is no account left to read.
    expect(await screen.findByTestId("welcome-signed-out")).toBeOnTheScreen();
    expect(await store.read()).toBeNull();
  });

  it("pauses and resumes a running challenge from home", async () => {
    // A separate journey because pausing is only offered while a challenge is
    // running, and the first one deliberately finishes its challenge.
    const server = journeyServer();
    await launch(server);
    const user = userEvent.setup();

    await user.press(await screen.findByTestId("sign-in-apple"));
    await user.press(await screen.findByTestId("home-create-challenge"));
    await waitFor(() => expect(screen.queryByTestId("projection")).not.toBeNull());
    await fireEvent(screen.getByTestId("confirm-time-zone"), "valueChange", true);
    for (const disclosure of disclosuresFor(0)) {
      await fireEvent(screen.getByTestId(`disclosure-${disclosure.id}`), "valueChange", true);
    }
    await user.press(screen.getByTestId("start-challenge"));

    expect(await screen.findByTestId("home-challenge")).toBeOnTheScreen();

    await user.press(screen.getByTestId("home-open-pause"));
    await user.press(await screen.findByTestId("pause"));
    await user.press(screen.getByTestId("pause-confirm"));

    // The command returns to home, which re-reads the challenge: the paused
    // state on screen is the server's, and nothing is due while it holds.
    expect(await screen.findByTestId("home-challenge-status")).toHaveTextContent("Paused");
    expect(screen.getByTestId("home-no-task")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-open-task")).toBeNull();

    // Resuming puts a live task back in front of the user.
    await user.press(screen.getByTestId("home-open-pause"));
    await user.press(await screen.findByTestId("resume"));
    await user.press(screen.getByTestId("resume-confirm"));

    expect(await screen.findByTestId("home-challenge-status")).toHaveTextContent(
      "Challenge running",
    );
    expect(screen.getByTestId("home-current-task")).toBeOnTheScreen();
  });
});
