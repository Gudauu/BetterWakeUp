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
import { fakeAppReturn } from "./support/fake-app-return.ts";
import { simulatedCompletionRuntimeFactory } from "./support/fake-completion-runtime.ts";
import { fakeNotifier } from "./support/fake-notifier.ts";
import { fakePaymentSheet } from "./support/fake-payment-sheet.ts";
import { createFakePedometer } from "./support/fake-pedometer.ts";
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

/** Twenty dollars, as the funded journey types it into the deposit field. */
const DEPOSIT_MINOR_UNITS = 2000;

/**
 * The app as `app/index.tsx` renders it, minus the two things a test machine
 * has no version of: the native sign-in SDKs and the device's step counter.
 * The session store, the screens, the navigation, the on-device database and
 * the completion sync are the shipped ones.
 */
async function launch(server: JourneyServer) {
  const store = createMemorySessionStore(null);
  // A device that has not been asked about notifications yet, which is the
  // state a freshly installed app is in.
  const notifier = fakeNotifier({ permission: "undetermined" });
  // The provider's sheet, which a test machine has no version of either: the
  // user confirms the card, and the hold is still confirmed by the webhook.
  const paymentSheet = fakePaymentSheet();
  // The phone being put away and picked up again, which is how a user hears
  // about anything the server decided while they were not looking.
  const appReturn = fakeAppReturn();
  // The step counter the setup screen asks about before a deposit is staked on
  // it: present and allowed, which is what a phone this app is meant for is.
  const movementDevice = createFakePedometer();
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <SessionProvider store={store} createClient={() => server} providers={fakeProviders()}>
        <WelcomeScreen
          createRuntime={simulatedCompletionRuntimeFactory()}
          notifier={notifier}
          paymentSheet={paymentSheet}
          appReturn={appReturn.trigger}
          movementDevice={movementDevice}
        />
      </SessionProvider>
    </SafeAreaProvider>,
  );
  return { store, notifier, paymentSheet, appReturn, movementDevice };
}

