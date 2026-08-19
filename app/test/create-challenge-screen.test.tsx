/**
 * The challenge setup screen.
 *
 * The acceptance boundary of issue 31 is here twice: the action that commits
 * is not on screen until every applicable disclosure is acknowledged, and a
 * zero deposit challenge is created without a payment step.
 */

import { disclosuresFor, type SessionView } from "@betterwakeup/contract";
import { fireEvent, render, screen, userEvent, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { type ChallengeDraft, createDraft } from "../src/challenges/draft.ts";
import type { SettingsLauncher } from "../src/device/settings.ts";
import { NO_PROVIDER_MESSAGE, type PaymentSheet } from "../src/payments/payment-sheet.ts";
import { CreateChallengeScreen } from "../src/screens/create-challenge-screen.tsx";
import { SessionProvider } from "../src/session/session-context.tsx";
import { createMemorySessionStore } from "../src/session/session-store.ts";
import { formatDay } from "../src/ui/format.ts";
import {
  challengeView,
  type FakeApi,
  FUNDING_INTENT,
  fakeApi,
  PROJECTION,
} from "./support/fake-api.ts";
import { fakePaymentSheet } from "./support/fake-payment-sheet.ts";
import { createFakePedometer, type FakePedometer } from "./support/fake-pedometer.ts";
import { fakeProvider, fakeProviders } from "./support/fake-providers.ts";
import { fakeSettings } from "./support/fake-settings.ts";

const SESSION: SessionView = {
  accountId: "11111111-1111-4111-8111-111111111111",
  token: "session-token",
  expiresAt: "2027-01-01T00:00:00.000Z",
};

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const ZONE = "America/Los_Angeles";

function draftWith(overrides: Partial<ChallengeDraft> = {}): ChallengeDraft {
  return { ...createDraft(ZONE), ...overrides };
}

function readyDraft(depositMinorUnits = 0): ChallengeDraft {
  return draftWith({
    timeZoneConfirmed: true,
    depositMinorUnits,
    acknowledgedDisclosures: disclosuresFor(depositMinorUnits).map((item) => item.id),
  });
}

async function renderScreen(
  draft: ChallengeDraft,
  api: FakeApi = fakeApi(),
  // A card the user confirms, which is what every test not about the sheet
  // itself assumes; the real one belongs to a provider and a device.
  paymentSheet: PaymentSheet = fakePaymentSheet(),
  // A phone that can count steps and has been allowed to, which is what every
  // test not about the device itself assumes.
  movementDevice: FakePedometer = createFakePedometer(),
  settings: SettingsLauncher = fakeSettings(),
) {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <SessionProvider
        store={createMemorySessionStore(SESSION)}
        createClient={() => api}
        providers={fakeProviders({ google: fakeProvider() })}
      >
        <CreateChallengeScreen
          initialDraft={draft}
          paymentSheet={paymentSheet}
          movementDevice={movementDevice}
          settings={settings}
        />
      </SessionProvider>
    </SafeAreaProvider>,
  );
  // The screen asks for a projection as it mounts; letting that settle here
  // keeps every test below asserting on a settled screen.
  await waitFor(() => expect(screen.queryByTestId("projection")).not.toBeNull());
  return api;
}

describe("the action that commits", () => {
  it("is absent until every applicable disclosure is acknowledged", async () => {
    const draft = readyDraft(2000);
    await renderScreen({
      ...draft,
      acknowledgedDisclosures: draft.acknowledgedDisclosures.slice(1),
    });

    expect(screen.queryByTestId("deposit-and-start")).toBeNull();
    expect(screen.getByTestId("not-ready")).toHaveTextContent(/Acknowledge each statement/);
  });

  it("appears once the last one is acknowledged, and goes again if it is withdrawn", async () => {
    const draft = readyDraft(2000);
    const last = draft.acknowledgedDisclosures.at(-1) as string;
    await renderScreen({
      ...draft,
      acknowledgedDisclosures: draft.acknowledgedDisclosures.slice(0, -1),
    });

    expect(screen.queryByTestId("deposit-and-start")).toBeNull();

    await fireEvent(screen.getByTestId(`disclosure-${last}`), "valueChange", true);
    expect(screen.getByTestId("deposit-and-start")).toBeOnTheScreen();

    await fireEvent(screen.getByTestId(`disclosure-${last}`), "valueChange", false);
    expect(screen.queryByTestId("deposit-and-start")).toBeNull();
  });

  it("is absent until the time zone is confirmed", async () => {
    await renderScreen({ ...readyDraft(), timeZoneConfirmed: false });

    expect(screen.queryByTestId("start-challenge")).toBeNull();
    expect(screen.getByTestId("not-ready")).toHaveTextContent(/Confirm your time zone/);

    await fireEvent(screen.getByTestId("confirm-time-zone"), "valueChange", true);
    expect(screen.getByTestId("start-challenge")).toBeOnTheScreen();
  });

  it("shows the device's zone so the user is confirming something specific", async () => {
    await renderScreen(readyDraft());

    expect(screen.getByTestId("time-zone")).toHaveTextContent(new RegExp(ZONE));
  });
});

