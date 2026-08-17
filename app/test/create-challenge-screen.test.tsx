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
  it("shows the server's own projected end date", async () => {
    await renderScreen(readyDraft());

    const projection = screen.getByTestId("projection");
    expect(projection).toHaveTextContent(new RegExp(PROJECTION.projectedEndDate));
    expect(projection).toHaveTextContent(new RegExp(PROJECTION.firstTaskDate));
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

    expect(screen.getByTestId("challenge-created")).toHaveTextContent(/2027-03-04/);
  });
});
