/**
 * Pausing and resuming.
 *
 * Two shapes, and which one is drawn is decided by the server's pause state
 * alone. While the challenge runs, the screen names the task pausing would
 * skip before the confirmation opens. While it is paused, the first thing on
 * screen says the challenge is not running, no task is offered, and the
 * approach of the year is stated as an outcome rather than as a prompt.
 */

import type { ChallengeView } from "@betterwakeup/contract";
import { useCallback, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ApiClient } from "../api/client.ts";
import {
  type CommandOutcome,
  pauseChallenge,
  resumeChallenge,
} from "../challenges/lifecycle-commands.ts";
import { pauseExpirySentence, pausePresentation } from "../challenges/pause.ts";
import { ConfirmAction } from "./confirm-action.tsx";

export interface PauseScreenProps {
  readonly api: ApiClient;
  readonly challenge: ChallengeView;
  /** Injected in tests so the pause's age is not the clock of the machine. */
  readonly now?: () => Date;
  /** Called with the challenge the command returned, so the caller can re-read it. */
  readonly onChanged?: (challenge: ChallengeView) => void;
}

export function PauseScreen(props: PauseScreenProps) {
  const { api, challenge } = props;
  const insets = useSafeAreaInsets();
  const readClock = props.now ?? (() => new Date());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const view = pausePresentation({ challenge, now: readClock() });

  const run = useCallback(
    async (command: () => Promise<CommandOutcome<{ challenge: ChallengeView }>>) => {
      setBusy(true);
      setProblem(null);
      try {
        const outcome = await command();
        if (outcome.status === "done") {
          props.onChanged?.(outcome.value.challenge);
          return;
        }
        setProblem(outcome.status === "blocked" ? outcome.reasons.join(" ") : outcome.message);
      } finally {
        setBusy(false);
      }
    },
    [props.onChanged],
  );

  const onPause = useCallback(
    () => run(() => pauseChallenge({ api, challenge, confirmed: true })),
    [api, challenge, run],
  );
  const onResume = useCallback(
    () => run(() => resumeChallenge({ api, challenge })),
    [api, challenge, run],
  );

  return (
    <ScrollView
      testID="pause-screen"
      contentContainerStyle={[styles.container, { paddingTop: insets.top }]}
    >
      <Text style={styles.title} accessibilityRole="header" testID="pause-status">
        {view.running ? "Your challenge is running" : "Your challenge is paused"}
      </Text>

      {view.running ? (
        <>
          <Text style={styles.body}>
            Pausing skips every task from here until you resume. Nothing is charged and nothing is
            failed while it lasts.
          </Text>
          <Text style={styles.body} testID="next-skipped-task">
            {nextSkippedSentence(view.nextSkippedTask, view.cutoffPassed)}
          </Text>
          <ConfirmAction
            testID="pause"
            label="Pause the challenge"
            consequence={pauseConsequence(view.nextSkippedTask, view.cutoffPassed)}
            confirmLabel="Pause it"
            busy={busy}
            onConfirm={onPause}
          />
        </>
      ) : (
        <>
          <View style={styles.banner} testID="paused-banner">
            <Text style={styles.bannerText}>
              No task is due and nothing can be failed. Deadlines start again only when you resume.
            </Text>
          </View>
          <Text style={styles.note} testID="paused-days">
            {pausedDaysSentence(view.pausedDays)}
          </Text>
          {view.expiryWarning && view.daysUntilExpiry !== null ? (
            <Text style={styles.warning} testID="pause-expiry-warning" accessibilityRole="alert">
              {pauseExpirySentence(view.daysUntilExpiry)}
            </Text>
          ) : null}
          <ConfirmAction
            testID="resume"
            label="Resume the challenge"
            consequence="Your next scheduled task becomes live again and its deadline counts."
            confirmLabel="Resume it"
            busy={busy}
            onConfirm={onResume}
          />
        </>
      )}

      {problem === null ? null : (
        <Text style={styles.error} testID="pause-problem" accessibilityRole="alert">
          {problem}
        </Text>
      )}
    </ScrollView>
  );
}

function nextSkippedSentence(task: { date: string } | null, cutoffPassed: boolean): string {
  if (task !== null) {
    return `Pausing now skips your task on ${task.date} first.`;
  }
  if (cutoffPassed) {
    return "Your current task is already past the point where it can be skipped, so it stays live. The pause starts with the task after it.";
  }
  return "No task is scheduled yet, so pausing skips nothing today.";
}

function pauseConsequence(task: { date: string } | null, cutoffPassed: boolean): string {
  return `${nextSkippedSentence(task, cutoffPassed)} A skipped task does not count toward your required total, so your end date moves later. You can resume at any time.`;
}

function pausedDaysSentence(pausedDays: number | null): string {
  if (pausedDays === null || pausedDays <= 0) {
    return "Paused since today.";
  }
  return pausedDays === 1 ? "Paused for 1 day." : `Paused for ${pausedDays} days.`;
}

const styles = StyleSheet.create({
  container: { gap: 16, paddingHorizontal: 24, paddingBottom: 48 },
  title: { fontSize: 28, fontWeight: "600" },
  body: { fontSize: 15, lineHeight: 21 },
  note: { fontSize: 13, opacity: 0.6, lineHeight: 18 },
  banner: { backgroundColor: "#f1efe6", borderRadius: 12, padding: 16 },
  bannerText: { fontSize: 15, lineHeight: 21 },
  warning: { fontSize: 14, color: "#8a5300", lineHeight: 20 },
  error: { fontSize: 14, color: "#b00020", lineHeight: 20 },
});