describe("a zero deposit challenge", () => {
  it("is created and run without any payment step", async () => {
    const api = await renderScreen(readyDraft(), fakeApi());

    await userEvent.press(screen.getByTestId("start-challenge"));

    expect(screen.getByTestId("challenge-created")).toBeOnTheScreen();
    expect(api.names()).not.toContain("createFundingIntent");
    expect(api.names()).toContain("createChallenge");
  });

  it("shows the money disclosures only once there is money at stake", async () => {
    const fundedOnly = disclosuresFor(2000).filter((item) => item.scope === "funded");
    await renderScreen(readyDraft());

    for (const item of fundedOnly) {
      expect(screen.queryByTestId(`disclosure-${item.id}`)).toBeNull();
    }
    for (const item of disclosuresFor(0)) {
      expect(screen.getByTestId(`disclosure-${item.id}`)).toBeOnTheScreen();
    }
  });
});

describe("a funded challenge", () => {
  it("authorizes a hold and says the challenge starts on the bank's confirmation", async () => {
    const api = await renderScreen(readyDraft(2000));

    await userEvent.press(screen.getByTestId("deposit-and-start"));

    expect(screen.getByTestId("challenge-funding")).toBeOnTheScreen();
    expect(api.names()).toContain("createFundingIntent");
    expect(api.names()).not.toContain("createChallenge");
    // And it is watching for the challenge rather than telling the user to
    // come back later: the hold is confirmed by the provider, not by any
    // press on this screen.
    expect(await screen.findByTestId("funding-waiting")).toBeOnTheScreen();
    await waitFor(() => expect(api.names()).toContain("getCurrentChallenge"));
  });

  it("asks for a card, with the intent's own secret and the amount at stake", async () => {
    // The hold is authorized on the device. Without this the app waited for a
    // bank nobody had asked anything of: the user was never shown a sheet.
    const sheet = fakePaymentSheet();
    const api = await renderScreen(readyDraft(2000), fakeApi(), sheet);

    await userEvent.press(screen.getByTestId("deposit-and-start"));

    await waitFor(() => expect(sheet.presented).toHaveLength(1));
    expect(sheet.presented[0]).toEqual({
      clientSecret: FUNDING_INTENT.providerClientSecret,
      amountMinorUnits: 2000,
      currency: "USD",
    });
    // The intent is what the sheet completes, so it is asked for first.
    expect(api.names().indexOf("createFundingIntent")).toBeLessThan(
      api.names().indexOf("getCurrentChallenge"),
    );
  });

  it("goes back to the form when the user closes the sheet, saying nothing was charged", async () => {
    const api = await renderScreen(
      readyDraft(2000),
      fakeApi(),
      fakePaymentSheet({ answer: { status: "cancelled" } }),
    );

    await userEvent.press(screen.getByTestId("deposit-and-start"));

    expect(await screen.findByTestId("create-challenge")).toBeOnTheScreen();
    expect(screen.getByTestId("funding-notice")).toHaveTextContent(/Nothing was charged/);
    // A cancelled sheet authorized nothing, so there is nothing to watch for.
    expect(api.names()).not.toContain("getCurrentChallenge");
  });

  it("lets a declined card be tried again on the same intent", async () => {
    const sheet = fakePaymentSheet({
      answer: (attempt) =>
        attempt === 0
          ? { status: "failed", message: "Your card was declined." }
          : { status: "authorized" },
    });
    await renderScreen(readyDraft(2000), fakeApi(), sheet);

    await userEvent.press(screen.getByTestId("deposit-and-start"));

    expect(await screen.findByTestId("funding-card-error")).toHaveTextContent(/declined/);
    await userEvent.press(screen.getByTestId("funding-card-retry"));

    expect(await screen.findByTestId("funding-waiting")).toBeOnTheScreen();
    expect(sheet.presented).toHaveLength(2);
    expect(sheet.presented[1]?.clientSecret).toBe(FUNDING_INTENT.providerClientSecret);
  });

  it("survives a sheet that could not be opened at all", async () => {
    await renderScreen(readyDraft(2000), fakeApi(), fakePaymentSheet({ throws: true }));

    await userEvent.press(screen.getByTestId("deposit-and-start"));

    expect(await screen.findByTestId("funding-card-error")).toHaveTextContent(
      /Nothing was charged/,
    );
  });

  it("offers the same challenge without a deposit when this build takes no cards", async () => {
    // The honest answer to a build with no payment provider: the product that
    // works today is the one with nothing but the habit at stake, and the user
    // is one press away from it rather than stuck at a sheet that never opens.
    await renderScreen(
      readyDraft(2000),
      fakeApi(),
      fakePaymentSheet({ answer: { status: "unavailable", message: NO_PROVIDER_MESSAGE } }),
    );

    await userEvent.press(screen.getByTestId("deposit-and-start"));

    expect(await screen.findByTestId("funding-unavailable")).toHaveTextContent(
      /not available in this build/,
    );

    await userEvent.press(screen.getByTestId("funding-without-deposit"));

    expect(await screen.findByTestId("create-challenge")).toBeOnTheScreen();
    expect(screen.getByTestId("field-deposit")).toHaveProp("value", "");
    expect(screen.getByTestId("start-challenge")).toBeOnTheScreen();
    expect(screen.getByTestId("funding-notice")).toHaveTextContent(/deposit is off/);
  });

  it("moves on by itself once the hold clears and the challenge exists", async () => {
    const funded = challengeView({
      configuration: {
        ...challengeView().configuration,
        deposit: { amount: 2000, currency: "USD" },
      },
    });
    const created = jest.fn();
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <SessionProvider
          store={createMemorySessionStore(SESSION)}
          createClient={() =>
            fakeApi({ getCurrentChallenge: { challenge: funded, lastEnded: null } })
          }
          providers={fakeProviders({ google: fakeProvider() })}
        >
          <CreateChallengeScreen
            initialDraft={readyDraft(2000)}
            onCreated={created}
            paymentSheet={fakePaymentSheet()}
            movementDevice={createFakePedometer()}
            settings={fakeSettings()}
          />
        </SessionProvider>
      </SafeAreaProvider>,
    );
    await waitFor(() => expect(screen.queryByTestId("deposit-and-start")).not.toBeNull());

    await userEvent.press(screen.getByTestId("deposit-and-start"));

    expect(await screen.findByTestId("challenge-created")).toBeOnTheScreen();
    expect(created).toHaveBeenCalledWith(funded);
  });

  it("offers no deposit action when the plan runs past the maximum duration", async () => {
    await renderScreen(
      readyDraft(2000),
      fakeApi({
        createChallengeProjection: { ...PROJECTION, withinMaximumDuration: false },
      }),
    );

    expect(screen.getByTestId("maximum-duration")).toBeOnTheScreen();
    expect(screen.queryByTestId("deposit-and-start")).toBeNull();
  });
});

