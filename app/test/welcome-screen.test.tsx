import type { SessionView } from "@betterwakeup/contract";
import { render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { ApiClient } from "../src/api/client.ts";
import { WelcomeScreen } from "../src/screens/welcome-screen.tsx";
import { SessionProvider } from "../src/session/session-context.tsx";
import { createMemorySessionStore, type SessionStore } from "../src/session/session-store.ts";

const SESSION: SessionView = {
  accountId: "11111111-1111-4111-8111-111111111111",
  token: "session-token",
  expiresAt: "2026-01-01T00:00:00.000Z",
};

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/** The screens never build a client themselves, so a stub is enough here. */
const api: ApiClient = { request: async () => ({}) as never };

async function renderScreen(store: SessionStore) {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <SessionProvider store={store} api={api}>
        <WelcomeScreen />
      </SessionProvider>
    </SafeAreaProvider>,
  );
}

describe("the app reaches an unauthenticated screen", () => {
  it("shows the signed-out screen when secure storage holds no session", async () => {
    await renderScreen(createMemorySessionStore(null));

    expect(screen.getByTestId("welcome-signed-out")).toBeOnTheScreen();
    expect(screen.getByText("Sign in with Apple")).toBeOnTheScreen();
    expect(screen.getByText("Continue with Google")).toBeOnTheScreen();
  });

  it("shows the signed-in screen when secure storage holds a session", async () => {
    await renderScreen(createMemorySessionStore(SESSION));

    expect(screen.getByTestId("welcome-signed-in")).toBeOnTheScreen();
  });

  it("shows neither screen while secure storage has not answered", async () => {
    // Secure storage is asynchronous, so the first frame cannot know who is
    // signed in; showing the signed-out screen during it would flash it at a
    // signed-in user.
    const neverAnswers: SessionStore = {
      read: () => new Promise(() => {}),
      write: async () => undefined,
      clear: async () => undefined,
    };

    await renderScreen(neverAnswers);

    expect(screen.getByTestId("welcome-loading")).toBeOnTheScreen();
    expect(screen.queryByTestId("welcome-signed-out")).toBeNull();
  });
});
