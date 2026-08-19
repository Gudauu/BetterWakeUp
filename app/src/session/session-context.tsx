/**
 * Who the app thinks is signed in, for the screens that need to know.
 *
 * React context and hooks, as the architecture directs: a client state library
 * arrives only when an observed state-sharing problem requires one.
 *
 * This module owns the three transitions there are: a session restored from
 * secure storage at launch, a session obtained by signing in, and a session
 * gone because the user signed out or because the server refused it. Nothing
 * else writes the store, so there is one answer to "am I signed in" rather
 * than one per screen.
 */

import type { IdentityProvider, SessionView } from "@betterwakeup/contract";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type ApiClient, createApiClient } from "../api/client.ts";
import type { ProviderAvailability, ProviderCheck } from "../auth/provider-availability.ts";
import type { ProviderSignIn, ProviderSignIns } from "../auth/provider-sign-in.ts";
import { type SignInOutcome, signInWithProvider } from "../auth/sign-in.ts";
import { loadAppConfig } from "../config.ts";
import { createSecureSessionStore, type SessionStore } from "./session-store.ts";

/**
 * `loading` is a real state and not a detail: secure storage is asynchronous,
 * so the first frame cannot know whether anyone is signed in, and rendering
 * the signed-out screen during it would flash it at a signed-in user.
 */
export type SessionState =
  | { status: "loading" }
  | { status: "signedOut"; reason: SignedOutReason }
  | { status: "signedIn"; session: SessionView };

/**
 * Why nobody is signed in. Four different things happened and the signed-out
 * screen is the same screen for all of them, so the reason travels with the
 * state: a user who was thrown out of a running challenge by an expiry needs to
 * be told that, where a user who has never signed in needs the pitch and a user
 * who just pressed Sign out needs neither.
 *
 * `expired` covers both ways a session dies - the stored one whose expiry the
 * app can read at launch, and the one the server refuses mid-use - because the
 * user experienced the same thing either way.
 *
 * `deleted` is a signed-out that cannot be undone: the account behind it is
 * gone, so signing in again starts a new one. Without it the app's single most
 * permanent action would be acknowledged by the pitch a first-time user sees.
 */
export type SignedOutReason = "noSession" | "signedOut" | "expired" | "deleted";

/** What a caller of `signOut` may say happened. The other two are not presses. */
export type SignOutReason = Extract<SignedOutReason, "signedOut" | "deleted">;

