/**
 * The ticking clock every countdown in the app is drawn from.
 *
 * Its whole reason to exist is that a screen left open goes stale, so the
 * things checked here are that it moves on its own, that it stops when its
 * screen goes away, and that a clock which is not moving does not make the
 * screen re-render for nothing.
 */

import { act, render, screen } from "@testing-library/react-native";
import { Text } from "react-native";
import { CLOCK_INTERVAL_MS, useClock } from "../src/ui/clock.ts";

/** Reads the clock out as text, and counts how often it was drawn. */
function Probe({ now, onRender }: { now?: () => Date; onRender?: () => void }) {
  const clock = useClock(now);
  onRender?.();
  return <Text testID="clock">{clock.toISOString()}</Text>;
}

/** Lets the interval fire the stated number of times. */
async function tick(times = 1) {
  await act(async () => {
    jest.advanceTimersByTime(CLOCK_INTERVAL_MS * times);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("useClock", () => {
  it("starts at the instant its caller reads", async () => {
    await render(<Probe now={() => new Date("2026-09-01T12:00:00.000Z")} />);

    expect(screen.getByTestId("clock")).toHaveTextContent("2026-09-01T12:00:00.000Z");
  });

  it("moves on without anyone touching the screen", async () => {
    // The point of the whole module: a phone left face-up has to keep telling
    // the truth about how much of the morning is left.
    const instants = [
      new Date("2026-09-01T12:00:00.000Z"),
      new Date("2026-09-01T12:00:30.000Z"),
      new Date("2026-09-01T12:01:00.000Z"),
    ];
    let index = 0;
    await render(<Probe now={() => instants[Math.min(index++, instants.length - 1)] as Date} />);

    await tick();
    expect(screen.getByTestId("clock")).toHaveTextContent("2026-09-01T12:00:30.000Z");

    await tick();
    expect(screen.getByTestId("clock")).toHaveTextContent("2026-09-01T12:01:00.000Z");
  });

  it("leaves a screen alone while the stated clock answers the same instant", async () => {
    // Which is what every test in this repo does: a fixed clock must not make
    // the screen under test re-render sixty times a run.
    let renders = 0;
    await render(
      <Probe now={() => new Date("2026-09-01T12:00:00.000Z")} onRender={() => renders++} />,
    );
    const drawn = renders;

    await tick(4);

    expect(renders).toBe(drawn);
  });

  it("stops ticking once its screen is gone", async () => {
    let reads = 0;
    await render(
      <Probe
        now={() => {
          reads++;
          return new Date(`2026-09-01T12:00:${String(reads).padStart(2, "0")}.000Z`);
        }}
      />,
    );

    await tick();
    const afterOneTick = reads;
    await act(async () => {
      screen.unmount();
    });
    await tick(3);

    expect(reads).toBe(afterOneTick);
  });
});