describe("one account's life through the app's own screens", () => {
  it("signs in, starts a challenge, walks the day, pauses, and deletes the account", async () => {
    const server = journeyServer();
    const { store, notifier } = await launch(server);
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

    // The device is offered the alarm and scheduled it: everything after this
    // depends on the user being at their phone before a wall-clock deadline,
    // and until they say yes nothing on the device would tell them.
    await user.press(screen.getByTestId("home-enable-reminders"));
    // The empty set the signed-out launch cleared the device with is the first
    // one; what the alarm produced is the last.
    await waitFor(() =>
      expect(notifier.scheduled.at(-1)?.map((reminder) => reminder.title)).toEqual([
        "Time to get moving",
        expect.stringContaining("Last call"),
      ]),
    );

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
    // And the morning that was walked is a kept day on the row, which is the
    // one place the month reads as something other than a fraction.
    expect(screen.getByTestId("home-day-strip")).toHaveProp(
      "accessibilityLabel",
      `Your days: 1 kept, ${REQUIRED_TASK_COUNT - 1} still to come.`,
    );
    // Home says the morning is done and stops asking for a walk: the open task
    // is now tomorrow's, and the server refuses a completion taken for it
    // before its own day starts.
    expect(screen.getByTestId("home-walked-today-text")).toHaveTextContent(/Today's walk is done/);
    expect(screen.getByTestId("home-task-opens")).toHaveTextContent(/opens tomorrow morning/);
    expect(screen.queryByTestId("home-open-task")).toBeNull();

    // And the account can be deleted, from home, in two presses.
    await user.press(screen.getByTestId("home-delete-account"));
    await user.press(await screen.findByTestId("delete-account"));
    await user.press(screen.getByTestId("delete-account-confirm"));

    // Deleting signs out: there is no account left to read.
    expect(await screen.findByTestId("welcome-signed-out")).toBeOnTheScreen();
    expect(await store.read()).toBeNull();
  });

  it("stakes a deposit and lands on the running challenge once the hold clears", async () => {
    // The money path, which no other test walks end to end. The challenge does
    // not exist when the app finishes asking for it: the provider confirms the
    // hold out of band, so the app has to notice on its own.
    const server = journeyServer();
    const { paymentSheet } = await launch(server);
    const user = userEvent.setup();

    await user.press(await screen.findByTestId("sign-in-apple"));
    await user.press(await screen.findByTestId("home-create-challenge"));
    await waitFor(() => expect(screen.queryByTestId("projection")).not.toBeNull());

    // Twenty dollars, typed the way a person types money.
    await fireEvent.changeText(screen.getByTestId("field-deposit"), "20");
    await fireEvent(screen.getByTestId("confirm-time-zone"), "valueChange", true);
    for (const disclosure of disclosuresFor(DEPOSIT_MINOR_UNITS)) {
      await fireEvent(screen.getByTestId(`disclosure-${disclosure.id}`), "valueChange", true);
    }

    await waitFor(() => expect(screen.queryByTestId("deposit-and-start")).not.toBeNull());
    await user.press(screen.getByTestId("deposit-and-start"));

    // A card first: the hold is authorized on the device, at the provider's own
    // sheet, with the secret the funding intent carried.
    expect(await screen.findByTestId("challenge-funding")).toBeOnTheScreen();
    await waitFor(() => expect(paymentSheet.presented).toHaveLength(1));
    expect(paymentSheet.presented[0]?.amountMinorUnits).toBe(DEPOSIT_MINOR_UNITS);

    // A hold, not a challenge: the app is waiting on somebody else.
    expect(await screen.findByTestId("funding-waiting")).toBeOnTheScreen();
    expect(server.names()).toContain("createFundingIntent");
    expect(server.names()).not.toContain("createChallenge");
    expect(server.challenge()).toBeNull();

    // The provider's webhook lands. Nothing on screen was pressed.
    server.confirmFunding();

    expect(await screen.findByTestId("home-challenge", {}, { timeout: 10_000 })).toBeOnTheScreen();
    expect(screen.getByTestId("home-deposit")).toHaveTextContent(/\$20\.00/);
    expect(screen.getByTestId("home-current-task")).toBeOnTheScreen();
    // With money now on the line, home says what one missed morning would cost
    // and whether the lifetime allowance is still there to answer it.
    expect(screen.getByTestId("home-miss-cost")).toHaveTextContent(
      /one lifetime Emergency Recovery/,
    );
  }, 30_000);

  it("puts a new card behind a deposit whose hold stopped being renewed", async () => {
    // A hold does not last a month, and a card can expire under it. Home has
    // said "your card no longer secures this deposit" since the field existed,
    // with nothing behind the sentence to press, so a user in this state could
    // do nothing about it from inside the app.
    const server = journeyServer();
    const { paymentSheet } = await launch(server);
    const user = userEvent.setup();

    await user.press(await screen.findByTestId("sign-in-apple"));
    await user.press(await screen.findByTestId("home-create-challenge"));
    await waitFor(() => expect(screen.queryByTestId("projection")).not.toBeNull());

    await fireEvent.changeText(screen.getByTestId("field-deposit"), "20");
    await fireEvent(screen.getByTestId("confirm-time-zone"), "valueChange", true);
    for (const disclosure of disclosuresFor(DEPOSIT_MINOR_UNITS)) {
      await fireEvent(screen.getByTestId(`disclosure-${disclosure.id}`), "valueChange", true);
    }
    await waitFor(() => expect(screen.queryByTestId("deposit-and-start")).not.toBeNull());
    await user.press(screen.getByTestId("deposit-and-start"));
    await waitFor(() => expect(paymentSheet.presented).toHaveLength(1));
    server.confirmFunding();

    expect(await screen.findByTestId("home-challenge", {}, { timeout: 10_000 })).toBeOnTheScreen();

    // Weeks later the renewal fails behind the user's back.
    server.lapsePaymentMethod();
    await user.press(screen.getByTestId("home-refresh"));

    expect(await screen.findByTestId("home-deposit-unsecured")).toBeOnTheScreen();
    await user.press(screen.getByTestId("home-open-payment-method"));

    expect(await screen.findByTestId("payment-method-screen")).toBeOnTheScreen();
    await user.press(screen.getByTestId("payment-method-add"));

    expect(await screen.findByTestId("payment-method-done")).toBeOnTheScreen();
    expect(paymentSheet.collections()).toBe(1);
    expect(server.challenge()?.depositSecured).toBe(true);

    // And home reads it back rather than still warning about the old card.
    await user.press(screen.getByTestId("payment-method-done-back"));
    expect(await screen.findByTestId("home-challenge")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-deposit-unsecured")).toBeNull();
  }, 30_000);

  it("says the challenge is finished, on the task screen and back on home", async () => {
    // The end of the product. `GET /challenges/current` answers null for a
    // finished challenge, so without the app holding on to what it just
    // finished, a completed challenge would read as an account that never had
    // one - the same empty screen a new user sees.
    const server = journeyServer();
    await launch(server);
    const user = userEvent.setup();

    await user.press(await screen.findByTestId("sign-in-apple"));
    await user.press(await screen.findByTestId("home-create-challenge"));
    await waitFor(() => expect(screen.queryByTestId("projection")).not.toBeNull());

    // A one day challenge, so the first walk is also the last one.
    await fireEvent.changeText(screen.getByTestId("field-required-task-count"), "1");
    await fireEvent(screen.getByTestId("confirm-time-zone"), "valueChange", true);
    for (const disclosure of disclosuresFor(0)) {
      await fireEvent(screen.getByTestId(`disclosure-${disclosure.id}`), "valueChange", true);
    }
    await user.press(screen.getByTestId("start-challenge"));

    expect(await screen.findByTestId("home-challenge")).toBeOnTheScreen();

    await user.press(screen.getByTestId("home-open-task"));
    await user.press(await screen.findByTestId("start-capture"));
    await user.press(screen.getByTestId("simulate-enough-steps"));
    await user.press(screen.getByTestId("stop-capture"));

    // The server said this completion finished the challenge, so the screen
    // says so rather than promising another morning.
    expect(await screen.findByTestId("challenge-finished")).toBeOnTheScreen();
    expect(screen.getByTestId("challenge-finished-days")).toHaveTextContent(
      /That was the day this challenge asked for/,
    );
    expect(screen.getByTestId("daily-status")).not.toHaveTextContent(/until tomorrow/);

    // Home has nothing left to read, and still opens with the finish rather
    // than with the empty state.
    await user.press(screen.getByTestId("challenge-finished-home"));
    expect(await screen.findByTestId("home-finished")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-no-challenge")).toBeNull();
    expect(screen.getByTestId("home-finished-days")).toHaveTextContent(/1 day, all yours/);

    // And the way on from it is another challenge.
    await user.press(screen.getByTestId("home-create-challenge"));
    await waitFor(() => expect(screen.queryByTestId("projection")).not.toBeNull());
  });

  it("tells the user their challenge failed and their deposit went with it", async () => {
    // The losing end. Nothing on screen causes it: the deadline passes, the
    // server's sweep fails the challenge, and the next read is the whole of
    // the notice. Before the server carried an outcome, this month read as an
    // account that had never held a challenge.
    const server = journeyServer();
    const { appReturn } = await launch(server);
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

    // The morning goes by unwalked, and the sweep decides it. The user never
    // presses anything: they pick the phone up later in the day, and the app
    // asks again on its own.
    server.missDeadline();
    await appReturn.fire();

    expect(await screen.findByTestId("home-finished")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-no-challenge")).toBeNull();
    expect(screen.getByTestId("home-finished-status")).toHaveTextContent(/ended short/);
    expect(screen.getByTestId("home-finished-days")).toHaveTextContent(
      new RegExp(`0 / ${REQUIRED_TASK_COUNT} days done`),
    );

    // A zero deposit challenge stakes nothing, and the app says so rather than
    // implying money moved.
    expect(screen.getByTestId("home-finished-deposit")).toHaveTextContent(/staked nothing/);

    // And the way on is another challenge, with the outcome put down.
    await user.press(screen.getByTestId("home-create-challenge"));
    await waitFor(() => expect(screen.queryByTestId("projection")).not.toBeNull());
    await user.press(screen.getByTestId("cancel-create"));
    expect(await screen.findByTestId("home-no-challenge")).toBeOnTheScreen();
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

    // The pause says which morning it consumed before the user leaves it.
    expect(await screen.findByTestId("paused-skipped")).toHaveTextContent(/is skipped/);
    await user.press(screen.getByTestId("pause-done"));

    // The command returns to home, which re-reads the challenge: the paused
    // state on screen is the server's, and nothing is due while it holds.
    expect(await screen.findByTestId("home-challenge-status")).toHaveTextContent("Paused");
    expect(screen.getByTestId("home-no-task")).toBeOnTheScreen();
    expect(screen.queryByTestId("home-open-task")).toBeNull();

    // Resuming puts a live task back in front of the user.
    await user.press(screen.getByTestId("home-open-pause"));
    await user.press(await screen.findByTestId("resume"));
    await user.press(screen.getByTestId("resume-confirm"));

    // And the resume names the deadline it has just started counting.
    expect(await screen.findByTestId("resumed-live")).toHaveTextContent(/deadline counts again/);
    await user.press(screen.getByTestId("resume-done"));

    expect(await screen.findByTestId("home-challenge-status")).toHaveTextContent(
      "Challenge running",
    );
    expect(screen.getByTestId("home-current-task")).toBeOnTheScreen();
  });

  it("walks a day with no signal and says so on home until the walk lands", async () => {
    // The case the on-device store exists for, end to end. Before home could
    // read the store, someone who walked in a basement came back to a screen
    // that looked exactly as it had before they got up - no sign the walk
    // existed, and nothing to say it still had to reach the server.
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

    // The walk happens where there is no signal.
    await user.press(screen.getByTestId("home-open-task"));
    expect(await screen.findByTestId("daily-completion")).toBeOnTheScreen();
    await user.press(screen.getByTestId("start-capture"));
    server.setOffline(true);
    await user.press(screen.getByTestId("simulate-enough-steps"));
    await user.press(screen.getByTestId("stop-capture"));

    await waitFor(() =>
      expect(screen.getByTestId("progression")).toHaveTextContent(/waiting for the server/),
    );
    expect(server.completions()).toHaveLength(0);

    // Still with no signal, the user goes back. Home cannot read the challenge
    // at all, so all it has left to say is the one thing that matters: the walk
    // is on the phone, and walking it again would buy nothing.
    await user.press(screen.getByTestId("daily-back"));

    expect(await screen.findByTestId("home-error-held-walks")).toHaveTextContent(
      /A walk you saved is still on this phone/,
    );

    // Back in signal, but nothing has re-sent it yet: home is where the user
    // looks, and home says the walk is real and not yet counted.
    server.setOffline(false);
    await user.press(screen.getByTestId("home-retry"));

    expect(await screen.findByTestId("home-task-waiting")).toHaveTextContent(
      /Walked and saved on this phone/,
    );
    expect(screen.getByTestId("home-progress")).toHaveTextContent(
      new RegExp(`0 of ${REQUIRED_TASK_COUNT} days done`),
    );

    // And the card leads back to the walk, where sending it can be retried.
    await user.press(screen.getByTestId("home-open-task"));
    await user.press(await screen.findByTestId("retry-sync"));

    await waitFor(() => expect(server.completions()).toHaveLength(1));
    await user.press(screen.getByTestId("daily-back"));

    expect(await screen.findByTestId("home-progress")).toHaveTextContent(
      new RegExp(`1 of ${REQUIRED_TASK_COUNT} days done`),
    );
    expect(screen.queryByTestId("home-task-waiting")).toBeNull();
  });
});
