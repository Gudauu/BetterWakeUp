/**
 * The screen a user who has flown somewhere lands on.
 *
 * What it has to get right is the comparison: the time the user set, and the
 * time that promise is actually being judged at where they now stand. The rest
 * of the screen is a single press, so these tests pin the two times, the
 * warning that only applies going east, and what the user is told once the
 * server has moved the tasks.
 */

import { render, screen, userEvent } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { TimeZoneScreen } from "../src/screens/time-zone-screen.tsx";
import { challengeView, type FakeApi, fakeApi, taskView } from "./support/fake-api.ts";

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const LOS_ANGELES = "America/Los_Angeles";
const NEW_YORK = "America/New_York";
const NOW = new Date("2026-09-01T13:00:00.000Z");

/** The fixture challenge, whose 14:00Z deadline is 7:00 AM in Los Angeles. */
function challengeIn(timeZone: string) {
  const base = challengeView({ currentTask: taskView() });
  return { ...base, configuration: { ...base.configuration, timeZone } };
}

/**
 * The fixture task's pause cutoff (06:00Z) is behind the suite's clock, so the
 * server would leave it exactly where it is and the screen has nothing
 * concrete to say about this morning. A test that is about the move's effect
 * on today states a cutoff that is still ahead instead.
 */
function movableTask() {
  return taskView({ pauseCutoff: "2026-09-01T13:30:00.000Z" });
}

async function drawScreen(
  move: { from: string; to: string },
  options: { api?: FakeApi; onChanged?: () => void; task?: ReturnType<typeof taskView> } = {},
) {
  const api = options.api ?? fakeApi();
  const base = challengeIn(move.from);
  const challenge = options.task === undefined ? base : { ...base, currentTask: options.task };
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <TimeZoneScreen
        api={api}
        challenge={challenge}
        move={move}
        now={() => NOW}
        {...(options.onChanged === undefined ? {} : { onChanged: options.onChanged })}
      />
    </SafeAreaProvider>,
  );
  return api;
}

describe("TimeZoneScreen", () => {
  it("puts the promised time beside the time it is actually judged at", async () => {
    await drawScreen({ from: LOS_ANGELES, to: NEW_YORK });

    expect(screen.getByTestId("time-zone-promised")).toHaveTextContent(/7:00 AM in Los Angeles/);
    expect(screen.getByTestId("time-zone-actual")).toHaveTextContent(/10:00 AM/);
    expect(screen.getByTestId("time-zone-switch")).toBeOnTheScreen();
  });

  it("warns that travelling east pulls the next deadline earlier", async () => {
    await drawScreen({ from: LOS_ANGELES, to: NEW_YORK });

    expect(screen.getByTestId("time-zone-earlier-warning")).toHaveTextContent(/counts as missed/);
  });

  it("says nothing about missed days when the deadlines only move later", async () => {
    await drawScreen({ from: NEW_YORK, to: LOS_ANGELES });

    expect(screen.queryByTestId("time-zone-earlier-warning")).toBeNull();
  });

  it("names the time this morning would land on rather than supposing it might", async () => {
    await drawScreen({ from: LOS_ANGELES, to: NEW_YORK }, { task: movableTask() });

    expect(screen.getByTestId("time-zone-impact")).toHaveTextContent(
      /from 10:00 AM to 7:00 AM where you are/,
    );
    expect(screen.getByTestId("time-zone-impact")).toHaveTextContent(/already gone by/);
    // The supposition it replaces is not left on screen beside it.
    expect(screen.queryByTestId("time-zone-earlier-warning")).toBeNull();
  });

  it("confirms before a switch that would drop this morning into the past", async () => {
    const user = userEvent.setup();
    const api = await drawScreen({ from: LOS_ANGELES, to: NEW_YORK }, { task: movableTask() });

    await user.press(screen.getByTestId("time-zone-switch"));
    expect(api.calls).toEqual([]);
    expect(screen.getByTestId("time-zone-switch-consequence")).toHaveTextContent(/already gone by/);

    await user.press(screen.getByTestId("time-zone-switch-confirm"));
    expect(api.calls).toHaveLength(1);
  });

  it("asks for no confirmation when the morning survives the move", async () => {
    const user = userEvent.setup();
    const api = await drawScreen(
      { from: LOS_ANGELES, to: NEW_YORK },
      {
        task: taskView({
          deadline: "2026-09-01T20:00:00.000Z",
          pauseCutoff: "2026-09-01T13:30:00.000Z",
        }),
      },
    );

    expect(screen.getByTestId("time-zone-impact")).toHaveTextContent(/4 hours away/);

    await user.press(screen.getByTestId("time-zone-switch"));
    expect(api.calls).toHaveLength(1);
  });

  it("moves the challenge and names what moved with it", async () => {
    const user = userEvent.setup();
    const api = await drawScreen({ from: LOS_ANGELES, to: NEW_YORK });

    await user.press(screen.getByTestId("time-zone-switch"));

    expect(api.calls).toEqual([
      {
        name: "changeChallengeTimeZone",
        input: {
          params: { challengeId: challengeIn(LOS_ANGELES).id },
          body: { timeZone: NEW_YORK },
        },
      },
    ]);
    expect(await screen.findByTestId("time-zone-done")).toBeOnTheScreen();
    expect(screen.getByTestId("time-zone-moved-count")).toHaveTextContent(/One upcoming day moved/);
    // Read in the zone the user is now in, which is the whole point of moving.
    expect(screen.getByTestId("time-zone-next-deadline")).toHaveTextContent(/10:00 AM/);
  });

  it("reports a refusal rather than claiming the deadlines moved", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      changeChallengeTimeZone: new Error("boom"),
    });
    await drawScreen({ from: LOS_ANGELES, to: NEW_YORK }, { api });

    await user.press(screen.getByTestId("time-zone-switch"));

    expect(await screen.findByTestId("time-zone-problem")).toBeOnTheScreen();
    expect(screen.queryByTestId("time-zone-done")).toBeNull();
  });

  it("hands the caller back only once the move is done", async () => {
    const user = userEvent.setup();
    let changed = 0;
    await drawScreen(
      { from: LOS_ANGELES, to: NEW_YORK },
      {
        onChanged: () => {
          changed += 1;
        },
      },
    );

    await user.press(screen.getByTestId("time-zone-switch"));
    expect(await screen.findByTestId("time-zone-done")).toBeOnTheScreen();
    expect(changed).toBe(0);

    await user.press(screen.getByTestId("time-zone-done-back"));
    expect(changed).toBe(1);
  });
});
