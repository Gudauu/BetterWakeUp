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
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useCurrentChallenge } from "../challenges/current-challenge.ts";
import { formatMoney } from "../challenges/draft.ts";
import {
  type CompletionRuntimeFactory,
  type CompletionRuntimeState,
  createConfiguredCompletionRuntime,
  useCompletionRuntime,
} from "../completions/runtime.ts";
import { useSession } from "../session/session-context.tsx";
import {
  AppText,
  Banner,
  Button,
  Card,
  DetailRow,
  Divider,
  ProgressBar,
  Screen,
  StatusPill,
  TextButton,
} from "../ui/components.tsx";
import { formatDay, formatDeadline } from "../ui/format.ts";
import { useTheme } from "../ui/theme.ts";
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

/**
 * The colour each status is read in. A finished challenge is good news and a
 * failed one is not, and the headline alone leaves that to the reader.
 */
const STATUS_TONE: Readonly<Record<ChallengeStatus, "accent" | "success" | "danger" | "warning">> =
  {
    active: "accent",
    succeeded: "success",
    failed: "danger",
    expired: "danger",
    recovery_pending: "warning",
  };

export function HomeScreen({ onSignOut, createRuntime }: HomeScreenProps) {
  const { api, signOut } = useSession();
  const theme = useTheme();
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
  const runtime = useCompletionRuntime(api, createRuntime ?? createConfiguredCompletionRuntime);

  if (route === "create") {
    return (
      <CreateChallengeScreen
        // Leaving the form changes nothing, but leaving an authorized hold
        // might: the challenge appears when the provider confirms it, which can
        // land after the user has stopped watching for it.
        onCancel={(accountChanged) => goHome(accountChanged)}
        // The server is the record of what exists, so the new challenge is read
        // back rather than trusted from the response the form held.
        onCreated={() => goHome(true)}
      />
    );
  }

  if (state.status === "loading") {
    return (
      <Screen centered testID="home-loading">
        <ActivityIndicator
          accessibilityLabel="Loading your challenge"
          color={theme.colors.accent}
        />
      </Screen>
    );
  }

  if (state.status === "failed") {
    return (
      <Screen centered testID="home-error">
        <AppText variant="title" accessibilityRole="header">
          BetterWakeUp
        </AppText>
        <Banner tone="danger">
          <AppText
            variant="small"
            tone="danger"
            accessibilityRole="alert"
            testID="home-error-message"
          >
            {state.message}
          </AppText>
        </Banner>
        <Button testID="home-retry" label="Try again" onPress={reload} style={styles.wide} />
        <SignOut onSignOut={onSignOut} />
      </Screen>
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
    <Screen testID="home">
      <View style={styles.header}>
        <AppText variant="caption" tone="accent">
          {state.challenge === null ? "READY WHEN YOU ARE" : "TODAY"}
        </AppText>
        <AppText variant="display" accessibilityRole="header">
          BetterWakeUp
        </AppText>
      </View>

      {state.challenge === null ? (
        <Card testID="home-no-challenge">
          <AppText variant="headline">No challenge running</AppText>
          <AppText variant="small" tone="muted">
            Set a wake-up time, walk when the alarm goes, and keep your deposit.
          </AppText>
          <Button
            testID="home-create-challenge"
            label="Start a challenge"
            onPress={() => setRoute("create")}
          />
        </Card>
      ) : (
        <ChallengeCard
          challenge={state.challenge}
          onOpenTask={() => setRoute("task")}
          onOpenPause={() => setRoute("pause")}
          onOpenRecovery={() => setRoute("recovery")}
        />
      )}

      {/* The account-level controls sit under a divider, away from the card:
          they are always available and never the thing to do next. Deletion is
          account-level rather than challenge-level, so it stays reachable for
          an account holding none. */}
      <View style={styles.footer}>
        <Divider />
        <TextButton testID="home-refresh" label="Refresh" onPress={reload} />
        <SignOut onSignOut={onSignOut} />
        <TextButton
          testID="home-delete-account"
          label="Delete account"
          tone="danger"
          onPress={() => setRoute("delete")}
        />
      </View>
    </Screen>
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
    <View style={styles.stack}>
      {/* Today's task is the reason the screen exists, so it is its own card
          above the challenge's numbers rather than a row buried inside them. */}
      {currentTask === null ? null : (
        <Card testID="home-current-task" style={styles.taskCard}>
          <AppText variant="caption" tone="accent">
            YOUR NEXT WALK
          </AppText>
          <AppText variant="title">{formatDay(currentTask.date)}</AppText>
          <AppText variant="small" tone="muted" testID="home-task-deadline">
            Deadline {formatDeadline(currentTask.deadline, configuration.timeZone)}
          </AppText>
          <AppText variant="small" tone="muted">
            {configuration.stepTarget} steps to keep the day.
          </AppText>
          <Button testID="home-open-task" label="Open today's task" onPress={onOpenTask} />
        </Card>
      )}

      {challenge.recoveryOffer === null ? null : (
        <Banner tone="warning" testID="home-recovery-offer">
          <AppText variant="small" tone="warning" accessibilityRole="alert">
            You missed a day. Your one Emergency Recovery can forgive it until{" "}
            {formatDeadline(challenge.recoveryOffer.expiresAt, configuration.timeZone)}.
          </AppText>
          <Button
            testID="home-open-recovery"
            label="Decide on your recovery"
            onPress={onOpenRecovery}
          />
        </Banner>
      )}

      {challenge.depositSecured ? null : (
        <Banner tone="danger">
          <AppText
            variant="small"
            tone="danger"
            testID="home-deposit-unsecured"
            accessibilityRole="alert"
          >
            Your card no longer secures this deposit. Add a new one to keep the challenge honest.
          </AppText>
        </Banner>
      )}

      <Card testID="home-challenge">
        <View style={styles.statusRow}>
          <StatusPill
            testID="home-challenge-status"
            label={paused ? "Paused" : STATUS_HEADLINE[challenge.status]}
            tone={paused ? "warning" : STATUS_TONE[challenge.status]}
          />
        </View>

        <View style={styles.progressBlock}>
          <AppText variant="display" testID="home-progress-count">
            {progress.completedTaskCount}
            <AppText variant="headline" tone="muted">
              {" "}
              / {progress.requiredTaskCount} days
            </AppText>
          </AppText>
          <ProgressBar
            done={progress.completedTaskCount}
            total={progress.requiredTaskCount}
            testID="home-progress-bar"
          />
          <AppText variant="small" tone="muted" testID="home-progress">
            {progress.completedTaskCount} of {progress.requiredTaskCount} days done, {remaining} to
            go.
          </AppText>
        </View>

        {currentTask === null ? (
          <AppText variant="caption" tone="muted" testID="home-no-task">
            {paused
              ? "Nothing is due while this challenge is paused."
              : "Nothing is due right now. The next task appears on your next active day."}
          </AppText>
        ) : null}

        <Divider />

        <DetailRow
          label="Projected end"
          value={formatDay(challenge.projectedEndDate)}
          testID="home-end-date"
        />
        <DetailRow
          label="Deposit"
          value={
            configuration.deposit.amount === 0 ? "None" : formatMoney(configuration.deposit.amount)
          }
          testID="home-deposit"
        />
        <DetailRow
          label="Steps per day"
          value={String(configuration.stepTarget)}
          testID="home-steps"
        />

        {/* Pausing belongs to a challenge that can still run. A finished one has
            nothing to pause, and offering it would be a press the server refuses. */}
        {challenge.status === "active" ? (
          <TextButton
            testID="home-open-pause"
            tone="accent"
            label={paused ? "Resume the challenge" : "Pause the challenge"}
            onPress={onOpenPause}
          />
        ) : null}
      </Card>
    </View>
  );
}

/** The challenge's state, said once, in the colour that state deserves. */
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
      <Screen centered testID="home-task-loading">
        <TaskSpinner />
        <TextButton testID="home-task-back" label="Back to home" onPress={onBack} />
      </Screen>
    );
  }

  if (runtime.status === "failed") {
    return (
      <Screen centered testID="home-task-unavailable">
        <Banner tone="danger">
          <AppText variant="small" tone="danger" accessibilityRole="alert">
            {runtime.message}
          </AppText>
        </Banner>
        <TextButton testID="home-task-back" label="Back to home" onPress={onBack} />
      </Screen>
    );
  }

  return (
    <DailyCompletionScreen
      challenge={challenge}
      capture={runtime.runtime.capture}
      sync={runtime.runtime.sync}
      store={runtime.runtime.store}
      appVersion={runtime.runtime.appVersion}
      simulation={runtime.runtime.simulation}
      onBack={onBack}
    />
  );
}

function TaskSpinner() {
  const theme = useTheme();
  return (
    <ActivityIndicator accessibilityLabel="Opening today's task" color={theme.colors.accent} />
  );
}

function SignOut({ onSignOut }: { onSignOut: (() => void) | undefined }): ReactNode {
  if (onSignOut === undefined) {
    return null;
  }
  return <TextButton testID="home-sign-out" label="Sign out" onPress={onSignOut} />;
}

const styles = StyleSheet.create({
  header: { gap: 4 },
  stack: { gap: 16 },
  footer: { gap: 4, paddingTop: 8 },
  wide: { alignSelf: "stretch" },
  taskCard: { gap: 8 },
  statusRow: { flexDirection: "row" },
  progressBlock: { gap: 10 },
});
