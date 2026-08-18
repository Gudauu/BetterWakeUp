/**
 * Home: the one screen a signed-in account lands on.
 *
 * It answers the only question that matters at launch - is a challenge running,
 * and what does it want from me today - and it is the door to everything else.
 * Creating a challenge is reached from here rather than being the landing
 * screen, because an account that already holds one has no business being shown
 * a form it is not allowed to submit.
 *
 * The screen owns no rules. It renders the state `useCurrentChallenge` derives
 * and reloads it whenever something it launched changed the answer.
 */

import type { ChallengeStatus, ChallengeView } from "@betterwakeup/contract";
import { type ReactNode, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCurrentChallenge } from "../challenges/current-challenge.ts";
import { formatMoney } from "../challenges/draft.ts";
import {
  type CompletionRuntimeFactory,
  type CompletionRuntimeState,
  createNativeCompletionRuntime,
  useCompletionRuntime,
} from "../completions/runtime.ts";
import { useSession } from "../session/session-context.tsx";
import { CreateChallengeScreen } from "./create-challenge-screen.tsx";
import { DailyCompletionScreen } from "./daily-completion-screen.tsx";
import { DeleteAccountScreen } from "./delete-account-screen.tsx";
import { PauseScreen } from "./pause-screen.tsx";
import { RecoveryScreen } from "./recovery-screen.tsx";

export interface HomeScreenProps {
  readonly onSignOut?: () => void;
  /**
   * How the store, sync and movement capture behind today's task are built.
   * Substituted in tests and by a development build, so that reaching the task
   * screen does not require a device with a step counter.
   */
  readonly createRuntime?: CompletionRuntimeFactory;
}

/**
 * Where the user is. Home is a stack one screen deep: everything it opens
 * returns here, and nothing opens anything else, so one name is the whole of
 * the navigation state. A router arrives when a screen needs to open a third.
 */
type Route = "home" | "create" | "task" | "pause" | "recovery" | "delete";

/**
 * The headline states, worded as the user's situation rather than as the
 * status enum. A paused challenge is drawn from `pause` instead, because
 * "active" is true of it and would be the wrong thing to read.
 */
const STATUS_HEADLINE: Readonly<Record<ChallengeStatus, string>> = {
  active: "Challenge running",
  succeeded: "You finished it",
  failed: "This challenge ended short",
  expired: "This challenge expired while paused",
  recovery_pending: "One missed day is waiting on you",
};

export function HomeScreen({ onSignOut, createRuntime }: HomeScreenProps) {
  const { api, signOut } = useSession();
  const insets = useSafeAreaInsets();
  const { state, reload } = useCurrentChallenge(api);
  const [route, setRoute] = useState<Route>("home");
  // The way back from everything home opens. A command that changed the
  // challenge reads it again from here rather than while its screen is still
  // up: `reload` puts home into its loading state, which would pull that screen
  // out from under the user mid-use.
  const goHome = (changed: boolean) => {
    setRoute("home");
    if (changed) {
      reload();
    }
  };
  // Held for as long as home is on screen rather than only while the task is
  // open: opening it is what sends a completion recorded on a day with no
  // network, and that must not wait for the user to tap anything.
  const runtime = useCompletionRuntime(api, createRuntime ?? createNativeCompletionRuntime);

  if (route === "create") {
    return (
      <CreateChallengeScreen
        onCancel={() => goHome(false)}
        // The server is the record of what exists, so the new challenge is read
        // back rather than trusted from the response the form held.
        onCreated={() => goHome(true)}
      />
    );
  }

  if (state.status === "loading") {
    return (
      <View style={styles.centered} testID="home-loading">
        <ActivityIndicator accessibilityLabel="Loading your challenge" />
      </View>
    );
  }

  if (state.status === "failed") {
    return (
      <View style={[styles.centered, { paddingTop: insets.top }]} testID="home-error">
        <Text style={styles.title}>BetterWakeUp</Text>
        <Text style={styles.error} accessibilityRole="alert" testID="home-error-message">
          {state.message}
        </Text>
        <Action testID="home-retry" label="Try again" onPress={reload} />
        <SignOut onSignOut={onSignOut} />
      </View>
    );
  }

  if (route === "delete") {
    return (
      <DeleteAccountScreen
        api={api}
        challenge={state.challenge}
        onBack={() => goHome(false)}
        // Nothing is left to read: the account this screen was reading is gone,
        // so the only honest next screen is the signed-out one.
        onDeleted={() => void signOut()}
      />
    );
  }

  if (state.challenge !== null) {
    if (route === "task") {
      return (
        <TodayTask challenge={state.challenge} runtime={runtime} onBack={() => goHome(true)} />
      );
    }
    if (route === "pause") {
      return (
        <PauseScreen
          api={api}
          challenge={state.challenge}
          onBack={() => goHome(false)}
          onChanged={() => goHome(true)}
        />
      );
    }
    if (route === "recovery") {
      return (
        <RecoveryScreen
          api={api}
          challenge={state.challenge}
          onBack={() => goHome(false)}
          onAccepted={() => goHome(true)}
          // Declining spends nothing and changes nothing at the server, so
          // there is nothing to read back.
          onDeclined={() => goHome(false)}
        />
      );
    }
  }

  return (
    <ScrollView
      testID="home"
      contentContainerStyle={[styles.container, { paddingTop: insets.top }]}
    >
      <Text style={styles.title}>BetterWakeUp</Text>

      {state.challenge === null ? (
        <View style={styles.card} testID="home-no-challenge">
          <Text style={styles.headline}>No challenge running</Text>
          <Text style={styles.body}>
            Set a wake-up time, walk when the alarm goes, and keep your deposit.
          </Text>
          <Action
            testID="home-create-challenge"
            label="Start a challenge"
            onPress={() => setRoute("create")}
          />
        </View>
      ) : (
        <ChallengeCard
          challenge={state.challenge}
          onOpenTask={() => setRoute("task")}
          onOpenPause={() => setRoute("pause")}
          onOpenRecovery={() => setRoute("recovery")}
        />
      )}

      <Pressable accessibilityRole="button" testID="home-refresh" onPress={reload}>
        <Text style={styles.secondaryLabel}>Refresh</Text>
      </Pressable>

      <SignOut onSignOut={onSignOut} />

      {/* Deletion is account-level rather than challenge-level, so it sits
          outside the card and stays reachable for an account holding none. */}
      <Pressable
        accessibilityRole="button"
        testID="home-delete-account"
        onPress={() => setRoute("delete")}
      >
        <Text style={styles.dangerLabel}>Delete account</Text>
      </Pressable>
    </ScrollView>
  );
}

