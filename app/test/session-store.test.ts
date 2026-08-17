import type { SessionView } from "@betterwakeup/contract";
import * as SecureStore from "expo-secure-store";
import { createSecureSessionStore, SESSION_KEY } from "../src/session/session-store.ts";

jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mocked = SecureStore as jest.Mocked<typeof SecureStore>;

const SESSION: SessionView = {
  accountId: "11111111-1111-4111-8111-111111111111",
  token: "session-token",
  expiresAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("session material lives in operating system secure storage", () => {
  it("writes the session under one key, bound to this device", async () => {
    await createSecureSessionStore().write(SESSION);

    expect(mocked.setItemAsync).toHaveBeenCalledWith(
      SESSION_KEY,
      JSON.stringify(SESSION),
      expect.objectContaining({ keychainAccessible: "whenUnlockedThisDeviceOnly" }),
    );
  });

  it("reads back what it wrote", async () => {
    mocked.getItemAsync.mockResolvedValue(JSON.stringify(SESSION));

    await expect(createSecureSessionStore().read()).resolves.toEqual(SESSION);
  });

  it("answers with no session when nothing is stored", async () => {
    mocked.getItemAsync.mockResolvedValue(null);

    await expect(createSecureSessionStore().read()).resolves.toBeNull();
    expect(mocked.deleteItemAsync).not.toHaveBeenCalled();
  });

  it("discards a stored value that is not JSON rather than throwing on launch", async () => {
    mocked.getItemAsync.mockResolvedValue("{ not json");

    await expect(createSecureSessionStore().read()).resolves.toBeNull();
    expect(mocked.deleteItemAsync).toHaveBeenCalledWith(SESSION_KEY, expect.anything());
  });

  it("discards a stored session the contract no longer describes", async () => {
    mocked.getItemAsync.mockResolvedValue(JSON.stringify({ token: "orphan" }));

    await expect(createSecureSessionStore().read()).resolves.toBeNull();
    expect(mocked.deleteItemAsync).toHaveBeenCalledWith(SESSION_KEY, expect.anything());
  });

  it("clears the session on sign-out", async () => {
    await createSecureSessionStore().clear();

    expect(mocked.deleteItemAsync).toHaveBeenCalledWith(SESSION_KEY, expect.anything());
  });
});