describe("what the screen shows about the plan", () => {
  it("shows the server's own projected end date, read as a day rather than as ISO", async () => {
    await renderScreen(readyDraft());

    const projection = screen.getByTestId("projection");
    expect(projection).toHaveTextContent(new RegExp(formatDay(PROJECTION.projectedEndDate)));
    expect(projection).toHaveTextContent(new RegExp(formatDay(PROJECTION.firstTaskDate)));
    // The dates the server speaks are never shown to the user as it speaks them.
    expect(projection).not.toHaveTextContent(new RegExp(PROJECTION.projectedEndDate));
  });

  it("asks again when the configuration changes", async () => {
    const api = await renderScreen(readyDraft());
    const before = api.names().filter((name) => name === "createChallengeProjection").length;

    await userEvent.press(screen.getByTestId("weekday-saturday"));

    expect(api.names().filter((name) => name === "createChallengeProjection").length).toBe(
      before + 1,
    );
  });

  it("does not ask again for something that does not change the plan", async () => {
    // Acknowledging a statement or confirming a zone changes the draft without
    // changing the schedule the server would project.
    const api = await renderScreen({ ...readyDraft(), timeZoneConfirmed: false });
    const before = api.names().filter((name) => name === "createChallengeProjection").length;

    await fireEvent(screen.getByTestId("confirm-time-zone"), "valueChange", true);

    expect(api.names().filter((name) => name === "createChallengeProjection").length).toBe(before);
  });

  it("says one plain sentence when the server refuses the challenge", async () => {
    const api = await renderScreen(
      readyDraft(),
      fakeApi({
        createChallenge: Object.assign(new Error("boom"), {}),
      }),
    );

    await userEvent.press(screen.getByTestId("start-challenge"));

    expect(screen.getByTestId("start-error")).toBeOnTheScreen();
    expect(api.names()).toContain("createChallenge");
  });

  it("tells the user what a created challenge came to", async () => {
    await renderScreen(
      readyDraft(),
      fakeApi({
        createChallenge: { challenge: challengeView({ projectedEndDate: "2027-03-04" }) },
      }),
    );

    await userEvent.press(screen.getByTestId("start-challenge"));

    expect(screen.getByTestId("challenge-created")).toHaveTextContent(
      new RegExp(formatDay("2027-03-04")),
    );
  });
});

