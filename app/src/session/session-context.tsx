/**
 * Who the app thinks is signed in, for the screens that need to know.
 *
 * React context and hooks, as the architecture directs: a client state library
 * arrives only when an observed state-sharing problem requires one.
 */

import type { SessionView } from "@betterwakeup/contract";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { type ApiClient, createApiClient } from "../api/client.ts";
import { loadAppConfig } from "../config.ts";
import { createSecureSessionStore, type SessionStore } from "./session-store.ts";

/**
 * `loading` is a real state and not a detail: secure storage is asynchronous,
 * so the first frame cannot know whether anyone is signed in, and rendering
 * the signed-out screen during it would flash it at a signed-in user.
 */
export type SessionState =
  | { status: "loading" }
  | { status: "signedOut" }
  | { status: "signedIn"; session: SessionView };

export interface SessionContextValue {
  readonly state: SessionState;
  readonly api: ApiClient;
  signIn(session: SessionView): Promise<void>;
  signOut(): Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export interface SessionProviderProps {
  children: ReactNode;
  /** Substituted in tests; the app builds the secure one from configuration. */
  store?: SessionStore;
  api?: ApiClient;
}

export function SessionProvider({ children, store, api }: SessionProviderProps) {
  const sessionStore = useMemo(() => store ?? createSecureSessionStore(), [store]);
  const client = useMemo(
    () =>
      api ?? createApiClient({ baseUrl: loadAppConfig().apiBaseUrl, sessionStore: sessionStore }),
    [api, sessionStore],
  );
  const [state, setState] = useState<SessionState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    void sessionStore.read().then(
      (session) => {
        if (!active) {
          return;
        }
        setState(session === null ? { status: "signedOut" } : { status: "signedIn", session });
      },
      () => {
        // Unreadable secure storage is signed out, not a crash on launch.
        if (active) {
          setState({ status: "signedOut" });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [sessionStore]);

  const signIn = useCallback(
    async (session: SessionView) => {
      await sessionStore.write(session);
      setState({ status: "signedIn", session });
    },
    [sessionStore],
  );

  const signOut = useCallback(async () => {
    await sessionStore.clear();
    setState({ status: "signedOut" });
  }, [sessionStore]);

  const value = useMemo<SessionContextValue>(
    () => ({ state, api: client, signIn, signOut }),
    [state, client, signIn, signOut],
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
