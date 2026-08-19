/**
 * Today's task.
 *
 * The screen's whole job is to be honest about two separate facts. The local
 * check says the device counted enough steps and wrote the result down; the
 * server check says the server acknowledged that result. Only the second one
 * makes the day count, so the two are drawn as two rows and the day is called
 * complete only when `dailyCompletionState` says the server acknowledged it.
 *
 * Honest is not the same as terse. The status is stated once as a headline, in
 * the colour that status deserves, and followed by the one sentence that says
 * what the user should do about it - a person who has just woken up should not
 * have to infer their next move from two rows reading "waiting".
 *
 * The screen owns no rules. It renders the state that module derives, and it
 * asks the movement capture and the completion sync to do the work.
 */

import type { ChallengeView, TaskView } from "@betterwakeup/contract";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { formatMoney } from "../challenges/draft.ts";
import {
  type CheckState,
  type DailyCompletionState,
  dailyCompletionState,
} from "../completions/daily-state.ts";
import { VERIFICATION_POLICY_VERSION } from "../completions/policy.ts";
import type { PendingCompletionRecord, PendingCompletionStore } from "../completions/store.ts";
import type { CompletionSync } from "../completions/sync.ts";
import { deadlineMissedText, finishByText, timeLeft } from "../completions/time-left.ts";
import type { CaptureState, MovementCapture } from "../movement/capture.ts";
import type { MovementSimulation } from "../movement/simulated-pedometer.ts";
import { interruptionText, walkProgress } from "../movement/walk-progress.ts";
import { useClock } from "../ui/clock.ts";
import {
  AppText,
  Banner,
  Button,
  Card,
  Divider,
  ProgressBar,
  Screen,
  TextButton,
} from "../ui/components.tsx";
import { formatDay, formatTimeOfDay } from "../ui/format.ts";
import { useTheme } from "../ui/theme.ts";
import { BackLink } from "./back-link.tsx";

export interface DailyCompletionScreenProps {
  readonly challenge: ChallengeView;
  readonly capture: MovementCapture;
  readonly sync: CompletionSync;
  readonly store: PendingCompletionStore;
  readonly appVersion: string;
  /**
   * Present only in a build whose steps are typed in rather than walked. It
   * carries its own banner, so a screen counting invented steps always says so.
   */
  readonly simulation?: MovementSimulation | undefined;
  /** Injected in tests so the deadline warning is not the clock of the machine. */
  readonly now?: () => Date;
  /** Called when the server acknowledges, so the caller can re-read the challenge. */
  readonly onAcknowledged?: () => void;
  /**
   * Called when that acknowledgment was the last one the challenge needed.
   * The server says so in the completion response, so the caller learns the
   * challenge is over from the same answer rather than from a later read that
   * would only show it having disappeared.
   */
  readonly onFinished?: () => void;
  /** Offered as a way back when a caller put this screen on top of another. */
  readonly onBack?: () => void;
}

