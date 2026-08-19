/**
 * "You have moved. Should your deadlines move with you?"
 *
 * The screen exists because a challenge's wall-clock promise is only true in
 * one zone, and the user can walk out of it. What it has to make plain is the
 * concrete thing that is wrong - the alarm the user set for 7:00 AM is being
 * judged at 10:00 AM where they now stand - rather than the abstraction that
 * two IANA identifiers disagree.
 *
 * So the two times sit side by side, in the user's words, before anything else
 * is said. Moving is one press, and staying is the back link: neither is
 * confirmation-gated, because the move can be made again in either direction
 * and a confirmation on a reversible action only teaches the user to dismiss
 * the ones that matter.
 */

import type { ChallengeView, TaskView } from "@betterwakeup/contract";
import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
import type { ApiClient } from "../api/client.ts";
import {
  changeTimeZone,
  moveImpact,
  movesDeadlinesEarlier,
  type TimeZoneMove,
  timeZoneLabel,
} from "../challenges/time-zone.ts";
import { AppText, Banner, Button, Card, Divider, Screen, StatusPill } from "../ui/components.tsx";
import { formatDeadline, formatTimeOfDay } from "../ui/format.ts";
import { BackLink } from "./back-link.tsx";
import { ConfirmAction } from "./confirm-action.tsx";

export interface TimeZoneScreenProps {
  readonly api: ApiClient;
  readonly challenge: ChallengeView;
  /** The device and challenge disagreement this screen is about. */
  readonly move: TimeZoneMove;
  /** Injected in tests, so the offset comparison is not the clock of the machine. */
  readonly now?: () => Date;
  /** Called once the deadlines have moved, so the caller can re-read the challenge. */
  readonly onChanged?: () => void;
  readonly onBack?: () => void;
}

export function TimeZoneScreen(props: TimeZoneScreenProps) {
  const { api, challenge, move } = props;
  const readClock = props.now ?? (() => new Date());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [moved, setMoved] = useState<readonly TaskView[] | null>(null);

  const here = timeZoneLabel(move.to);
  const there = timeZoneLabel(move.from);
  const task = challenge.currentTask;
  const impact = task === null ? null : moveImpact({ move, task, now: readClock() });
  const lost = impact?.landing === "past";

  const onSwitch = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      const outcome = await changeTimeZone({ api, challenge, timeZone: move.to });
      if (outcome.status === "done") {
        setMoved(outcome.value.rematerializedTasks);
        return;
      }
      setProblem(outcome.status === "blocked" ? outcome.reasons.join(" ") : outcome.message);
    } finally {
      setBusy(false);
    }
  }, [api, challenge, move.to]);

  if (moved !== null) {
    return (
      <Screen testID="time-zone-done">
        <View style={styles.header}>
          <StatusPill label={`${here} time`} tone="success" />
          <AppText variant="display" accessibilityRole="header">
            Your deadlines moved with you
          </AppText>
        </View>
        <Card>
          <AppText variant="small" testID="time-zone-moved-count">
            {movedSentence(moved.length)}
          </AppText>
          {moved[0] === undefined ? null : (
            <>
              <Divider />
              <AppText variant="small" tone="muted" testID="time-zone-next-deadline">
                Your next deadline is {formatDeadline(moved[0].deadline, move.to)}.
              </AppText>
            </>
          )}
        </Card>
        <Button
          testID="time-zone-done-back"
          label="Back to home"
          onPress={() => props.onChanged?.()}
        />
      </Screen>
    );
  }

  return (
    <Screen testID="time-zone-screen">
      <BackLink testID="time-zone-back" onBack={props.onBack} />

      <View style={styles.header}>
        <StatusPill label="You have moved" tone="warning" />
        <AppText variant="display" accessibilityRole="header">
          Your deadlines stayed behind
        </AppText>
        <AppText variant="body" tone="muted" testID="time-zone-summary">
          This challenge reads every deadline in {there} time. Your device says you are in {here}.
        </AppText>
      </View>

      {task === null ? null : (
        <Card testID="time-zone-comparison">
          <AppText variant="caption" tone="accent">
            YOUR NEXT WALK
          </AppText>
          <AppText variant="title" testID="time-zone-promised">
            {formatTimeOfDay(task.deadline, move.from)} in {there}
          </AppText>
          <AppText variant="small" tone="muted" testID="time-zone-actual">
            Which is {formatTimeOfDay(task.deadline, move.to)} where you are now.
          </AppText>
        </Card>
      )}

      <Card>
        <AppText variant="headline">What switching does</AppText>
        <AppText variant="small" tone="muted">
          Your wake-up time keeps its number and is read where you are:{" "}
          {task === null
            ? "the time you chose stays the time you chose"
            : `${formatTimeOfDay(task.deadline, move.from)} stays ${formatTimeOfDay(task.deadline, move.from)}, now in ${here}`}
          .
        </AppText>
        <Divider />
        <AppText variant="small" tone="muted">
          Days you have already done, and any day whose deadline is too close to change, stay
          exactly as they are. Nothing about your deposit or your progress changes.
        </AppText>
      </Card>

      {/* What the move does to the morning in front of the user, answered
          rather than supposed. The generic eastward caution is kept only for
          the cases the concrete answer cannot cover: no open task, or one the
          server would leave exactly where it is. */}
      {impact === null ? (
        movesDeadlinesEarlier(move, readClock()) === true ? (
          <Banner tone="warning">
            <AppText variant="small" tone="warning" testID="time-zone-earlier-warning">
              You have travelled east, so switching pulls your next deadline earlier. If it lands in
              the past, that day counts as missed.
            </AppText>
          </Banner>
        ) : null
      ) : (
        <Banner tone={lost ? "danger" : "warning"}>
          <AppText
            variant="small"
            tone={lost ? "danger" : "warning"}
            testID="time-zone-impact"
            accessibilityRole="alert"
          >
            {impact.sentence}
          </AppText>
        </Banner>
      )}

      {/* The only irreversible move there is. Everywhere else a switch can be
          made again in the other direction; a deadline that lands in the past
          is a missed morning the sweep will settle, so this one press is
          confirmed and painted like the rest of the presses that cost money. */}
      {lost && impact !== null ? (
        <ConfirmAction
          testID="time-zone-switch"
          label={`Use ${here} time`}
          consequence={impact.sentence}
          confirmLabel="Switch anyway and lose this morning"
          cancelLabel="Leave my deadlines where they are"
          variant="danger"
          busy={busy}
          onConfirm={onSwitch}
        />
      ) : (
        <Button
          testID="time-zone-switch"
          label={`Use ${here} time`}
          busy={busy}
          onPress={() => void onSwitch()}
        />
      )}

      {problem === null ? null : (
        <Banner tone="danger">
          <AppText
            variant="small"
            tone="danger"
            testID="time-zone-problem"
            accessibilityRole="alert"
          >
            {problem}
          </AppText>
        </Banner>
      )}
    </Screen>
  );
}

/**
 * How much moved. Zero is a real answer - every open task was already past the
 * point where its terms can be restated - and saying so is better than a silent
 * success the user reads as nothing having happened.
 */
function movedSentence(count: number): string {
  if (count === 0) {
    return "From your next scheduled day on, deadlines are read where you are. The days already in motion keep the times they were set with.";
  }
  if (count === 1) {
    return "One upcoming day moved to your new time zone.";
  }
  return `${count} upcoming days moved to your new time zone.`;
}

const styles = StyleSheet.create({
  header: { gap: 8 },
});
