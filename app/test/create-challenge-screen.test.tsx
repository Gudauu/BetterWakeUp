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
import { CreateChallengeScreen } from "../src/screens/create-challenge-screen.tsx";
import { SessionProvider } from "../src/session/session-context.tsx";
import { createMemorySessionStore } from "../src/session/session-store.ts";
import { formatDay } from "../src/ui/format.ts";
import { challengeView, type FakeApi, fakeApi, PROJECTION } from "./support/fake-api.ts";
import { fakeProvider, fakeProviders } from "./support/fake-providers.ts";

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

async function renderScreen(draft: ChallengeDraft, api: FakeApi = fakeApi()) {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <SessionProvider
        store={createMemorySessionStore(SESSION)}
        createClient={() => api}
        providers={fakeProviders({ google: fakeProvider() })}
      >
        <CreateChallengeScreen initialDraft={draft} />
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
    expect(screen.getByTestId("funding-waiting")).toBeOnTheScreen();
    await waitFor(() => expect(api.names()).toContain("getCurrentChallenge"));
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
          createClient={() => fakeApi({ getCurrentChallenge: { challenge: funded } })}
          providers={fakeProviders({ google: fakeProvider() })}
        >
          <CreateChallengeScreen initialDraft={readyDraft(2000)} onCreated={created} />
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

  it("leaves a way out of the funding screen rather than stranding the user there", async () => {
    const cancelled = jest.fn();
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <SessionProvider
          store={createMemorySessionStore(SESSION)}
          createClient={() => fakeApi()}
          providers={fakeProviders({ google: fakeProvider() })}
        >
          <CreateChallengeScreen initialDraft={readyDraft(2000)} onCancel={cancelled} />
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