export function DailyCompletionScreen(props: DailyCompletionScreenProps) {
  const { challenge, capture, sync, store, appVersion } = props;

  const [records, setRecords] = useState<readonly PendingCompletionRecord[]>([]);
  const [captureState, setCaptureState] = useState<CaptureState>(() => capture.getState());
  const [shortfall, setShortfall] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // The clock ticks rather than being read at render time, so the countdown
  // counts and the deadline passing withdraws the walk while the screen sits
  // open, rather than on the next touch.
  const clock = useClock(props.now);
  /**
   * The task as the server described it when it acknowledged the completion.
   * The challenge this screen was handed was read before the walk, so its copy
   * of the task still says `scheduled`; without this the screen would fall back
   * to "not done yet" the moment the record left the store, and offer to start
   * the day again. It is the server's own answer rather than a local guess,
   * which is the only evidence `dailyCompletionState` accepts.
   */
  const [acknowledgedTask, setAcknowledgedTask] = useState<TaskView | null>(null);
  /**
   * Whether the acknowledgment that just landed ended the whole challenge.
   * Without it the screen would tell someone who has just finished a month of
   * mornings that there is "nothing else to do until tomorrow", and the
   * challenge would then vanish from home with no one having said so.
   */
  const [finished, setFinished] = useState(false);

  const current = challenge.currentTask;
  const task =
    acknowledgedTask !== null && current !== null && acknowledgedTask.id === current.id
      ? acknowledgedTask
      : current;

  const reload = useCallback(async () => {
    setRecords(await store.list());
  }, [store]);

  useEffect(() => {
    void reload();
    // Every outcome of a sync pass changes what is on disk, so one
    // subscription keeps the screen and the store from drifting apart.
    return sync.subscribe((event) => {
      void reload();
      if (event.type === "acknowledged") {
        setAcknowledgedTask(event.response.task);
        props.onAcknowledged?.();
        if (event.response.challengeStatus === "succeeded") {
          setFinished(true);
          props.onFinished?.();
        }
      }
    });
  }, [reload, sync, props.onAcknowledged, props.onFinished]);

  useEffect(() => capture.subscribe(setCaptureState), [capture]);

  const state = dailyCompletionState({ task, records, now: clock });
  const target = challenge.configuration.stepTarget;

  const onStart = useCallback(async () => {
    setShortfall(null);
    await capture.start();
  }, [capture]);

  const onStop = useCallback(async () => {
    setBusy(true);
    try {
      const stopped = await capture.stop();
      const observation = stopped.status === "stopped" ? stopped.observation : null;
      if (observation === null || task === null) {
        return;
      }
      if (observation.steps < target) {
        // Nothing is written down: a window that missed the target is not a
        // completion, and storing one would make the local check a lie.
        setShortfall(target - observation.steps);
        return;
      }
      await sync.record({
        challengeId: challenge.id,
        taskId: task.id,
        completedAt: observation.endedAt,
        observation,
        appVersion,
        verificationPolicyVersion: VERIFICATION_POLICY_VERSION,
      });
      await reload();
    } finally {
      setBusy(false);
    }
  }, [appVersion, capture, challenge, reload, sync, target, task]);

  const onRetry = useCallback(async () => {
    setBusy(true);
    try {
      await sync.syncAll();
      await reload();
    } finally {
      setBusy(false);
    }
  }, [reload, sync]);

  if (task === null) {
    return (
      <Screen testID="no-task-today">
        <BackLink testID="daily-back" onBack={props.onBack} />
        <AppText variant="display" accessibilityRole="header">
          Nothing due
        </AppText>
        <AppText variant="body" tone="muted">
          There is no open task right now. The next one appears on your next active day.
        </AppText>
      </Screen>
    );
  }

  const walk = walkProgress(captureState, target);
  const recording = walk.recording;
  const steps = walk.steps;
  const deadlineTime = formatTimeOfDay(task.deadline, challenge.configuration.timeZone);
  const left = timeLeft(state.minutesToDeadline);
  // A deadline that went by with nothing saved. Nothing started now can be
  // acknowledged - the server judges the instant the walk was finished - so the
  // screen says so rather than offering a walk that ends in a refusal.
  const missed = state.status === "incomplete" && state.deadlinePassed;

  return (
    <Screen testID="daily-completion">
      <BackLink testID="daily-back" onBack={props.onBack} />

      <View style={styles.header}>
        <AppText variant="caption" tone="accent">
          TODAY'S TASK
        </AppText>
        <AppText variant="display" accessibilityRole="header">
          {formatDay(task.date)}
        </AppText>
        <AppText variant="small" tone="muted" testID="deadline">
          {target} steps by {deadlineTime}
        </AppText>
        {/* The deadline as a countdown rather than as a time. Someone who has
            just woken up knows what 7:00 AM is and not what it is now, and the
            whole day turns on the difference. It goes quiet once the day is
            done, and once the deadline has passed the banner below says it
            with the consequence attached. */}
        {left === null || left.urgency === "expired" || state.status === "acknowledged" ? null : (
          <AppText
            variant="small"
            tone={left.urgency === "closing" ? "warning" : "muted"}
            testID="time-left"
          >
            {left.sentence}
          </AppText>
        )}
      </View>

      {/* The end of the whole challenge outranks the day that ended it, so it
          is said first, at display size, before the two checks that are now
          only the working behind it. */}
      {finished ? (
        <Card testID="challenge-finished">
          <AppText variant="caption" tone="success">
            CHALLENGE COMPLETE
          </AppText>
          <AppText variant="display" tone="success" accessibilityRole="header">
            You did it
          </AppText>
          <AppText variant="body" testID="challenge-finished-days">
            {finishedDaysText(challenge.configuration.requiredTaskCount)}
          </AppText>
          <AppText variant="small" tone="muted" testID="challenge-finished-deposit">
            {finishedDepositText(challenge)}
          </AppText>
          {props.onBack === undefined ? null : (
            <Button testID="challenge-finished-home" label="Back to home" onPress={props.onBack} />
          )}
        </Card>
      ) : null}

      {/* The status and the two checks it is derived from, in that order: the
          headline is the answer and the checks are the working, so a user who
          reads only the first line still leaves with the truth. */}
      <Card testID="daily-status">
        <AppText
          variant="title"
          tone={STATUS_TONE[state.status]}
          testID="progression"
          accessibilityRole="header"
        >
          {PROGRESSION_HEADLINE[state.status]}
        </AppText>
        <AppText variant="small" tone="muted">
          {finished ? FINISHED_ADVICE : missed ? MISSED_ADVICE : STATUS_ADVICE[state.status]}
        </AppText>

        <Divider />

        <CheckRow
          testID="local-check"
          label="Movement recorded on this device"
          check={state.localCheck}
        />
        <CheckRow
          testID="server-check"
          label="Acknowledged by the server"
          check={state.serverCheck}
        />
      </Card>

      {missed ? (
        <Banner tone="danger">
          <AppText variant="small" tone="danger" testID="deadline-missed" accessibilityRole="alert">
            {deadlineMissedText(deadlineTime)}
          </AppText>
        </Banner>
      ) : null}

      {state.deadlineWarning ? (
        <Banner tone={state.deadlinePassed ? "danger" : "warning"}>
          <AppText
            variant="small"
            tone={state.deadlinePassed ? "danger" : "warning"}
            testID="deadline-warning"
            accessibilityRole="alert"
          >
            {deadlineWarningText(state)}
          </AppText>
        </Banner>
      ) : null}

      {state.status === "rejected" && state.rejectedRecord !== null ? (
        <Banner tone="danger">
          <AppText variant="small" tone="danger" testID="rejected-detail" accessibilityRole="alert">
            {state.rejectedRecord.lastErrorMessage ?? "The server refused this completion."}
          </AppText>
        </Banner>
      ) : null}

      {shortfall === null ? null : (
        <Banner tone="warning">
          <AppText variant="small" tone="warning" testID="shortfall" accessibilityRole="alert">
            {shortfall} more steps needed before this counts. Nothing was recorded, so start again
            when you are ready to finish the walk.
          </AppText>
        </Banner>
      )}

      {walk.interruption === null ? null : (
        <Banner tone="danger">
          <AppText
            variant="small"
            tone="danger"
            testID="walk-interrupted"
            accessibilityRole="alert"
          >
            {interruptionText(walk.interruption)}
          </AppText>
        </Banner>
      )}

      {recording ? (
        <Card testID="capture">
          <AppText variant="caption" tone={walk.reachedTarget ? "success" : "accent"}>
            {walk.reachedTarget ? "TARGET REACHED" : "WALK IN PROGRESS"}
          </AppText>
          <AppText variant="display" tone={walk.reachedTarget ? "success" : "default"}>
            {steps}
            <AppText variant="headline" tone="muted">
              {" "}
              / {target} steps
            </AppText>
          </AppText>
          <ProgressBar done={steps} total={target} testID="capture-progress" />
          <AppText variant="small" tone="muted" testID="capture-steps">
            {steps} steps so far, target {target}.
          </AppText>
          {/* The one thing a walking user cannot guess: the window closes if
              they leave, so the hint stands until the target makes it moot. */}
          <AppText
            variant="small"
            tone={walk.reachedTarget ? "success" : "warning"}
            testID="capture-hint"
          >
            {walk.reachedTarget
              ? "That is the walk. Save it and the morning is yours."
              : `${walk.remaining} to go. Keep this screen open - leaving the app ends the walk.`}
          </AppText>
          {/* The other half of the rule, once the clock is close enough for it
              to bite: the server judges the instant the walk was saved, so a
              window opened in time and finished late is refused. */}
          {left !== null && left.urgency !== "ample" ? (
            <AppText variant="small" tone="danger" testID="capture-deadline">
              {finishByText(deadlineTime)}
            </AppText>
          ) : null}
          <Button
            testID="stop-capture"
            label={walk.reachedTarget ? "Save my walk" : "Stop and check"}
            busy={busy}
            onPress={onStop}
          />
        </Card>
      ) : null}

      {state.status === "incomplete" && !recording && !missed ? (
        <Button
          testID="start-capture"
          label={walk.interruption === null ? "Start moving" : "Start the walk again"}
          busy={busy}
          onPress={onStart}
        />
      ) : null}

      {props.simulation === undefined ? null : (
        <SimulationPanel
          simulation={props.simulation}
          recording={recording}
          remaining={recording ? Math.max(0, target - steps) : target}
        />
      )}

      {state.status === "syncPending" ? (
        <Button
          testID="retry-sync"
          label="Try to send it again"
          variant="secondary"
          busy={busy}
          onPress={onRetry}
        />
      ) : null}

      {captureState.status === "permission-denied" ? (
        <Banner tone="danger">
          <AppText variant="small" tone="danger" testID="motion-denied" accessibilityRole="alert">
            Motion access is off, so nothing can be counted. Turn it on in Settings.
          </AppText>
        </Banner>
      ) : null}

      {captureState.status === "unsupported" ? (
        <Banner tone="danger">
          <AppText
            variant="small"
            tone="danger"
            testID="motion-unsupported"
            accessibilityRole="alert"
          >
            This device has no step counter, so this challenge cannot be verified here.
          </AppText>
        </Banner>
      ) : null}
    </Screen>
  );
}

