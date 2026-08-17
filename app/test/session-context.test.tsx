/**
 * Issue 28 through the provider that owns the three transitions: a session
 * restored at launch, a session obtained by signing in, and a session gone.
 *
 * The acceptance boundary that can be checked without a device is here: after a
 * sign-in the session is in the store as well as on screen, after a sign-out it
 * is in neither, and a session the server refuses takes the app back to signed
 * out on its own rather than leaving a dead session on display.
 */

import type { SessionView } from "@betterwakeup/contract";
import { act, render, screen } from "@testing-library/react-native";
import { Text } from "react-native";
import type { ApiClient } from "../src/api/client.ts";
import { ApiError } from "../src/api/errors.ts";
import type { ProviderSignIns } from "../src/auth/provider-sign-in.ts";
import {
  type ApiClientHooks,
  SessionProvider,
  useSession,
} from "../src/session/session-context.tsx";
import { createMemorySessionStore, type SessionStore } from "../src/session/session-store.ts";
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

/** The context value, captured so a test can drive it like a screen would. */
function harness(props: {
  store: SessionStore;
  api: ApiClient;
  providers?: ProviderSignIns;
  now?: () => Date;
  /** Receives the hooks the provider would have given the real client. */
  hooks?: (hooks: ApiClientHooks) => void;
}) {
  const captured: { current: ReturnType<typeof useSession> | null } = { current: null };

  function Probe() {
    captured.current = useSession();
    return <Text testID="status">{captured.current.state.status}</Text>;
  }

  return {
    captured,
    render: () =>
      render(
        <SessionProvider
          store={props.store}
          createClient={(hooks) => {
            props.hooks?.(hooks);
            return props.api;
          }}
          providers={props.providers ?? fakeProviders()}
          {...(props.now === undefined ? {} : { now: props.now })}
        >
          <Probe />
        </SessionProvider>,
      ),
  };
}

function apiThat(answer: (name: string) => unknown): { api: ApiClient; names: string[] } {
  const names: string[] = [];
  return {
    names,
    api: {
      request: async (name) => {
        names.push(name);
        return answer(name) as never;
      },
    },
  };
}

describe("signing in", () => {
  it("persists the session before the app renders as signed in", async () => {
    const store = createMemorySessionStore(null);
    const { api } = apiThat(() => ({ session: SESSION, account: ACCOUNT }));
    const h = harness({ store, api });
    await h.render();

    expect(screen.getByTestId("status")).toHaveTextContent("signedOut");

    await act(async () => {
      await h.captured.current?.signIn("apple");
    });

    expect(screen.getByTestId("status")).toHaveTextContent("signedIn");
    // In storage as well as in state: a session that existed only in memory
    // would be gone on the next launch even though the user signed in.
    expect(await store.read()).toEqual(SESSION);
  });

  it("stays signed out when the user dismisses the provider's sheet", async () => {
    const store = createMemorySessionStore(null);
    const { api, names } = apiThat(() => ({ session: SESSION, account: ACCOUNT }));
    const h = harness({
      store,
      api,
      providers: fakeProviders({ apple: fakeProvider({ result: null }) }),
    });
    await h.render();

    let outcome: unknown;
    await act(async () => {
      outcome = await h.captured.current?.signIn("apple");
    });

    expect(outcome).toEqual({ status: "cancelled" });
    expect(screen.getByTestId("status")).toHaveTextContent("signedOut");
    expect(names).toHaveLength(0);
    expect(await store.read()).toBeNull();
  });

  it("runs one native flow even when the button is tapped twice", async () => {
    const store = createMemorySessionStore(null);
    const apple = fakeProvider({ result: appleCredential() });
    const { api } = apiThat(() => ({ session: SESSION, account: ACCOUNT }));
    const h = harness({ store, api, providers: fakeProviders({ apple }) });
    await h.render();

    await act(async () => {
      await Promise.all([h.captured.current?.signIn("apple"), h.captured.current?.signIn("apple")]);
    });

    // A second provider sheet over the first is an operating system problem
    // rather than a second sign-in, so the second tap is dropped.
    expect(apple.calls()).toBe(1);
  });

  it("offers only the providers that report themselves available", async () => {
    const { api } = apiThat(() => ({}));
    const h = harness({
      store: createMemorySessionStore(null),
      api,
      providers: fakeProviders({
        apple: fakeProvider({ available: false }),
        google: fakeProvider({ available: true }),
      }),
    });
    await h.render();

    expect(h.captured.current?.availability).toEqual({ apple: false, google: true });
  });
});

describe("signing out", () => {
  it("revokes the session on the server and clears the device", async () => {
    const store = createMemorySessionStore(SESSION);
    const { api, names } = apiThat(() => ({}));
    const h = harness({ store, api });
    await h.render();

    expect(screen.getByTestId("status")).toHaveTextContent("signedIn");

    await act(async () => {
      await h.captured.current?.signOut();
    });

    expect(names).toEqual(["deleteSession"]);
    expect(screen.getByTestId("status")).toHaveTextContent("signedOut");
    expect(await store.read()).toBeNull();
  });

  it("signs out of the device even when the server cannot be reached", async () => {
    const store = createMemorySessionStore(SESSION);
    const { api } = apiThat(() => {
      throw new ApiError("internal_error", "The request did not reach the server.", {
        status: null,
      });
    });
    const h = harness({ store, api });
    await h.render();

    await act(async () => {
      await h.captured.current?.signOut();
    });

    // Revoking the row is the point of the call, but a user with no network
    // must still be able to sign out of their own phone.
    expect(screen.getByTestId("status")).toHaveTextContent("signedOut");
    expect(await store.read()).toBeNull();
  });
});

describe("session expiry", () => {
  it("discards a stored session whose expiry has already passed", async () => {
    const store = createMemorySessionStore({
      ...SESSION,
      expiresAt: "2026-01-01T00:00:00.000Z",
    });
    const { api, names } = apiThat(() => ({}));
    const h = harness({ store, api, now: () => new Date("2026-01-02T00:00:00.000Z") });

    await h.render();

    // No round trip is needed to know it is useless, and presenting it would
    // put the user on a screen whose first request is certain to fail.
    expect(screen.getByTestId("status")).toHaveTextContent("signedOut");
    expect(names).toHaveLength(0);
    expect(await store.read()).toBeNull();
  });

  it("returns to signed out when the server refuses the session it was sent", async () => {
    const store = createMemorySessionStore(SESSION);
    let hooks: ApiClientHooks | null = null;
    const h = harness({
      store,
      api: apiThat(() => ({})).api,
      hooks: (given) => {
        hooks = given;
      },
    });
    await h.render();
    expect(screen.getByTestId("status")).toHaveTextContent("signedIn");

    // What the client does after it has discarded a session the server would
    // not accept. Without this wiring the app keeps rendering as signed in and
    // every request fails, which is the worst of the three states.
    await act(async () => {
      (hooks as ApiClientHooks | null)?.onSessionInvalid();
    });

    expect(screen.getByTestId("status")).toHaveTextContent("signedOut");
  });

  it("keeps a stored session that expires in the future", async () => {
    const store = createMemorySessionStore(SESSION);
    const h = harness({
      store,
      api: apiThat(() => ({})).api,
      now: () => new Date("2026-12-31T23:59:59.000Z"),
    });

    await h.render();

    expect(screen.getByTestId("status")).toHaveTextContent("signedIn");
    expect(await store.read()).toEqual(SESSION);
  });
});
