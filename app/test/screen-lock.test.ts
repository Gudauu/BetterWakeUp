/**
 * Holding the phone awake for the length of a walk.
 *
 * The rule under test is what stands between the app's central interaction and
 * the device's own auto-lock timer: walking is the one thing a user does
 * without touching their phone, the screen going off backgrounds the app, and
 * the capture then throws away every step it had counted. Every case here is
 * therefore about the lock's edges - taken as the window opens, released as
 * soon as it closes however it closed, and never left behind.
 */

import { createMovementCapture, type MovementCapture } from "../src/movement/capture.ts";
import { keepScreenAwakeWhileWalking, type ScreenLock } from "../src/movement/screen-lock.ts";
import {
  createFakeForeground,
  createFakePedometer,
  type FakeForeground,
  type FakePedometer,
} from "./support/fake-pedometer.ts";

interface FakeLock extends ScreenLock {
  /** Every call in the order it was made, as "awake" and "sleep". */
  readonly calls: string[];
  /** Whether the screen is being held on right now. */
  held(): boolean;
}

function fakeLock(overrides: Partial<ScreenLock> = {}): FakeLock {
  const calls: string[] = [];
  return {
    calls,
    keepAwake: async () => {
      calls.push("awake");
    },
    allowSleep: async () => {
      calls.push("sleep");
    },
    held: () => calls.at(-1) === "awake",
    ...overrides,
  };
}

interface Given {
  capture: MovementCapture;
  pedometer: FakePedometer;
  foreground: FakeForeground;
  lock: FakeLock;
  release: () => void;
}

function given(lock: FakeLock = fakeLock()): Given {
  const pedometer = createFakePedometer();
  const foreground = createFakeForeground();
  const capture = createMovementCapture({ pedometer, foreground, platform: "ios" });
  return {
    capture,
    pedometer,
    foreground,
    lock,
    release: keepScreenAwakeWhileWalking(capture, lock),
  };
}

/** The lock's calls are queued behind each other, so they settle a turn later. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("the screen during a walk", () => {
  it("leaves the device's own timer alone until a walk begins", async () => {
    const g = given();
    await settle();

    expect(g.lock.calls).toEqual([]);
  });

  it("holds the screen on for as long as steps are being counted", async () => {
    const g = given();

    await g.capture.start();
    await settle();
    expect(g.lock.held()).toBe(true);

    g.pedometer.deliver(120);
    await settle();
    // Still one hold, not one per reading: the device is asked to change
    // something, and a step counter reporting every stride would otherwise
    // reach for the operating system a hundred times a walk.
    expect(g.lock.calls).toEqual(["awake"]);
  });

  it("lets the screen sleep again the moment the user saves the walk", async () => {
    const g = given();

    await g.capture.start();
    await g.capture.stop();
    await settle();

    expect(g.lock.calls).toEqual(["awake", "sleep"]);
  });

  it("lets the screen sleep again when the walk ends on its own", async () => {
    const g = given();

    await g.capture.start();
    g.foreground.set(false);
    await settle();

    expect(g.lock.held()).toBe(false);
  });

  it("does not leave the phone awake when the runtime is disposed mid-walk", async () => {
    const g = given();

    await g.capture.start();
    await settle();
    g.release();
    await settle();

    expect(g.lock.calls).toEqual(["awake", "sleep"]);
  });

  it("stops watching once released, so a later walk is not its business", async () => {
    const g = given();

    g.release();
    await g.capture.start();
    await settle();

    expect(g.lock.calls).toEqual([]);
  });

  it("carries on when the device refuses to hold its screen on", async () => {
    const g = given(
      fakeLock({
        keepAwake: async () => {
          throw new Error("no wake lock on this device");
        },
      }),
    );

    await g.capture.start();
    await settle();
    await g.capture.stop();
    await settle();

    // The walk is unaffected, and the release still runs: a failed hold that
    // swallowed the release after it would be a lock stuck on for good.
    expect(g.capture.getState().status).toBe("stopped");
    expect(g.lock.calls).toEqual(["sleep"]);
  });
});