/**
 * The four states, worded so that the pending one cannot be mistaken for the
 * acknowledged one at a glance.
 */
const PROGRESSION_HEADLINE: Readonly<Record<DailyCompletionState["status"], string>> = {
  incomplete: "Not done yet",
  syncPending: "Recorded on this device, waiting for the server",
  acknowledged: "Done. Both checks passed",
  rejected: "The server refused this one. Action needed",
};

/** What to do about each state, which the headline alone does not say. */
const STATUS_ADVICE: Readonly<Record<DailyCompletionState["status"], string>> = {
  incomplete: "Start the walk when you are up. The steps are counted while this screen is open.",
  syncPending: "Your walk is saved on this phone. Keep the app open until the server has it.",
  acknowledged: "This day is yours. Nothing else to do until tomorrow.",
  rejected: "This walk was not accepted. The reason is below.",
};

/**
 * What replaces the acknowledged advice on the last day. "Until tomorrow" is
 * false once the challenge is over, and it is the wrong note to end a month on.
 */
const FINISHED_ADVICE = "That was the last day this challenge needed.";

/**
 * What replaces the incomplete advice once the deadline is behind the user.
 * "Start the walk when you are up" is an invitation to spend a morning on a
 * walk that the server has already stopped being able to accept.
 */
const MISSED_ADVICE =
  "This morning's window has closed. The next task opens on your next active day.";

