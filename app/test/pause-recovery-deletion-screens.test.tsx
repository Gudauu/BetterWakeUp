/**
 * The pause, recovery, and deletion screens.
 *
 * The screens are tested for the two things issue 33 asks of them: a paused
 * challenge never reads as running, and no irreversible action happens on one
 * press. The second is asserted through the fake client's call list, so a
 * first press that opened a confirmation is distinguishable from one that
 * acted.
 */

import type { ChallengeView } from "@betterwakeup/contract";
import { render, screen, userEvent } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { DeleteAccountScreen } from "../src/screens/delete-account-screen.tsx";
import { PauseScreen } from "../src/screens/pause-screen.tsx";
import { RecoveryScreen } from "../src/screens/recovery-screen.tsx";
import { challengeView, type FakeApi, fakeApi, taskView } from "./support/fake-api.ts";

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const NOW = new Date("2026-09-01T13:00:00.000Z");
const now = () => NOW;

// `render` is asynchronous under React 19, and `screen` is only bound once it
// has settled, so every helper here awaits it.
async function draw(element: React.ReactElement) {
  await render(<SafeAreaProvider initialMetrics={METRICS}>{element}</SafeAreaProvider>);
}

async function pauseScreen(challenge: ChallengeView, api: FakeApi = fakeApi()) {
  await draw(<PauseScreen api={api} challenge={challenge} now={now} />);
  return api;
}

describe("PauseScreen while running", () => {
  it("names the task pausing would skip before anything is confirmed", async () => {
    await pauseScreen(
      challengeView({ currentTask: taskView({ pauseCutoff: "2026-09-01T18:00:00.000Z" }) }),
    );

    expect(screen.getByTestId("pause-status")).toHaveTextContent(/running/);
    // The day is named the way a person says it, not the way the server sends
    // it: an ISO date here is a defect, not a formatting preference.
    expect(screen.getByTestId("next-skipped-task")).toHaveTextContent(/Tuesday, September 1/);
    expect(screen.getByTestId("next-skipped-task")).not.toHaveTextContent(/2026-09-01/);
  });

  it("says the current task stays live when its cutoff has passed", async () => {
    await pauseScreen(
      challengeView({ currentTask: taskView({ pauseCutoff: "2026-09-01T06:00:00.000Z" }) }),
    );

    expect(screen.getByTestId("next-skipped-task")).toHaveTextContent(/stays live/);
  });

  it("spells out what a pause protects before it is taken", async () => {
    await pauseScreen(challengeView({ currentTask: taskView() }));

    expect(screen.getByText(/no deadline counts/)).toBeTruthy();
    expect(screen.getByText(/Emergency Recovery stays untouched/)).toBeTruthy();
  });

  it("pauses nothing on the first press, and pauses on the confirmation", async () => {
    const user = userEvent.setup();
    const api = await pauseScreen(challengeView({ currentTask: taskView() }));

    await user.press(screen.getByTestId("pause"));
    expect(api.names()).toEqual([]);
    expect(screen.getByTestId("pause-consequence")).toHaveTextContent(/resume at any time/);

    await user.press(screen.getByTestId("pause-confirm"));
    expect(api.names()).toEqual(["pauseChallenge"]);
  });

  it("cancels back to the unopened control without pausing", async () => {
    const user = userEvent.setup();
    const api = await pauseScreen(challengeView({ currentTask: taskView() }));

    await user.press(screen.getByTestId("pause"));
    await user.press(screen.getByTestId("pause-cancel"));

    expect(api.names()).toEqual([]);
    expect(screen.queryByTestId("pause-confirm")).toBeNull();
  });

  it("shows the server's refusal as one plain sentence", async () => {
    const user = userEvent.setup();
    const api = await pauseScreen(
      challengeView({ currentTask: taskView() }),
      fakeApi({ pauseChallenge: new Error("nope") }),
    );

    await user.press(screen.getByTestId("pause"));
    await user.press(screen.getByTestId("pause-confirm"));

    expect(api.names()).toEqual(["pauseChallenge"]);
    expect(screen.getByTestId("pause-problem")).toHaveTextContent(/Try again/);
  });
});

describe("PauseScreen while paused", () => {
  const paused = (expiresAt: string | null) =>
    challengeView({
      pause: { pausedAt: "2026-08-20T00:00:00.000Z", expiresAt },
      currentTask: taskView(),
    });

  it("never presents a paused challenge as running", async () => {
    await pauseScreen(paused("2027-08-20T00:00:00.000Z"));

    expect(screen.getByTestId("pause-status")).toHaveTextContent(/paused/);
    expect(screen.getByTestId("pause-status")).not.toHaveTextContent(/is running/);
    expect(screen.getByTestId("paused-banner")).toHaveTextContent(/nothing can be failed/);
    // No pause control and no named task: both would suggest the challenge is
    // still running even while the heading says otherwise.
    expect(screen.queryByTestId("pause")).toBeNull();
    expect(screen.queryByTestId("next-skipped-task")).toBeNull();
    expect(screen.getByTestId("resume")).toBeTruthy();
  });

  it("stays quiet about the year while it is far off", async () => {
    await pauseScreen(paused("2027-08-20T00:00:00.000Z"));

    expect(screen.queryByTestId("pause-expiry-warning")).toBeNull();
  });

  it("states what will happen as the year approaches", async () => {
    await pauseScreen(paused("2026-09-15T13:00:00.000Z"));

    expect(screen.getByTestId("pause-expiry-warning")).toHaveTextContent(
      /neither a success nor a failure/,
    );
  });

  it("resumes on the confirmation", async () => {
    const user = userEvent.setup();
    const api = await pauseScreen(paused(null));

    await user.press(screen.getByTestId("resume"));
    expect(api.names()).toEqual([]);

    await user.press(screen.getByTestId("resume-confirm"));
    expect(api.names()).toEqual(["resumeChallenge"]);
  });
});

