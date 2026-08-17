/**
 * Session material in operating system secure storage.
 *
 * The session token is the one secret the app holds, so it never reaches
 * AsyncStorage, a file, or a log line: it lives in the iOS keychain and the
 * Android keystore-backed store, behind `expo-secure-store`.
 */

import { type SessionView, sessionView } from "@betterwakeup/contract";
import * as SecureStore from "expo-secure-store";

const SESSION_KEY = "betterwakeup.session";

/**
 * The store the rest of the app depends on. It is an interface so a test can
 * substitute one without a native module, and so the pending completion store
 * in issue 30 can hold the same handle the API client does.
 */
export interface SessionStore {
  read(): Promise<SessionView | null>;
  write(session: SessionView): Promise<void>;
  clear(): Promise<void>;
}

const OPTIONS: SecureStore.SecureStoreOptions = {
  // The session must not follow the user to a restored backup on another
  // device: a token is device-bound state, not a preference.
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export function createSecureSessionStore(): SessionStore {
  return {
    async read() {
      const stored = await SecureStore.getItemAsync(SESSION_KEY, OPTIONS);
      if (stored === null) {
        return null;
      }

      // Anything unreadable is discarded rather than thrown: a session shape
      // this build does not understand is a sign-in away from being fixed,
      // and crashing on launch is not.
      let parsed: unknown;
      try {
        parsed = JSON.parse(stored);
      } catch {
        await SecureStore.deleteItemAsync(SESSION_KEY, OPTIONS);
        return null;
      }

      const result = sessionView.safeParse(parsed);
      if (!result.success) {
        await SecureStore.deleteItemAsync(SESSION_KEY, OPTIONS);
        return null;
      }

      return result.data;
    },

    async write(session: SessionView) {
      await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session), OPTIONS);
    },

    async clear() {
      await SecureStore.deleteItemAsync(SESSION_KEY, OPTIONS);
    },
  };
}

/** An in-memory store, for tests and for a build with no secure storage. */
export function createMemorySessionStore(initial: SessionView | null = null): SessionStore {
  let current = initial;
  return {
    read: async () => current,
    write: async (session) => {
      current = session;
    },
    clear: async () => {
      current = null;
    },
  };
}

export { SESSION_KEY };