/** What was actually done, counted. A one day challenge is not "all 1 days". */
function finishedDaysText(days: number): string {
  if (days === 1) {
    return "That was the day this challenge asked for, and it is verified.";
  }
  return `That was all ${days} days. Every one of them verified.`;
}

/** What the finish means for the money, which is the first thing asked about it. */
function finishedDepositText(challenge: ChallengeView): string {
  const { amount } = challenge.configuration.deposit;
  if (amount === 0) {
    return "You staked nothing, so the mornings are the whole of it.";
  }
  return `Your ${formatMoney(amount)} deposit stays yours. Nothing will be charged.`;
}

/** The colour each state is read in, so the news arrives before the sentence does. */
const STATUS_TONE: Readonly<
  Record<DailyCompletionState["status"], "default" | "warning" | "success" | "danger">
> = {
  incomplete: "default",
  syncPending: "warning",
  acknowledged: "success",
  rejected: "danger",
};

function deadlineWarningText(state: DailyCompletionState): string {
  if (state.deadlinePassed) {
    return "The deadline has passed and the server never acknowledged today's result.";
  }
  const minutes = state.minutesToDeadline ?? 0;
  return `${minutes} minutes left and the server has not acknowledged yet. Keep the app open.`;
}

const CHECK_MARK: Readonly<Record<CheckState, string>> = {
  waiting: "waiting",
  passed: "passed",
  failed: "failed",
};