describe("the form the user fills in", () => {
  it("asks for the deposit in dollars, and stores the cents the contract wants", async () => {
    // Started funded so the money statements are already acknowledged; this
    // test is about the unit the field is read in, not about readiness.
    await renderScreen(readyDraft(2000));

    await fireEvent.changeText(screen.getByTestId("field-deposit"), "35");

    // Thirty-five typed into a field labelled with a dollar sign is
    // thirty-five dollars, not thirty-five cents.
    expect(screen.getByTestId("deposit-and-start")).toHaveTextContent(/Deposit \$35\.00 and start/);
  });

  it("keeps a half-typed amount on screen instead of rounding it away", async () => {
    await renderScreen(readyDraft(2000));

    const deposit = screen.getByTestId("field-deposit");
    await fireEvent.changeText(deposit, "12.");
    expect(deposit).toHaveProp("value", "12.");

    await fireEvent.changeText(deposit, "12.5");
    expect(screen.getByTestId("deposit-and-start")).toHaveTextContent(/Deposit \$12\.50 and start/);
  });

  it("takes a deadline typed the way a person says it, not only as HH:MM", async () => {
    const api = await renderScreen(readyDraft());

    await fireEvent.changeText(screen.getByTestId("deadline-monday"), "6:15 am");

    // What was typed stays on screen, and what it comes to is stated under it
    // so nobody is left guessing which of the two the challenge will use.
    expect(screen.getByTestId("deadline-monday")).toHaveProp("value", "6:15 am");
    expect(screen.getByTestId("deadline-monday-reading")).toHaveTextContent(/That is 6:15 AM/);

    await userEvent.press(screen.getByTestId("start-challenge"));

    const created = api.calls.find((call) => call.name === "createChallenge");
    const schedule = (
      created?.input as { body: { configuration: { schedule: readonly unknown[] } } }
    ).body.configuration.schedule;
    expect(schedule).toContainEqual({ weekday: "monday", deadline: "06:15" });
  });

  it("names what is wrong beside the deadline rather than as a schema path", async () => {
    await renderScreen(readyDraft());

    await fireEvent.changeText(screen.getByTestId("deadline-monday"), "morning");

    expect(screen.getByTestId("deadline-monday-problem")).toHaveTextContent(/Not a time yet/);
    // The old behaviour: a zod message naming a path into the request body,
    // in a card two sections below the field that caused it.
    expect(screen.getByTestId("create-challenge")).not.toHaveTextContent(/schedule\./);
  });

  it("will not start a challenge against a deadline the user is midway through replacing", async () => {
    await renderScreen(readyDraft());

    await fireEvent.changeText(screen.getByTestId("deadline-monday"), "6:");

    expect(screen.queryByTestId("start-challenge")).toBeNull();
    expect(screen.getByTestId("not-ready")).toHaveTextContent(/deadlines is not a time yet/);

    await fireEvent.changeText(screen.getByTestId("deadline-monday"), "6:45");

    expect(screen.getByTestId("start-challenge")).toBeOnTheScreen();
  });

  it("stops blocking on a weekday whose field is no longer on screen", async () => {
    await renderScreen(readyDraft());

    // Saturday is off in the default draft, so turn it on, break it, turn it
    // back off: the form must not stay stuck on a field nobody can see.
    await userEvent.press(screen.getByTestId("weekday-saturday"));
    await fireEvent.changeText(screen.getByTestId("deadline-saturday"), "nope");
    expect(screen.queryByTestId("start-challenge")).toBeNull();

    await userEvent.press(screen.getByTestId("weekday-saturday"));

    expect(screen.getByTestId("start-challenge")).toBeOnTheScreen();
  });

  it("says how many mornings a week the chosen weekdays come to", async () => {
    await renderScreen(readyDraft());

    expect(screen.getByTestId("weekday-summary")).toHaveTextContent(/5 mornings a week/);

    await userEvent.press(screen.getByTestId("weekday-saturday"));

    expect(screen.getByTestId("weekday-summary")).toHaveTextContent(/6 mornings a week/);
  });

  it("reads No Regret Time back in hours, since nobody thinks in 480 minutes", async () => {
    await renderScreen(readyDraft());

    expect(screen.getByTestId("create-challenge")).toHaveTextContent(/That is 8 hours/);
  });

  it("lets a number be cleared and retyped rather than snapping the box back to zero", async () => {
    const api = await renderScreen(readyDraft());

    await fireEvent.changeText(screen.getByTestId("field-required-task-count"), "");
    // The old behaviour: an empty box was written down as zero and read back
    // as "0", so the next digit typed made 30 into 03.
    expect(screen.getByTestId("field-required-task-count")).toHaveProp("value", "");

    await fireEvent.changeText(screen.getByTestId("field-required-task-count"), "45");
    expect(screen.getByTestId("field-required-task-count")).toHaveProp("value", "45");

    await userEvent.press(screen.getByTestId("start-challenge"));

    const created = api.calls.find((call) => call.name === "createChallenge");
    expect(
      (created?.input as { body: { configuration: { requiredTaskCount: number } } }).body
        .configuration.requiredTaskCount,
    ).toBe(45);
  });

  it("will not start a challenge against a number the user is midway through replacing", async () => {
    await renderScreen(readyDraft());

    await fireEvent.changeText(screen.getByTestId("field-step-target"), "");

    expect(screen.queryByTestId("start-challenge")).toBeNull();
    expect(screen.getByTestId("field-step-target-problem")).toHaveTextContent(
      /how many steps a morning walk has to reach/,
    );
    expect(screen.getByTestId("not-ready")).toHaveTextContent(/numbers is not filled in yet/);

    await fireEvent.changeText(screen.getByTestId("field-step-target"), "250");

    expect(screen.getByTestId("start-challenge")).toBeOnTheScreen();
  });

  it("names a number below its minimum beside the field rather than as a schema path", async () => {
    await renderScreen(readyDraft());

    await fireEvent.changeText(screen.getByTestId("field-step-target"), "0");

    expect(screen.getByTestId("field-step-target-problem")).toHaveTextContent(/at least one step/);
    // The old behaviour: "stepTarget: Too small: expected number to be >=1",
    // in a card below the field that caused it.
    expect(screen.getByTestId("create-challenge")).not.toHaveTextContent(/stepTarget/);
    expect(screen.queryByTestId("configuration-problems")).toBeNull();
  });

  it("leaves a way out of the funding screen rather than stranding the user there", async () => {
    const cancelled = jest.fn();
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <SessionProvider
          store={createMemorySessionStore(SESSION)}
          createClient={() => fakeApi()}
          providers={fakeProviders({ google: fakeProvider() })}
        >
          <CreateChallengeScreen
            initialDraft={readyDraft(2000)}
            onCancel={cancelled}
            paymentSheet={fakePaymentSheet()}
            movementDevice={createFakePedometer()}
            settings={fakeSettings()}
          />
        </SessionProvider>
      </SafeAreaProvider>,
    );
    await waitFor(() => expect(screen.queryByTestId("deposit-and-start")).not.toBeNull());

    await userEvent.press(screen.getByTestId("deposit-and-start"));
    await userEvent.press(screen.getByTestId("funding-done"));

    // Leaving an authorized hold is reported as a change, because the
    // challenge can come into existence a moment after the user stops
    // watching for it, and home has to ask again to find it.
    expect(cancelled).toHaveBeenCalledWith(true);
  });
});

