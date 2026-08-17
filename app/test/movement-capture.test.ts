import { type CaptureState, createMovementCapture } from "../src/movement/capture.ts";
import {
  createFakeForeground,
  createFakePedometer,
  type FakeForeground,
  type FakePedometer,
} from "./support/fake-pedometer.ts";

interface Harness {
  pedometer: FakePedometer;
  foreground: FakeForeground;
  capture: ReturnType<typeof createMovementCapture>;
  /** Move the injected clock forward, in seconds. */
  tick(seconds: number): void;
  states: CaptureState[];
}

function harness(options: { platform?: string; foreground?: boolean } = {}): Harness {
  const pedometer = createFakePedometer();
  const foreground = createFakeForeground(options.foreground ?? true);
  let clock = new Date("2026-03-01T06:00:00.000Z").getTime();
  const states: CaptureState[] = [];

  const capture = createMovementCapture({
    pedometer,
    foreground,
    platform: options.platform ?? "ios",
    now: () => new Date(clock),
  });
  capture.subscribe((state) => states.push(state));

  return {
    pedometer,
    foreground,
    capture,
    tick: (seconds) => {
      clock += seconds * 1000;
    },
    states,
  };
}

describe("a capture begins only when the device and the user allow it", () => {
  it("reports unsupported when the device has no step counter", async () => {
    const { capture, pedometer } = harness();
    pedometer.available = false;

    expect(await capture.start()).toEqual({ status: "unsupported" });
    expect(pedometer.liveSubscriptions()).toBe(0);
  });

  it("asks for motion access when it has never been asked for", async () => {
    const { capture, pedometer } = harness();
    pedometer.permission = "undetermined";

    expect((await capture.start()).status).toBe("recording");
    expect(pedometer.requests).toBe(1);
  });

  it("does not ask again once the answer is standing", async () => {
    const { capture, pedometer } = harness();

    await capture.start();

    expect(pedometer.requests).toBe(0);
  });

  it("reports a refusal and watches nothing", async () => {
    const { capture, pedometer } = harness();
    pedometer.permission = "undetermined";
    pedometer.onRequest = "denied";

    expect(await capture.start()).toEqual({ status: "permission-denied" });
    expect(pedometer.liveSubscriptions()).toBe(0);
  });

  it("notices a permission revoked in Settings between two attempts", async () => {
    const { capture, pedometer } = harness();

    await capture.start();
    await capture.stop();
    pedometer.permission = "denied";

    // Re-read rather than remembered: the first capture proves nothing about
    // the second.
    expect((await capture.start()).status).toBe("permission-denied");
  });

  it("refuses to open a window while the app is not in front of the user", async () => {
    const { capture, pedometer } = harness({ foreground: false });

    expect(await capture.start()).toEqual({
      status: "stopped",
      reason: "backgrounded",
      observation: null,
    });
    expect(pedometer.liveSubscriptions()).toBe(0);
  });

  it("ignores a second start while one window is open", async () => {
    const { capture, pedometer } = harness();

    await capture.start();
    await capture.start();

    expect(pedometer.liveSubscriptions()).toBe(1);
  });
});

describe("a running capture counts what the platform reports", () => {
  it("takes the latest cumulative reading rather than adding readings up", async () => {
    const { capture, pedometer } = harness();
    await capture.start();

    pedometer.deliver(40);
    pedometer.deliver(95);

    expect(capture.getState()).toEqual({
      status: "recording",
      startedAt: new Date("2026-03-01T06:00:00.000Z"),
      steps: 95,
    });
  });

  it("does not shrink a window when the platform counter resets under it", async () => {
    const { capture, pedometer } = harness();
    await capture.start();

    pedometer.deliver(300);
    pedometer.deliver(2);

    expect(capture.getState()).toMatchObject({ steps: 300 });
  });

  it("publishes every reading to subscribers", async () => {
    const { capture, pedometer, states } = harness();
    await capture.start();
    pedometer.deliver(10);
    pedometer.deliver(20);

    expect(
      states.map((state) => (state.status === "recording" ? state.steps : state.status)),
    ).toEqual([0, 10, 20]);
  });
});