/** The glyph in front of a check, so its state is legible without reading. */
const CHECK_GLYPH: Readonly<Record<CheckState, string>> = {
  waiting: "○",
  passed: "✓",
  failed: "✕",
};

const CHECK_TONE: Readonly<Record<CheckState, "muted" | "success" | "danger">> = {
  waiting: "muted",
  passed: "success",
  failed: "danger",
};

/**
 * The controls a simulated build steps with.
 *
 * The banner is unconditional and the buttons are not: a build like this must
 * announce itself even before a window is open, but steps can only be added to
 * a window that is open, and a button that did nothing would read as a bug.
 *
 * Two sizes rather than one. A small push is how the shortfall path is reached
 * - start, add a little, stop - and the exact remainder is how the day is
 * finished without counting presses.
 */
function SimulationPanel(props: {
  simulation: MovementSimulation;
  recording: boolean;
  remaining: number;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.simulation, { gap: theme.space.sm }]} testID="simulated-movement">
      <AppText variant="caption" tone="warning" testID="simulated-movement-banner">
        This build simulates movement. No step counter is being read.
      </AppText>
      {props.recording ? (
        <View style={[styles.row, { gap: theme.space.md }]}>
          <View style={styles.grow}>
            <TextButton
              testID="simulate-some-steps"
              label="+100 steps"
              tone="accent"
              onPress={() => props.simulation.addSteps(100)}
            />
          </View>
          <View style={styles.grow}>
            <TextButton
              testID="simulate-enough-steps"
              label={`+${props.remaining} to target`}
              tone="accent"
              onPress={() => props.simulation.addSteps(props.remaining)}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function CheckRow(props: { testID: string; label: string; check: CheckState }) {
  const theme = useTheme();
  const tone = CHECK_TONE[props.check];
  return (
    <View style={[styles.row, { gap: theme.space.md }]} testID={props.testID}>
      <AppText variant="body" tone={tone}>
        {CHECK_GLYPH[props.check]}
      </AppText>
      <AppText variant="small" style={styles.grow}>
        {props.label}
      </AppText>
      <AppText variant="caption" tone={tone} testID={`${props.testID}-state`}>
        {CHECK_MARK[props.check]}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { gap: 4 },
  row: { flexDirection: "row", alignItems: "center" },
  grow: { flexGrow: 1, flexShrink: 1 },
  simulation: { alignItems: "stretch" },
});
