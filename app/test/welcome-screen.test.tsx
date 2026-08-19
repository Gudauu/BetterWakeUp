import type { SessionView } from "@betterwakeup/contract";
import { render, screen, userEvent } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { type ApiClient, createApiClient } from "../src/api/client.ts";
import { ApiError } from "../src/api/errors.ts";
import type { ProviderSignIns } from "../src/auth/provider-sign-in.ts";
import { WelcomeScreen } from "../src/screens/welcome-screen.tsx";
import { SessionProvider } from "../src/session/session-context.tsx";
import { createMemorySessionStore, type SessionStore } from "../src/session/session-store.ts";
import { fakeApi } from "./support/fake-api.ts";
import { type FakeNotifier, fakeNotifier } from "./support/fake-notifier.ts";
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
  options: { api?: ApiClient; providers?: ProviderSignIns; notifier?: FakeNotifier } = {},
) {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <SessionProvider
        store={store}
        createClient={() => options.api ?? api}
        providers={options.providers ?? fakeProviders({ google: fakeProvider() })}
      >
        <WelcomeScreen notifier={options.notifier ?? fakeNotifier()} />
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

describe("a session that ran out", () => {
  const EXPIRED = { ...SESSION, expiresAt: "2026-01-01T00:00:00.000Z" };

  it("says what happened rather than pitching the app again", async () => {
    // The stored session expired while the app was closed, so the user is
    // looking at the signed-out screen without having asked for it.
    await renderScreen(createMemorySessionStore(EXPIRED));

    const notice = screen.getByTestId("session-expired");
    expect(notice).toBeOnTheScreen();
    expect(notice).toHaveTextContent(/signed out/i);
    // The thing a user in the middle of a challenge needs to know: being
    // signed out is not a pause.
    expect(notice).toHaveTextContent(/deadlines still count/i);
    expect(notice).toHaveTextContent(/still here/i);
    // The phone has gone quiet without being asked to, so it says so.
    expect(screen.getByTestId("session-expired-alarms")).toHaveTextContent(
      /reminders on this phone have been turned off/i,
    );
    // The three steps are for someone who has never seen the app.
    expect(screen.queryByTestId("welcome-how-it-works")).toBeNull();
    expect(screen.getByTestId("sign-in-apple")).toBeOnTheScreen();
  });

  it("says nothing of the sort to a device that never held a session", async () => {
    await renderScreen(createMemorySessionStore(null));

    expect(screen.queryByTestId("session-expired")).toBeNull();
    expect(screen.getByTestId("welcome-how-it-works")).toBeOnTheScreen();
  });

  it("explains itself when the server refuses the session mid-use", async () => {
    // The whole chain with the shipped client in it: home asks for the
    // challenge, the server refuses the token, the client discards it, and the
    // app has to land somewhere that says why rather than on the pitch.
    const refuse: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ code: "session_expired", message: "This session has expired." }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    const store = createMemorySessionStore(SESSION);

    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <SessionProvider
          store={store}
          createClient={(hooks) =>
            createApiClient({ baseUrl: "https://example.test", fetch: refuse, ...hooks })
          }
          providers={fakeProviders({ google: fakeProvider() })}
        >
          <WelcomeScreen notifier={fakeNotifier()} />
        </SessionProvider>
      </SafeAreaProvider>,
    );

    expect(await screen.findByTestId("session-expired")).toBeOnTheScreen();
    expect(await store.read()).toBeNull();
  });

  it("says nothing of the sort to a user who signed themselves out", async () => {
    await renderScreen(createMemorySessionStore(SESSION));

    await userEvent.press(screen.getByText("Sign out"));

    // Explaining a sign-out to the person who pressed it is noise.
    expect(screen.getByTestId("welcome-signed-out")).toBeOnTheScreen();
    expect(screen.queryByTestId("session-expired")).toBeNull();
  });
});

describe("the alarms on a phone with nobody signed in", () => {
  it("leaves them alone while the session stands and takes them off when it ends", async () => {
    // A refused device schedules nothing of its own, so every set the notifier
    // is handed here is one this rule put there.
    const notifier = fakeNotifier({ permission: "denied" });
    await renderScreen(createMemorySessionStore(SESSION), { notifier });

    expect(notifier.scheduled).toHaveLength(0);

    await userEvent.press(screen.getByText("Sign out"));

    // An alarm the app cannot honour is worse than no alarm: the walk it asks
    // for needs a session, and there is no longer one.
    expect(notifier.scheduled).toEqual([[]]);
  });

  it("takes them off when the stored session had already expired", async () => {
    // Nothing unmounts on this path - home never renders - so the reminders the
    // last run scheduled would otherwise still be sitting on the device.
    const notifier = fakeNotifier({ permission: "granted" });
    await renderScreen(
      createMemorySessionStore({ ...SESSION, expiresAt: "2026-01-01T00:00:00Z" }),
      {
        notifier,
      },
    );

    expect(notifier.scheduled).toEqual([[]]);
  });

  it("clears a device that never held a session too, without asking it anything", async () => {
    // A first launch has nothing to cancel, but it also has nothing to lose by
    // saying so - and it must not be the one path that spends the install's
    // single permission prompt.
    const notifier = fakeNotifier();
    await renderScreen(createMemorySessionStore(null), { notifier });

    expect(notifier.scheduled).toEqual([[]]);
    expect(notifier.requests).toBe(0);
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

  it("says so plainly, and says what would have been needed, when neither works", async () => {
    await renderScreen(createMemorySessionStore(null), {
      providers: fakeProviders({
        apple: fakeProvider({ available: false }),
        google: fakeProvider({ available: false }),
      }),
    });

    expect(screen.getByTestId("no-providers")).toHaveTextContent(/iOS 13/);
    // There is nothing to press again on a phone that simply has neither.
    expect(screen.queryByTestId("providers-retry")).toBeNull();
  });

  it("says it is still finding out rather than showing an empty screen", async () => {
    // The native modules answer asynchronously, and the space where the buttons
    // belong reads as a broken screen rather than as a wait.
    await renderScreen(createMemorySessionStore(null), {
      providers: fakeProviders({
        apple: fakeProvider({ available: "pending" }),
        google: fakeProvider({ available: false }),
      }),
    });

    expect(screen.getByTestId("providers-checking")).toHaveTextContent(
      /Checking how you can sign/i,
    );
    expect(screen.queryByTestId("sign-in-apple")).toBeNull();
    expect(screen.queryByTestId("no-providers")).toBeNull();
  });

  it("offers a retry when the check threw rather than calling the phone incapable", async () => {
    const apple = fakeProvider({ available: "failed", thenAvailable: true });
    await renderScreen(createMemorySessionStore(null), {
      providers: fakeProviders({ apple, google: fakeProvider({ available: false }) }),
    });

    expect(screen.getByTestId("providers-unknown")).toHaveTextContent(/could not work out/i);
    // The wrong screen for this is the flat "not available on this device".
    expect(screen.queryByTestId("no-providers")).toBeNull();

    await userEvent.press(screen.getByTestId("providers-retry"));

    expect(apple.checks()).toBe(2);
    expect(await screen.findByTestId("sign-in-apple")).toBeOnTheScreen();
    expect(screen.queryByTestId("providers-unknown")).toBeNull();
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