function ChallengeCard({
  challenge,
  onOpenTask,
  onOpenPause,
  onOpenRecovery,
}: {
  challenge: ChallengeView;
  onOpenTask: () => void;
  onOpenPause: () => void;
  onOpenRecovery: () => void;
}) {
  const paused = challenge.pause.pausedAt !== null;
  const { progress, configuration, currentTask } = challenge;
  const remaining = Math.max(
    0,
    progress.requiredTaskCount -
      progress.completedTaskCount -
      progress.skippedTaskCount -
      progress.forgivenTaskCount,
  );

  return (
    <View style={styles.card} testID="home-challenge">
      <Text style={styles.headline} testID="home-challenge-status">
        {paused ? "Paused" : STATUS_HEADLINE[challenge.status]}
      </Text>

      <Text style={styles.body} testID="home-progress">
        {progress.completedTaskCount} of {progress.requiredTaskCount} days done, {remaining} to go.
      </Text>
      <ProgressBar done={progress.completedTaskCount} total={progress.requiredTaskCount} />

      <Detail label="Projected end" value={challenge.projectedEndDate} testID="home-end-date" />
      <Detail
        label="Deposit"
        value={
          configuration.deposit.amount === 0 ? "None" : formatMoney(configuration.deposit.amount)
        }
        testID="home-deposit"
      />
      <Detail label="Steps per day" value={String(configuration.stepTarget)} testID="home-steps" />

      {currentTask === null ? (
        <Text style={styles.note} testID="home-no-task">
          {paused
            ? "Nothing is due while this challenge is paused."
            : "Nothing is due right now. The next task appears on your next active day."}
        </Text>
      ) : (
        <View style={styles.taskRow} testID="home-current-task">
          <Text style={styles.body}>Next task {currentTask.date}</Text>
          <Text style={styles.note} testID="home-task-deadline">
            Deadline {formatDeadline(currentTask.deadline, configuration.timeZone)}
          </Text>
          <Action testID="home-open-task" label="Open today's task" onPress={onOpenTask} />
        </View>
      )}

      {challenge.depositSecured ? null : (
        <Text style={styles.warning} testID="home-deposit-unsecured" accessibilityRole="alert">
          Your card no longer secures this deposit. Add a new one to keep the challenge honest.
        </Text>
      )}

      {challenge.recoveryOffer === null ? null : (
        <View style={styles.taskRow} testID="home-recovery-offer">
          <Text style={styles.warning} accessibilityRole="alert">
            You missed a day. Your one Emergency Recovery can forgive it until{" "}
            {formatDeadline(challenge.recoveryOffer.expiresAt, configuration.timeZone)}.
          </Text>
          <Action
            testID="home-open-recovery"
            label="Decide on your recovery"
            onPress={onOpenRecovery}
          />
        </View>
      )}

      {/* Pausing belongs to a challenge that can still run. A finished one has
          nothing to pause, and offering it would be a press the server refuses. */}
      {challenge.status === "active" ? (
        <Pressable accessibilityRole="button" testID="home-open-pause" onPress={onOpenPause}>
          <Text style={styles.secondaryLabel}>
            {paused ? "Resume the challenge" : "Pause the challenge"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Today's task, once the pieces it needs exist.
 *
 * The runtime is asynchronous - a database has to open - so this stands in for
 * the task screen until it is ready, and says so rather than showing a screen
 * whose buttons could not record anything.
 */
function TodayTask({
  challenge,
  runtime,
  onBack,
}: {
  challenge: ChallengeView;
  runtime: CompletionRuntimeState;
  onBack: () => void;
}) {
  if (runtime.status === "loading") {
    return (
      <View style={styles.centered} testID="home-task-loading">
        <ActivityIndicator accessibilityLabel="Opening today's task" />
        <Pressable accessibilityRole="button" testID="home-task-back" onPress={onBack}>
          <Text style={styles.secondaryLabel}>Back to home</Text>
        </Pressable>
      </View>
    );
  }

  if (runtime.status === "failed") {
    return (
      <View style={styles.centered} testID="home-task-unavailable">
        <Text style={styles.error} accessibilityRole="alert">
          {runtime.message}
        </Text>
        <Pressable accessibilityRole="button" testID="home-task-back" onPress={onBack}>
          <Text style={styles.secondaryLabel}>Back to home</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <DailyCompletionScreen
      challenge={challenge}
      capture={runtime.runtime.capture}
      sync={runtime.runtime.sync}
      store={runtime.runtime.store}
      appVersion={runtime.runtime.appVersion}
      onBack={onBack}
    />
  );
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  const fraction = total === 0 ? 0 : Math.min(1, done / total);
  return (
    <View
      style={styles.track}
      testID="home-progress-bar"
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: total, now: done }}
    >
      <View style={[styles.fill, { flex: fraction }]} />
      <View style={{ flex: 1 - fraction }} />
    </View>
  );
}

function Detail(props: { label: string; value: string; testID: string }) {
  return (
    <View style={styles.row} testID={props.testID}>
      <Text style={styles.label}>{props.label}</Text>
      <Text style={styles.value}>{props.value}</Text>
    </View>
  );
}

function Action(props: { testID: string; label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      testID={props.testID}
      style={styles.button}
      onPress={props.onPress}
    >
      <Text style={styles.buttonLabel}>{props.label}</Text>
    </Pressable>
  );
}

function SignOut({ onSignOut }: { onSignOut: (() => void) | undefined }): ReactNode {
  if (onSignOut === undefined) {
    return null;
  }
  return (
    <Pressable accessibilityRole="button" testID="home-sign-out" onPress={onSignOut}>
      <Text style={styles.secondaryLabel}>Sign out</Text>
    </Pressable>
  );
}

/**
 * A deadline read in the challenge's own time zone, which is the only zone it
 * means anything in. A build whose runtime cannot do zoned formatting falls
 * back to the instant rather than showing a time in the wrong zone.
 */
function formatDeadline(instant: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(instant));
  } catch {
    return new Date(instant).toISOString();
  }
}

const styles = StyleSheet.create({
  container: { gap: 20, paddingHorizontal: 24, paddingBottom: 48 },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    paddingHorizontal: 24,
  },
  title: { fontSize: 28, fontWeight: "600" },
  headline: { fontSize: 20, fontWeight: "600" },
  card: {
    borderColor: "#e2e2e2",
    borderRadius: 16,
    borderWidth: 1,
    gap: 12,
    padding: 20,
  },
  body: { fontSize: 15, lineHeight: 21, flexShrink: 1 },
  label: { fontSize: 15, flexShrink: 1, opacity: 0.7 },
  value: { fontSize: 15, fontWeight: "500" },
  note: { fontSize: 13, opacity: 0.6, lineHeight: 18 },
  warning: { fontSize: 14, color: "#8a5300", lineHeight: 20 },
  error: { fontSize: 14, color: "#b00020", textAlign: "center", lineHeight: 20 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  taskRow: { gap: 10 },
  track: {
    backgroundColor: "#ededed",
    borderRadius: 999,
    flexDirection: "row",
    height: 8,
    overflow: "hidden",
  },
  fill: { backgroundColor: "#111111" },
  button: {
    alignItems: "center",
    backgroundColor: "#111111",
    borderRadius: 12,
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  buttonLabel: { color: "#ffffff", fontSize: 16, fontWeight: "600" },
  secondaryLabel: { fontSize: 15, opacity: 0.7, textAlign: "center" },
  dangerLabel: { fontSize: 15, color: "#b00020", textAlign: "center", opacity: 0.8 },
});
