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
 *
 * A third shape is drawn after either command: what the server says it did. The
 * screen used to close on the press and let home stand for the answer, which
 * left the morning a pause consumed unnamed and - the expensive half - said
 * nothing about the deadline a resume had just started counting.
 */

import type {
  ChallengeView,
  PauseChallengeResponse,
  ResumeChallengeResponse,
} from "@betterwakeup/contract";
import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
import type { ApiClient } from "../api/client.ts";
import {
  type CommandOutcome,
  pauseChallenge,
  resumeChallenge,
} from "../challenges/lifecycle-commands.ts";
import { skipWindowFor, skipWindowSentence } from "../challenges/no-regret.ts";
import {
  pausedForSentence,
  pausedRestSentence,
  pauseExpirySentence,
  pausePresentation,
} from "../challenges/pause.ts";
import { pauseResult, resumeResult } from "../challenges/pause-outcome.ts";
import { useClock } from "../ui/clock.ts";
import { AppText, Banner, Button, Card, Divider, Screen, StatusPill } from "../ui/components.tsx";
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
  // Read on a timer rather than once, because how long is left to skip this
  // morning is a sentence that stops being true while the screen is open.
  const clock = useClock(props.now);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Held rather than handed straight back: the answer names the morning a pause
  // consumed and the deadline a resume restarted, and neither survives a re-read
  // of the challenge.
  const [applied, setApplied] = useState<Applied | null>(null);

  const view = pausePresentation({ challenge, now: clock });
  const skippable = view.nextSkippedTask;
  const notice = skippable === null ? null : skipWindowFor(skippable.pauseCutoff, clock);
  const skipWindow =
    skippable === null || notice === null
      ? null
      : skipWindowSentence(notice, skippable.pauseCutoff, challenge.configuration.timeZone);

  const run = useCallback(
    async <Value,>(
      command: () => Promise<CommandOutcome<Value>>,
      applying: (value: Value) => Applied,
    ) => {
      setBusy(true);
      setProblem(null);
      try {
        const outcome = await command();
        if (outcome.status === "done") {
          setApplied(applying(outcome.value));
          return;
        }
        setProblem(outcome.status === "blocked" ? outcome.reasons.join(" ") : outcome.message);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const onPause = useCallback(
    () =>
      run(
        () => pauseChallenge({ api, challenge, confirmed: true }),
        (response) => ({ kind: "paused", response }),
      ),
    [api, challenge, run],
  );
  const onResume = useCallback(
    () =>
      run(
        () => resumeChallenge({ api, challenge }),
        (response) => ({ kind: "resumed", response }),
      ),
    [api, challenge, run],
  );

  // What the server did, before any branch that reads the challenge this screen
  // was given: that one still says paused after a resume, so every shape below
  // would draw the state the press has just left.
  if (applied !== null) {
    return (
      <AppliedScreen
        applied={applied}
        now={clock}
        onDone={() => props.onChanged?.(changed(applied))}
      />
    );
  }

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
            {/* When the chance to skip that task runs out. The screen otherwise
                names the morning and says nothing about the notice on it, so a
                user deciding tonight whether to skip tomorrow had no way to
                know the answer stops being available before they wake up. */}
            {skipWindow === null ? null : (
              <AppText
                variant="small"
                tone={notice?.closing === true ? "warning" : "muted"}
                testID="skip-window"
              >
                {skipWindow}
              </AppText>
            )}
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

/** Which command was applied, held with the answer it came back with. */
type Applied =
  | { readonly kind: "paused"; readonly response: PauseChallengeResponse }
  | { readonly kind: "resumed"; readonly response: ResumeChallengeResponse };

/** The challenge as it stands after the command, for the caller to re-read from. */
function changed(applied: Applied): ChallengeView {
  return applied.response.challenge;
}

/**
 * What just happened, drawn instead of a screen change.
 *
 * There is no back link: the one press leaves with the challenge the server
 * returned, so the caller cannot end up holding the state before the command.
 */
function AppliedScreen(props: {
  readonly applied: Applied;
  readonly now: Date;
  readonly onDone: () => void;
}) {
  const { applied } = props;

  if (applied.kind === "paused") {
    const result = pauseResult({
      challenge: applied.response.challenge,
      nextSkippedTask: applied.response.nextSkippedTask,
    });
    return (
      <Screen testID="pause-screen">
        <View style={styles.header}>
          <StatusPill label="Paused" tone="warning" />
          <AppText variant="display" accessibilityRole="header" testID="pause-status">
            Your challenge is paused
          </AppText>
        </View>

        <Card>
          <AppText variant="headline">What changed</AppText>
          <AppText variant="small" testID="paused-skipped">
            {result.skipped}
          </AppText>
          <AppText variant="small" testID="paused-ends">
            {result.ends}
          </AppText>
        </Card>

        <Banner tone="info" testID="paused-banner">
          <AppText variant="small">{result.rest}</AppText>
        </Banner>

        {result.expires === null ? null : (
          <AppText variant="small" tone="muted" testID="paused-expires">
            {result.expires}
          </AppText>
        )}

        <Button testID="pause-done" label="Back to home" onPress={props.onDone} />
      </Screen>
    );
  }

  const result = resumeResult({
    challenge: applied.response.challenge,
    nextLiveTask: applied.response.nextLiveTask,
    now: props.now,
  });
  // Anything but a morning comfortably ahead: a deadline inside the alarm's own
  // lead, or one the pause outlived, is the reason this banner exists.
  const urgent = result.countdown !== null && result.countdown.urgency !== "ample";
  return (
    <Screen testID="pause-screen">
      <View style={styles.header}>
        <StatusPill label="Running" tone="success" />
        <AppText variant="display" accessibilityRole="header" testID="pause-status">
          Your challenge is running
        </AppText>
      </View>

      {/* The deadline the press just started. A pause lifted on a Monday evening
          can hand back a morning that is hours away, and nothing else in the app
          gives the user a clock they did not ask for. */}
      <Banner tone={urgent ? "warning" : "info"} testID="resumed-live">
        <AppText variant="small" tone={urgent ? "warning" : "default"}>
          {result.live}
        </AppText>
        {result.countdown === null ? null : (
          <AppText
            variant="headline"
            tone={urgent ? "warning" : "default"}
            // Named by urgency as well as by role: a tone is not readable off a
            // rendered text node, so the state it stands for has to be.
            testID={urgent ? "resumed-countdown-closing" : "resumed-countdown"}
            accessibilityRole="alert"
          >
            {result.countdown.sentence}
          </AppText>
        )}
      </Banner>

      <Card>
        <AppText variant="headline">What changed</AppText>
        <AppText variant="small" testID="resumed-ends">
          {result.ends}
        </AppText>
        <AppText variant="small" testID="resumed-reminders">
          {result.reminders}
        </AppText>
      </Card>

      <Button testID="resume-done" label="Back to home" onPress={props.onDone} />
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
