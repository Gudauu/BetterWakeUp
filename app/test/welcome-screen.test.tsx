import type { SessionView } from "@betterwakeup/contract";
import { render, screen, userEvent } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { ApiClient } from "../src/api/client.ts";
import { ApiError } from "../src/api/errors.ts";
import type { ProviderSignIns } from "../src/auth/provider-sign-in.ts";
import { WelcomeScreen } from "../src/screens/welcome-screen.tsx";
import { SessionProvider } from "../src/session/session-context.tsx";
import { createMemorySessionStore, type SessionStore } from "../src/session/session-store.ts";
import { fakeApi } from "./support/fake-api.ts";
import { fakeNotifier } from "./support/fake-notifier.ts";
import { appleCredential, fakeProvider, fakeProviders } from "./support/fake-providers.ts";

const SESSION: SessionView = {
  accountId: "11111111-1111-4111-8111-111111111111",
  token: "session-token",
  expiresAt: "2027-01-01T00:00:00.000Z",
};

const ACCOUNT = {
  id: SESSION.accountId,
  email: null,
  displayName: null,
  emergencyRecoveryAvailable: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/**
 * The signed-in screen sets up a challenge, so it asks for a projection as
 * soon as it renders; a client that answers per endpoint keeps these tests
 * about sign-in rather than about what a stub happened to return.
 */
const api: ApiClient = fakeApi();

async function renderScreen(
  store: SessionStore,
  options: { api?: ApiClient; providers?: ProviderSignIns } = {},
) {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <SessionProvider
        store={store}
        createClient={() => options.api ?? api}
        providers={options.providers ?? fakeProviders({ google: fakeProvider() })}
      >
        <WelcomeScreen notifier={fakeNotifier()} />
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

describe("the sign-in buttons", () => {
  it("offers only the providers this device and build can use", async () => {
    // Apple on Android, or Google in a build with no client ID: absent rather
    // than disabled, because a button that cannot work is a promise the app
    // cannot keep.
    await renderScreen(createMemorySessionStore(null), {
      providers: fakeProviders({
        apple: fakeProvider({ available: false }),
        google: fakeProvider({ available: true }),
      }),
    });

    expect(screen.queryByTestId("sign-in-apple")).toBeNull();
    expect(screen.getByTestId("sign-in-google")).toBeOnTheScreen();
    expect(screen.queryByTestId("no-providers")).toBeNull();
  });

  it("says so plainly when no provider is available at all", async () => {
    await renderScreen(createMemorySessionStore(null), {
      providers: fakeProviders({
        apple: fakeProvider({ available: false }),
        google: fakeProvider({ available: false }),
      }),
    });

    expect(screen.getByTestId("no-providers")).toBeOnTheScreen();
  });

  it("signs in when Apple is tapped", async () => {
    const store = createMemorySessionStore(null);
    await renderScreen(store, {
      api: fakeApi({ createSession: { session: SESSION, account: ACCOUNT } }),
    });

    await userEvent.press(screen.getByTestId("sign-in-apple"));

    expect(screen.getByTestId("welcome-signed-in")).toBeOnTheScreen();
    expect(await store.read()).toEqual(SESSION);
  });

  it("says nothing at all when the user dismisses the provider's sheet", async () => {
    await renderScreen(createMemorySessionStore(null), {
      providers: fakeProviders({ apple: fakeProvider({ result: null }) }),
    });

    await userEvent.press(screen.getByTestId("sign-in-apple"));

    expect(screen.getByTestId("welcome-signed-out")).toBeOnTheScreen();
    expect(screen.queryByTestId("sign-in-error")).toBeNull();
  });

  it("shows one plain sentence when the exchange fails", async () => {
    await renderScreen(createMemorySessionStore(null), {
      providers: fakeProviders({ apple: fakeProvider({ result: appleCredential() }) }),
      api: fakeApi({
        createSession: new ApiError("internal_error", "connection pool exhausted", { status: 500 }),
      }),
    });

    await userEvent.press(screen.getByTestId("sign-in-apple"));

    const error = screen.getByTestId("sign-in-error");
    expect(error).toBeOnTheScreen();
    // The operator's message is for the log line, not for the user.
    expect(error).not.toHaveTextContent("connection pool");
  });

  it("signs out from the signed-in screen", async () => {
    const store = createMemorySessionStore(SESSION);
    await renderScreen(store);

    await userEvent.press(screen.getByText("Sign out"));

    expect(screen.getByTestId("welcome-signed-out")).toBeOnTheScreen();
    expect(await store.read()).toBeNull();
  });
});