describe("what this phone can do about a walk", () => {
  it("says the step counter is there and motion access is on", async () => {
    await renderScreen(readyDraft());

    expect(await screen.findByTestId("device-ready")).toBeOnTheScreen();
    expect(screen.getByTestId("device-readiness")).toHaveTextContent(/can count your walk/);
    // Nothing is in the way, so the challenge is startable.
    expect(screen.getByTestId("start-challenge")).toBeOnTheScreen();
  });

  it("refuses to start a challenge on a phone with no step counter", async () => {
    await renderScreen(
      readyDraft(2000),
      fakeApi(),
      fakePaymentSheet(),
      createFakePedometer({ available: false }),
    );

    expect(await screen.findByTestId("device-unsupported")).toBeOnTheScreen();
    expect(screen.getByTestId("device-readiness")).toHaveTextContent(/no step counter/);
    // The money is what makes this a bar rather than a warning: every morning
    // of this challenge would be lost on a phone that cannot count a step.
    expect(screen.queryByTestId("deposit-and-start")).toBeNull();
    expect(screen.getByTestId("not-ready")).toHaveTextContent(/cannot be started on a phone/);
  });

  it("asks for motion access before the deposit rather than on the first morning", async () => {
    const pedometer = createFakePedometer({ permission: "undetermined" });
    await renderScreen(readyDraft(), fakeApi(), fakePaymentSheet(), pedometer);

    expect(await screen.findByTestId("device-askable")).toBeOnTheScreen();
    await userEvent.press(screen.getByTestId("device-allow-motion"));

    expect(pedometer.requests).toBe(1);
    expect(await screen.findByTestId("device-ready")).toBeOnTheScreen();
  });

  it("warns about a refused permission and offers the settings page, without barring the start", async () => {
    const settings = fakeSettings();
    await renderScreen(
      readyDraft(),
      fakeApi(),
      fakePaymentSheet(),
      createFakePedometer({ permission: "denied" }),
      settings,
    );

    expect(await screen.findByTestId("device-refused")).toBeOnTheScreen();
    expect(screen.getByTestId("device-readiness")).toHaveTextContent(/Motion access is off/);
    await userEvent.press(screen.getByTestId("device-refused-settings"));
    expect(settings.opened).toBe(1);

    // A permission turned on before the first morning costs nothing, so this
    // is said loudly and stops nobody.
    expect(screen.getByTestId("start-challenge")).toBeOnTheScreen();
  });

  it("re-reads the phone when the user says they have changed it", async () => {
    const pedometer = createFakePedometer({ permission: "denied" });
    await renderScreen(readyDraft(), fakeApi(), fakePaymentSheet(), pedometer);
    expect(await screen.findByTestId("device-refused")).toBeOnTheScreen();

    // Changed on a settings page the app was not in front of, which is why
    // nothing but a press can tell the screen to look again.
    pedometer.permission = "granted";
    await userEvent.press(screen.getByTestId("device-recheck"));

    expect(await screen.findByTestId("device-ready")).toBeOnTheScreen();
  });

  it("does not bar a start over a device that would not answer", async () => {
    await renderScreen(
      readyDraft(),
      fakeApi(),
      fakePaymentSheet(),
      createFakePedometer({
        isAvailable: () => Promise.reject(new Error("sensor unavailable")),
      }),
    );

    expect(await screen.findByTestId("device-unknown")).toBeOnTheScreen();
    expect(screen.getByTestId("start-challenge")).toBeOnTheScreen();
  });
});
