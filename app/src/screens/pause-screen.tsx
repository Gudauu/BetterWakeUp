/**
 * Pausing and resuming.
 *
 * Two shapes, and which one is drawn is decided by the server's pause state
 * alone. While the challenge runs, the screen names the task pausing would
 * skip before the confirmation opens. While it is paused, the first thing on
 * screen says the challenge is not running, no task is offered, and the
 * approach of the year is stated as an outcome rather than as a prompt.
 *
 * Both shapes lead with a status pill, because "running" and "paused" are the
 * one fact the user came here to check and a heading alone is easy to skim
 * past. What pausing costs is spelled out as a short list of promises rather
 * than a paragraph, so a half-awake reader can find the one that worries them.
 */

import type { ChallengeView } from "@betterwakeup/contract";
import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
import type { ApiClient } from "../api/client.ts";
import {
  type CommandOutcome,
  pauseChallenge,
  resumeChallenge,
} from "../challenges/lifecycle-commands.ts";
import {
  pausedForSentence,
  pausedRestSentence,
  pauseExpirySentence,
  pausePresentation,
} from "../challenges/pause.ts";
import { AppText, Banner, Card, Divider, Screen, StatusPill } from "../ui/components.tsx";
import { formatDay } from "../ui/format.ts";
import { BackLink } from "./back-link.tsx";
import { ConfirmAction } from "./confirm-action.tsx";

export interface PauseScreenProps {
  readonly api: ApiClient;
  readonly challenge: ChallengeView;
  /** Injected in tests so the pause's age is not the clock of the machine. */
  readonly now?: () => Date;
  /** Called with the challenge the command returned, so the caller can re-read it. */
  readonly onChanged?: (challenge: ChallengeView) => void;
  /** Offered as a way back when a caller put this screen on top of another. */
  readonly onBack?: () => void;
}

/** What a pause does and does not do, in the order a worried user asks it. */
const PAUSE_PROMISES: readonly string[] = [
  "No task is due and no deadline counts.",
  "Nothing is charged and no day can be failed.",
  "Your Emergency Recovery stays untouched.",
  "You can resume at any time.",
];

export function PauseScreen(props: PauseScreenProps) {
  const { api, challenge } = props;
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
    <Screen testID="pause-screen">
      <BackLink testID="pause-back" onBack={props.onBack} />

      <View style={styles.header}>
        <StatusPill
          label={view.running ? "Running" : "Paused"}
          tone={view.running ? "success" : "warning"}
        />
        <AppText variant="display" accessibilityRole="header" testID="pause-status">
          {view.running ? "Your challenge is running" : "Your challenge is paused"}
        </AppText>
      </View>

      {view.running ? (
        <>
          <Card>
            <AppText variant="headline">What pausing does</AppText>
            {PAUSE_PROMISES.map((promise) => (
              <View key={promise} style={styles.promise}>
                <AppText variant="small" tone="muted">
                  •
                </AppText>
                <AppText variant="small" style={styles.shrink}>
                  {promise}
                </AppText>
              </View>
            ))}
            <Divider />
            <AppText variant="small" tone="muted" testID="next-skipped-task">
              {nextSkippedSentence(view.nextSkippedTask, view.cutoffPassed)}
            </AppText>
          </Card>
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
          {/* The same sentence home leads with, for the same reason: a task
              whose cutoff had passed when the pause was set stays live, so a
              flat promise that no task is due would be wrong about the one day
              that can still be lost. */}
          <Banner tone="info" testID="paused-banner">
            <AppText variant="small">{pausedRestSentence(challenge.currentTask !== null)}</AppText>
          </Banner>
          <Card>
            <AppText variant="title" testID="paused-days">
              {pausedForSentence(view.pausedDays)}
            </AppText>
            <AppText variant="small" tone="muted">
              Every day you spend paused is a day your end date moves later, and nothing else.
            </AppText>
          </Card>
          {view.expiryWarning && view.daysUntilExpiry !== null ? (
            <Banner tone="warning">
              <AppText
                variant="small"
                tone="warning"
                testID="pause-expiry-warning"
                accessibilityRole="alert"
              >
                {pauseExpirySentence(view.daysUntilExpiry)}
              </AppText>
            </Banner>
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
        <Banner tone="danger">
          <AppText variant="small" tone="danger" testID="pause-problem" accessibilityRole="alert">
            {problem}
          </AppText>
        </Banner>
      )}
    </Screen>
  );
}

function nextSkippedSentence(task: { date: string } | null, cutoffPassed: boolean): string {
  if (task !== null) {
    return `Pausing now skips your task on ${formatDay(task.date)} first.`;
  }
  if (cutoffPassed) {
    return "Your current task is already past the point where it can be skipped, so it stays live. The pause starts with the task after it.";
  }
  return "No task is scheduled yet, so pausing skips nothing today.";
}

function pauseConsequence(task: { date: string } | null, cutoffPassed: boolean): string {
  return `${nextSkippedSentence(task, cutoffPassed)} A skipped task does not count toward your required total, so your end date moves later. You can resume at any time.`;
}

const styles = StyleSheet.create({
  header: { gap: 8 },
  promise: { flexDirection: "row", gap: 8 },
  shrink: { flexShrink: 1 },
});