export interface SessionContextValue {
  readonly state: SessionState;
  readonly api: ApiClient;
  /** Which providers this device and build can offer, while it is still being asked. */
  readonly availability: ProviderAvailability;
  /**
   * Ask the native modules again. Offered because a check can throw rather than
   * answer, and a phone reported as having no sign-in at all on the strength of
   * one thrown check would otherwise never be able to sign in again.
   */
  recheckAvailability(): void;
  /** Runs the native flow, exchanges the credential, and persists the result. */
  signIn(provider: IdentityProvider): Promise<SignInOutcome>;
  /**
   * Discards the session. The reason is what the signed-out screen says
   * happened, and a deletion has to be told apart from a press of Sign out.
   */
  signOut(reason?: SignOutReason): Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * What the provider hands whatever builds the client. It is a factory rather
 * than a client so the invalidation callback is part of the injected seam: a
 * test that was handed a finished client could not exercise the wiring that
 * turns a refused session into a signed-out app.
 */
export interface ApiClientHooks {
  readonly sessionStore: SessionStore;
  readonly onSessionInvalid: () => void;
}

export interface SessionProviderProps {
  children: ReactNode;
  /** Substituted in tests; the app builds the secure one from configuration. */
  store?: SessionStore;
  createClient?: (hooks: ApiClientHooks) => ApiClient;
  /**
   * The native flows, passed in by the root layout. Required rather than
   * defaulted here: both SDKs register a native module the moment they are
   * imported, so a default would make every screen test need a device.
   */
  providers: ProviderSignIns;
  /** Injected so a test asserts the expiry boundary rather than tolerating it. */
  now?: () => Date;
}

export function SessionProvider({
  children,
  store,
  createClient,
  providers,
  now,
}: SessionProviderProps) {
  const sessionStore = useMemo(() => store ?? createSecureSessionStore(), [store]);
  const [state, setState] = useState<SessionState>({ status: "loading" });
  // Held in a ref rather than depended on: a caller passing a new function
  // identity per render would otherwise restart the launch read.
  const clock = useRef(now);
  clock.current = now;

  // The client is built once and told what to do when the server refuses the
  // session it sent, which is how an expiry that happens between requests
  // becomes a signed-out app rather than a screen that keeps failing.
  const client = useMemo(() => {
    const hooks: ApiClientHooks = {
      sessionStore,
      onSessionInvalid: () => setState({ status: "signedOut", reason: "expired" }),
    };
    return createClient === undefined
      ? createApiClient({ baseUrl: loadAppConfig().apiBaseUrl, ...hooks })
      : createClient(hooks);
  }, [createClient, sessionStore]);

  const [availability, setAvailability] = useState<ProviderAvailability>({ status: "checking" });
  // Which check's answer is still wanted. The launch and the retry ask the same
  // question, so it is one callback rather than an effect with a counter behind
  // it, and a stale answer is discarded by number rather than by a second flag.
  const currentCheck = useRef(0);
  const recheckAvailability = useCallback(() => {
    setAvailability({ status: "checking" });
    currentCheck.current += 1;
    const attempt = currentCheck.current;
    // A check that throws is not an answer of "no": the module may be absent
    // from this build, or it may have failed once, and the screen can only tell
    // the user which if the two are kept apart here.
    const ask = (provider: ProviderSignIn): Promise<ProviderCheck> =>
      provider.isAvailable().then(
        (available) => (available ? "available" : "unavailable"),
        () => "failed" as const,
      );
    void Promise.all([ask(providers.apple), ask(providers.google)]).then(([apple, google]) => {
      if (currentCheck.current === attempt) {
        setAvailability({ status: "checked", checks: { apple, google } });
      }
    });
  }, [providers]);

  // A sign-in in flight must not be overtaken by the launch read resolving, and
  // a second tap must not start a second native flow.
  const signingIn = useRef(false);

  useEffect(() => {
    let active = true;
    void sessionStore.read().then(
      async (session) => {
        if (!active) {
          return;
        }
        if (session === null) {
          setState({ status: "signedOut", reason: "noSession" });
          return;
        }
        // An expiry the app can read for itself is not worth a round trip:
        // presenting an expired session would put the user on a signed-in
        // screen whose first request is guaranteed to fail.
        const nowMs = (clock.current ?? (() => new Date()))().getTime();
        if (Date.parse(session.expiresAt) <= nowMs) {
          await sessionStore.clear();
          if (active) {
            setState({ status: "signedOut", reason: "expired" });
          }
          return;
        }
        setState({ status: "signedIn", session });
      },
      () => {
        // Unreadable secure storage is signed out, not a crash on launch. There
        // is no evidence a session ever existed, so it is not reported as one
        // having expired.
        if (active) {
          setState({ status: "signedOut", reason: "noSession" });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [sessionStore]);

  useEffect(() => {
    recheckAvailability();
    // Nothing wants the answer once this provider is gone, and bumping the
    // number is what stops it landing on an unmounted tree.
    return () => {
      currentCheck.current += 1;
    };
  }, [recheckAvailability]);

  const signIn = useCallback(
    async (provider: IdentityProvider): Promise<SignInOutcome> => {
      if (signingIn.current) {
        return { status: "cancelled" };
      }
      signingIn.current = true;
      try {
        const outcome = await signInWithProvider({
          api: client,
          provider: providers[provider],
        });
        if (outcome.status === "signedIn") {
          // Persisted before the state changes, so a screen that renders as
          // signed in can never be the only place the session exists.
          await sessionStore.write(outcome.session);
          setState({ status: "signedIn", session: outcome.session });
        }
        return outcome;
      } finally {
        signingIn.current = false;
      }
    },
    [client, providers, sessionStore],
  );

  const signOut = useCallback(
    async (reason: SignOutReason = "signedOut") => {
      // A deleted account has no session left to revoke - the sessions went with
      // it - so the request would only be a guaranteed refusal, and one that the
      // client would read as an expiry.
      if (reason !== "deleted") {
        try {
          // Best effort: the point of the call is to revoke the session on the
          // server so a copy of the token is useless, but a user with no network
          // must still be able to sign out of their own device.
          await client.request("deleteSession", {});
        } catch {
          // The session is being discarded either way.
        }
      }
      await sessionStore.clear();
      setState({ status: "signedOut", reason });
    },
    [client, sessionStore],
  );

  const value = useMemo<SessionContextValue>(
    () => ({ state, api: client, availability, recheckAvailability, signIn, signOut }),
    [state, client, availability, recheckAvailability, signIn, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error("useSession must be used inside a SessionProvider.");
  }
  return value;
}
