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
import { useSession } from "../session/session-context.tsx";
import { CreateChallengeScreen } from "./create-challenge-screen.tsx";

export interface HomeScreenProps {
  readonly onSignOut?: () => void;
}

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

export function HomeScreen({ onSignOut }: HomeScreenProps) {
  const { api } = useSession();
  const insets = useSafeAreaInsets();
  const { state, reload } = useCurrentChallenge(api);
  const [creating, setCreating] = useState(false);

  if (creating) {
    return (
      <CreateChallengeScreen
        onCancel={() => setCreating(false)}
        onCreated={() => {
          // The server is the record of what exists, so the new challenge is
          // read back rather than trusted from the response the form held.
          setCreating(false);
          reload();
        }}
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
            onPress={() => setCreating(true)}
          />
        </View>
      ) : (
        <ChallengeCard challenge={state.challenge} />
      )}

      <Pressable accessibilityRole="button" testID="home-refresh" onPress={reload}>
        <Text style={styles.secondaryLabel}>Refresh</Text>
      </Pressable>

      <SignOut onSignOut={onSignOut} />
    </ScrollView>
  );
}

function ChallengeCard({ challenge }: { challenge: ChallengeView }) {
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
        </View>
      )}

      {challenge.depositSecured ? null : (
        <Text style={styles.warning} testID="home-deposit-unsecured" accessibilityRole="alert">
          Your card no longer secures this deposit. Add a new one to keep the challenge honest.
        </Text>
      )}

      {challenge.recoveryOffer === null ? null : (
        <Text style={styles.warning} testID="home-recovery-offer" accessibilityRole="alert">
          You missed a day. Your one Emergency Recovery can forgive it until{" "}
          {formatDeadline(challenge.recoveryOffer.expiresAt, configuration.timeZone)}.
        </Text>
      )}
    </View>
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
  taskRow: { gap: 4 },
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
});