describe("RecoveryScreen", () => {
  const offered = challengeView({
    status: "recovery_pending",
    recoveryOffer: {
      taskId: "66666666-6666-4666-8666-666666666666",
      offeredAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-09-02T00:00:00.000Z",
    },
  });

  it("states that spending the recovery is permanent", async () => {
    const api = fakeApi();
    await draw(<RecoveryScreen api={api} challenge={offered} now={now} />);

    expect(screen.getByTestId("recovery-permanence")).toHaveTextContent(/permanent/);
    expect(screen.getByTestId("recovery-permanence")).toHaveTextContent(/never comes back/);
  });

  it("spends nothing on the first press", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    await draw(<RecoveryScreen api={api} challenge={offered} now={now} />);

    await user.press(screen.getByTestId("accept-recovery"));
    expect(api.names()).toEqual([]);
    expect(screen.getByTestId("accept-recovery-consequence")).toHaveTextContent(/permanent/);

    await user.press(screen.getByTestId("accept-recovery-confirm"));
    expect(api.names()).toEqual(["acceptRecovery"]);
  });

  it("reads the closing time in the challenge's zone rather than as an instant", async () => {
    const api = fakeApi();
    await draw(<RecoveryScreen api={api} challenge={offered} now={now} />);

    // Midnight UTC is 5pm the previous afternoon in the challenge's zone, and
    // the afternoon is the one the user has to act by.
    expect(screen.getByTestId("recovery-deadline")).toHaveTextContent(/Tue, Sep 1, 5:00 PM/);
    expect(screen.getByTestId("recovery-deadline")).not.toHaveTextContent(/2026-09-02T/);
  });

  it("states what keeping the recovery costs, beside what spending it costs", async () => {
    const api = fakeApi();
    await draw(<RecoveryScreen api={api} challenge={offered} now={now} />);

    expect(screen.getByTestId("recovery-expiry")).toHaveTextContent(/deposit is charged/);
    expect(screen.getByTestId("recovery-expiry")).toHaveTextContent(/unspent for a future/);
  });

  it("offers declining as a real choice and sends nothing for it", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    const declined = jest.fn();
    await draw(<RecoveryScreen api={api} challenge={offered} now={now} onDeclined={declined} />);

    await user.press(screen.getByTestId("decline-recovery"));

    expect(declined).toHaveBeenCalledTimes(1);
    expect(api.names()).toEqual([]);
  });

  // The offer closes at a wall-clock instant and the whole deposit turns on it,
  // so an absolute time on its own leaves the user to do the arithmetic.
  it("counts the window down beside the time it closes", async () => {
    const api = fakeApi();
    await draw(<RecoveryScreen api={api} challenge={offered} now={now} />);

    expect(screen.getByTestId("recovery-time-left")).toHaveTextContent(/11 hours left to decide/);
  });

  it("withdraws the decision once the window has closed, and sends nothing", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    const back = jest.fn();
    const closed = () => new Date("2026-09-02T01:00:00.000Z");
    await draw(<RecoveryScreen api={api} challenge={offered} now={closed} onBack={back} />);

    expect(screen.getByTestId("recovery-closed")).toHaveTextContent(/the missed day stands/);
    expect(screen.getByTestId("recovery-unspent")).toHaveTextContent(/stays unused/);
    // The command refuses an expired offer before it sends anything, so the
    // choice was two presses that could only ever end in a refusal.
    expect(screen.queryByTestId("accept-recovery")).toBeNull();
    expect(screen.queryByTestId("decline-recovery")).toBeNull();

    await user.press(screen.getByTestId("recovery-back"));
    expect(back).toHaveBeenCalledTimes(1);
    expect(api.names()).toEqual([]);
  });
});

describe("DeleteAccountScreen", () => {
  it("states that deletion is permanent and deletes nothing on the first press", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    await draw(<DeleteAccountScreen api={api} challenge={null} />);

    expect(screen.getByTestId("deletion-permanence")).toHaveTextContent(/permanent/);

    await user.press(screen.getByTestId("delete-account"));
    expect(api.names()).toEqual([]);

    await user.press(screen.getByTestId("delete-account-confirm"));
    expect(api.names()).toEqual(["deleteAccount"]);
  });

  it("names each thing deletion takes rather than summarising it", async () => {
    const api = fakeApi();
    await draw(<DeleteAccountScreen api={api} challenge={null} />);

    expect(screen.getByText(/Emergency Recovery allowance, spent or not/)).toBeTruthy();
    expect(screen.getByText(/Every day you completed/)).toBeTruthy();
  });

  it("paints the acting press as destructive once the confirmation is open", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    await draw(<DeleteAccountScreen api={api} challenge={null} />);

    await user.press(screen.getByTestId("delete-account"));

    // The second press has to look unlike the first, or it reads as a repeat
    // of the press that only opened the consequence.
    expect(screen.getByTestId("delete-account-confirmation")).toBeTruthy();
    expect(screen.getByTestId("delete-account-cancel")).toBeTruthy();
  });

  it("offers no deletion control while a funded challenge is unsettled, and says why", async () => {
    const api = fakeApi();
    const funded = challengeView({
      configuration: {
        ...challengeView().configuration,
        deposit: { amount: 5000, currency: "USD" },
      },
    });
    await draw(<DeleteAccountScreen api={api} challenge={funded} />);

    expect(screen.queryByTestId("delete-account")).toBeNull();
    expect(screen.getByTestId("deletion-blocked")).toHaveTextContent(/once that challenge settles/);
  });
});