describe("stopping closes the window and normalizes it", () => {
  it("produces one live-foreground observation over the watched window", async () => {
    const { capture, pedometer, tick } = harness();
    await capture.start();
    pedometer.deliver(1500);
    tick(240);

    const state = await capture.stop();

    expect(state).toEqual({
      status: "stopped",
      reason: "requested",
      observation: {
        startedAt: "2026-03-01T06:00:00.000Z",
        endedAt: "2026-03-01T06:04:00.000Z",
        steps: 1500,
        provenance: "live-foreground",
        source: "expo-pedometer-ios",
      },
    });
  });

  it("names the platform it actually ran on", async () => {
    const { capture, tick } = harness({ platform: "android" });
    await capture.start();
    tick(10);

    const state = await capture.stop();

    expect(state).toMatchObject({ observation: { source: "expo-pedometer-android" } });
  });

  it("cancels its subscriptions", async () => {
    const { capture, pedometer } = harness();
    await capture.start();

    await capture.stop();

    expect(pedometer.liveSubscriptions()).toBe(0);
  });

  it("does nothing when no window is open", async () => {
    const { capture } = harness();

    expect(await capture.stop()).toEqual({ status: "idle" });
  });
});

describe("a backgrounded app records no movement", () => {
  it("closes the window the moment the app leaves the foreground", async () => {
    const { capture, foreground, pedometer, tick } = harness();
    await capture.start();
    pedometer.deliver(600);
    tick(60);

    foreground.set(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(capture.getState()).toMatchObject({
      status: "stopped",
      reason: "backgrounded",
      observation: { steps: 600, endedAt: "2026-03-01T06:01:00.000Z" },
    });
    expect(pedometer.liveSubscriptions()).toBe(0);
  });

  it("counts nothing a reading delivered after backgrounding claims", async () => {
    const { capture, foreground, pedometer, tick } = harness();
    await capture.start();
    pedometer.deliver(600);
    tick(60);
    foreground.set(false);
    await Promise.resolve();
    await Promise.resolve();

    // The fake keeps delivering to a removed subscription on purpose: the rule
    // has to be enforced here, not by the platform being well behaved.
    pedometer.deliver(9000);

    expect(capture.getState()).toMatchObject({ observation: { steps: 600 } });
  });

  it("does not reopen the closed window when the app comes back", async () => {
    const { capture, foreground, pedometer } = harness();
    await capture.start();
    foreground.set(false);
    await Promise.resolve();
    await Promise.resolve();

    foreground.set(true);
    pedometer.deliver(400);

    expect(capture.getState()).toMatchObject({ status: "stopped", reason: "backgrounded" });
  });

  it("starts a fresh window rather than resuming the old one", async () => {
    const { capture, foreground, pedometer, tick } = harness();
    await capture.start();
    pedometer.deliver(600);
    foreground.set(false);
    await Promise.resolve();
    await Promise.resolve();

    foreground.set(true);
    tick(120);
    await capture.start();

    expect(capture.getState()).toEqual({
      status: "recording",
      startedAt: new Date("2026-03-01T06:02:00.000Z"),
      steps: 0,
    });
  });
});

describe("permission revoked while a window is open discards it", () => {
  it("refuses to hand over movement the user has withdrawn access to", async () => {
    const { capture, pedometer, tick } = harness();
    await capture.start();
    pedometer.deliver(1500);
    tick(240);
    pedometer.permission = "denied";

    expect(await capture.stop()).toEqual({
      status: "stopped",
      reason: "permission-revoked",
      observation: null,
    });
  });

  it("applies the same rule to a window the background closed", async () => {
    const { capture, foreground, pedometer } = harness();
    await capture.start();
    pedometer.deliver(1500);
    pedometer.permission = "denied";

    foreground.set(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(capture.getState()).toMatchObject({
      reason: "permission-revoked",
      observation: null,
    });
  });
});
