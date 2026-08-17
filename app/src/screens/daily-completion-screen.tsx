/**
 * Today's task.
 *
 * The screen's whole job is to be honest about two separate facts. The local
 * check says the device counted enough steps and wrote the result down; the
 * server check says the server acknowledged that result. Only the second one
 * makes the day count, so the two are drawn as two rows and the day is called
 * complete only when `dailyCompletionState` says the server acknowledged it.
 *
 * The screen owns no rules. It renders the state that module derives, and it
 * asks the movement capture and the completion sync to do the work.
 */

import type { ChallengeView } from "@betterwakeup/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  type CheckState,
  type DailyCompletionState,
  dailyCompletionState,
} from "../completions/daily-state.ts";
import { VERIFICATION_POLICY_VERSION } from "../completions/policy.ts";
import type { PendingCompletionRecord, PendingCompletionStore } from "../completions/store.ts";
import type { CompletionSync } from "../completions/sync.ts";
import type { CaptureState, MovementCapture } from "../movement/capture.ts";

export interface DailyCompletionScreenProps {
  readonly challenge: ChallengeView;
  readonly capture: MovementCapture;
  readonly sync: CompletionSync;
  readonly store: PendingCompletionStore;
  readonly appVersion: string;
  /** Injected in tests so the deadline warning is not the clock of the machine. */
  readonly now?: () => Date;
  /** Called when the server acknowledges, so the caller can re-read the challenge. */
  readonly onAcknowledged?: () => void;
}

/** How often the screen re-reads the clock, for the deadline warning. */
const CLOCK_INTERVAL_MS = 30_000;

export function DailyCompletionScreen(props: DailyCompletionScreenProps) {
  const { challenge, capture, sync, store, appVersion } = props;
  const insets = useSafeAreaInsets();
  const readClock = props.now ?? (() => new Date());

  const [records, setRecords] = useState<readonly PendingCompletionRecord[]>([]);
  const [captureState, setCaptureState] = useState<CaptureState>(() => capture.getState());
  const [shortfall, setShortfall] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // The clock is state rather than a read at render time, so the deadline
  // warning appears while the screen sits open rather than on the next touch.
  const [clock, setClock] = useState<Date>(readClock);
  const clockRef = useRef(readClock);
  clockRef.current = readClock;

  const task = challenge.currentTask;

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
        props.onAcknowledged?.();
      }
    });
  }, [reload, sync, props.onAcknowledged]);

  useEffect(() => capture.subscribe(setCaptureState), [capture]);

  useEffect(() => {
    const timer = setInterval(() => setClock(clockRef.current()), CLOCK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const state = dailyCompletionState({ task, records, now: clock });

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
      if (observation.steps < challenge.configuration.stepTarget) {
        // Nothing is written down: a window that missed the target is not a
        // completion, and storing one would make the local check a lie.
        setShortfall(challenge.configuration.stepTarget - observation.steps);
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
  }, [appVersion, capture, challenge, reload, sync, task]);

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
      <View style={[styles.container, { paddingTop: insets.top }]} testID="no-task-today">
        <Text style={styles.title}>Nothing due</Text>
        <Text style={styles.body}>There is no open task right now.</Text>
      </View>
    );
  }

  return (
    <ScrollView
      testID="daily-completion"
      contentContainerStyle={[styles.container, { paddingTop: insets.top }]}
    >
      <Text style={styles.title}>{task.date}</Text>
      <Text style={styles.note} testID="deadline">
        Deadline {new Date(task.deadline).toISOString()}
      </Text>

      <Text style={styles.progression} testID="progression" accessibilityRole="header">
        {PROGRESSION_HEADLINE[state.status]}
      </Text>

      <View style={styles.section}>
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
      </View>

      {state.deadlineWarning ? (
        <Text style={styles.warning} testID="deadline-warning" accessibilityRole="alert">
          {deadlineWarningText(state)}
        </Text>
      ) : null}

      {state.status === "rejected" && state.rejectedRecord !== null ? (
        <Text style={styles.error} testID="rejected-detail" accessibilityRole="alert">
          {state.rejectedRecord.lastErrorMessage ?? "The server refused this completion."}
        </Text>
      ) : null}

      {shortfall === null ? null : (
        <Text style={styles.note} testID="shortfall">
          {shortfall} more steps needed before this counts.
        </Text>
      )}

      {captureState.status === "recording" ? (
        <>
          <Text style={styles.body} testID="capture-steps">
            {captureState.steps} steps so far, target {challenge.configuration.stepTarget}.
          </Text>
          <Action testID="stop-capture" label="Stop and check" busy={busy} onPress={onStop} />
        </>
      ) : null}

      {state.status === "incomplete" && captureState.status !== "recording" ? (
        <Action testID="start-capture" label="Start moving" busy={busy} onPress={onStart} />
      ) : null}

      {state.status === "syncPending" ? (
        <Action testID="retry-sync" label="Try to send it again" busy={busy} onPress={onRetry} />
      ) : null}

      {captureState.status === "permission-denied" ? (
        <Text style={styles.error} testID="motion-denied" accessibilityRole="alert">
          Motion access is off, so nothing can be counted. Turn it on in Settings.
        </Text>
      ) : null}

      {captureState.status === "unsupported" ? (
        <Text style={styles.error} testID="motion-unsupported" accessibilityRole="alert">
          This device has no step counter.
        </Text>
      ) : null}
    </ScrollView>
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

function CheckRow(props: { testID: string; label: string; check: CheckState }) {
  return (
    <View style={styles.row} testID={props.testID}>
      <Text style={styles.label}>{props.label}</Text>
      <Text
        style={props.check === "failed" ? styles.error : styles.label}
        testID={`${props.testID}-state`}
      >
        {CHECK_MARK[props.check]}
      </Text>
    </View>
  );
}

function Action(props: {
  testID: string;
  label: string;
  busy: boolean;
  onPress: () => Promise<void>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.busy, busy: props.busy }}
      testID={props.testID}
      disabled={props.busy}
      style={[styles.button, props.busy && styles.buttonDisabled]}
      onPress={() => void props.onPress()}
    >
      <Text style={styles.buttonLabel}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { gap: 16, paddingHorizontal: 24, paddingBottom: 48 },
  section: { gap: 10 },
  title: { fontSize: 28, fontWeight: "600" },
  progression: { fontSize: 18, fontWeight: "600" },
  body: { fontSize: 15, lineHeight: 21, flexShrink: 1 },
  label: { fontSize: 15, flexShrink: 1 },
  note: { fontSize: 13, opacity: 0.6, lineHeight: 18 },
  warning: { fontSize: 14, color: "#8a5300", lineHeight: 20 },
  error: { fontSize: 14, color: "#b00020", lineHeight: 20 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  button: {
    alignItems: "center",
    backgroundColor: "#111111",
    borderRadius: 12,
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  buttonDisabled: { opacity: 0.4 },
  buttonLabel: { color: "#ffffff", fontSize: 16, fontWeight: "600" },
});
