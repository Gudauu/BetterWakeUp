/**
 * The real SQLite database and the real sync triggers.
 *
 * This is the only module that imports `expo-sqlite`, `expo-network`, or
 * React Native's `AppState`, for the same reason `native-pedometer.ts` is the
 * only module that imports `expo-sensors`: a native module that resolves at
 * import time cannot appear in a test's import graph. Everything here is a
 * pass-through, so there is no behavior below the ports to test.
 */

import { addNetworkStateListener } from "expo-network";
import * as SQLite from "expo-sqlite";
import { AppState } from "react-native";
import type { SqliteDatabase } from "./sqlite.ts";
import type { SyncTrigger } from "./sync.ts";

/** The database file. One per install; nothing here is per account. */
export const DATABASE_NAME = "betterwakeup.db";

export async function openNativeDatabase(name: string = DATABASE_NAME): Promise<SqliteDatabase> {
  const database = await SQLite.openDatabaseAsync(name);
  return {
    execAsync: (sql) => database.execAsync(sql),
    async runAsync(sql, params) {
      const result = await database.runAsync(sql, [...params]);
      return { changes: result.changes };
    },
    getAllAsync: (sql, params) => database.getAllAsync(sql, [...params]),
    closeAsync: () => database.closeAsync(),
  };
}

/**
 * The app coming back to the front.
 *
 * This is the architecture's "on open": a launch runs the first pass through
 * `start()`, and every return from the background runs one through here.
 */
export const foregroundTrigger: SyncTrigger = (fire) => {
  const subscription = AppState.addEventListener("change", (next) => {
    if (next === "active") {
      fire();
    }
  });
  return () => subscription.remove();
};

/**
 * The network coming back.
 *
 * Fired on any state the operating system reports as reachable, rather than on
 * a transition this module tracks itself: a spurious extra pass costs one
 * request per pending record, while a missed transition leaves a completion
 * unsent until the app is next opened.
 */
export const reconnectTrigger: SyncTrigger = (fire) => {
  const subscription = addNetworkStateListener((state) => {
    if (state.isInternetReachable ?? state.isConnected ?? false) {
      fire();
    }
  });
  return () => subscription.remove();
};
