/**
 * What a tapped wake-up reminder leads to.
 *
 * The alarm exists to get someone walking, so the tap has to arrive somewhere -
 * including the tap that launched the app from a lock screen, which happens
 * before anything is listening. These tests are about that delivery and about
 * the one thing a tap must not do: open a screen for something that is no
 * longer there.
 */

import { act, render } from "@testing-library/react-native";
import { Text } from "react-native";
import {
  type ReminderTapTrigger,
  tapDestination,
  useReminderTaps,
} from "../src/reminders/reminder-taps.ts";
import type { ReminderTarget } from "../src/reminders/reminders.ts";
import { challengeView, taskView } from "./support/fake-api.ts";
import { fakeReminderTaps } from "./support/fake-reminder-taps.ts";

const OFFERED = challengeView({
  status: "recovery_pending",
  currentTask: null,
  recoveryOffer: {
    taskId: "44444444-4444-4444-8444-444444444444",
    offeredAt: "2026-09-01T15:00:00.000Z",
    expiresAt: "2026-09-02T15:00:00.000Z",
  },
});

function Probe({
  trigger,
  onTap,
}: {
  readonly trigger: ReminderTapTrigger;
  readonly onTap: (target: ReminderTarget) => void;
}) {
  useReminderTaps(onTap, { trigger });
  return <Text>listening</Text>;
}

describe("a tap reaching the app", () => {
  it("delivers the tap that launched the app, which nothing was listening for", async () => {
    const taps = fakeReminderTaps({ launchedBy: "walk" });
    const heard: ReminderTarget[] = [];

    await render(<Probe trigger={taps.trigger} onTap={(target) => heard.push(target)} />);
    // The launch tap is read asynchronously, the way the operating system
    // hands it over.
    await act(async () => undefined);

    expect(heard).toEqual(["walk"]);
  });

  it("delivers a tap that arrives while the app is already open", async () => {
    const taps = fakeReminderTaps();
    const heard: ReminderTarget[] = [];

    await render(<Probe trigger={taps.trigger} onTap={(target) => heard.push(target)} />);
    await taps.tap("recovery");

    expect(heard).toEqual(["recovery"]);
  });

  it("stops listening once the screen is gone", async () => {
    const taps = fakeReminderTaps();
    const heard: ReminderTarget[] = [];
    const view = await render(
      <Probe trigger={taps.trigger} onTap={(target) => heard.push(target)} />,
    );

    await act(async () => {
      view.unmount();
    });
    await taps.tap("walk");

    expect(heard).toEqual([]);
  });
});

describe("where a tap leads", () => {
  it("opens the walk the alarm was asking for", () => {
    expect(tapDestination("walk", challengeView({ currentTask: taskView() }))).toBe("walk");
  });

  it("opens the recovery decision the offer was asking for", () => {
    expect(tapDestination("recovery", OFFERED)).toBe("recovery");
  });

  it("leads home when the walk it named is no longer open", () => {
    // The reminder was scheduled from the last read and fires from the device,
    // so the day may have been walked - or the challenge ended - since.
    expect(tapDestination("walk", challengeView({ currentTask: null }))).toBe("home");
    expect(tapDestination("walk", challengeView({ status: "succeeded" }))).toBe("home");
  });

  it("leads home while the challenge is paused, since nothing is due", () => {
    const paused = challengeView({
      currentTask: taskView(),
      pause: { pausedAt: "2026-09-01T10:00:00.000Z", expiresAt: "2027-09-01T10:00:00.000Z" },
    });

    expect(tapDestination("walk", paused)).toBe("home");
  });

  it("leads home when the recovery offer has already been decided", () => {
    expect(tapDestination("recovery", challengeView({ currentTask: taskView() }))).toBe("home");
  });

  it("leads home for an account that holds no challenge at all", () => {
    expect(tapDestination("walk", null)).toBe("home");
    expect(tapDestination("recovery", null)).toBe("home");
  });
});
