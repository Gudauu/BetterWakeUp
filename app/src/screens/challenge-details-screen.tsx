/**
 * Everything about the running challenge that is not the next walk.
 *
 * Home answers one question - what is the next walk, and how long is left -
 * and this page holds the rest: how the days have gone, the schedule the
 * deadlines come from, what is at stake and what a miss would cost, the
 * reminder switch, pausing, ending the challenge early, and the account. It is
 * opened from home's next-walk card and returns there.
 *
 * The page owns no rules. Each block reads a helper that already decides what
 * it says, so moving a block between here and home moves no logic.
 */

import type { ChallengeStatus, ChallengeView, EndedChallengeSummary } from "@betterwakeup/contract";
import { type ReactNode, useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
import type { ApiClient } from "../api/client.ts";
import { challengeCalendar } from "../challenges/calendar.ts";
import { challengeStartedOn } from "../challenges/challenge-age.ts";
import { formatMoney } from "../challenges/draft.ts";
import { endChallengeText } from "../challenges/end-cost.ts";
import {
  challengeHistory,
  type DayState,
  historyLabel,
  historyLegend,
  streakSentence,
} from "../challenges/history.ts";
import { endChallenge } from "../challenges/lifecycle-commands.ts";
import { missCost } from "../challenges/miss-cost.ts";
import { scheduleGroups } from "../challenges/schedule.ts";
import { timeZoneLabel } from "../challenges/time-zone.ts";
import { walkWindowSummary } from "../challenges/walk-window-setting.ts";
import type { OpenSettingsState } from "../device/settings.ts";
import type { RemindersState } from "../reminders/notifier.ts";
import { nextAlarmAt } from "../reminders/reminders.ts";
import {
  AppText,
  Banner,
  Button,
  Card,
  DayCalendar,
  DayLegend,
  type DayMark,
  type DayMarkTone,
  DetailRow,
  Screen,
  StatusPill,
  TextButton,
} from "../ui/components.tsx";
import { formatDay, formatTimeOfDay } from "../ui/format.ts";
import { AccountSection } from "./account-section.tsx";
import { BackLink } from "./back-link.tsx";
import { ConfirmAction } from "./confirm-action.tsx";
import { OpenSettingsAction } from "./open-settings-action.tsx";

export interface ChallengeDetailsScreenProps {
  readonly api: ApiClient;
  readonly challenge: ChallengeView;
  readonly reminders: RemindersState;
  readonly settings: OpenSettingsState;
  readonly onBack: () => void;
  readonly onOpenPause: () => void;
  readonly onSignOut: (() => void) | undefined;
  readonly onDeleteAccount: () => void;
  /** Called with the challenge as it ended, once the server has ended it. */
  readonly onEnded: (ended: EndedChallengeSummary) => void;
  /** Walks this phone holds that the server has not acknowledged. */
  readonly heldWalks: number;
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
  abandoned: "You ended this challenge",
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
    abandoned: "danger",
  };

/**
 * The colour each day is read in. A skipped and a forgiven day are both
 * warnings rather than failures: the day was not walked, and neither of them
 * cost the user anything.
 */
const DAY_TONE: Readonly<Record<DayState, DayMarkTone>> = {
  kept: "success",
  missed: "danger",
  forgiven: "warning",
  skipped: "warning",
  due: "accent",
  ahead: "muted",
};

/**
 * Which days are drawn as a ring rather than a block: the one being asked for
 * now, and the ones a pause meant nobody was asked about. A filled mark is a
 * day that resolved into something - a walk, a miss, a spent allowance - and a
 * ring is a day that did not, which is also what keeps a skipped day from being
 * the same mark as a forgiven one when they share a colour.
 */
const DAY_OUTLINED: Readonly<Record<DayState, boolean>> = {
  kept: false,
  missed: false,
  forgiven: false,
  skipped: true,
  due: true,
  ahead: false,
};

const REST_MARK: DayMark = { tone: "rest" };

function dayMarkFor(state: DayState): DayMark {
  return DAY_OUTLINED[state]
    ? { tone: DAY_TONE[state], outlined: true }
    : { tone: DAY_TONE[state] };
}

export function ChallengeDetailsScreen({
  api,
  challenge,
  reminders,
  settings,
  onBack,
  onOpenPause,
  onSignOut,
  onDeleteAccount,
  onEnded,
  heldWalks,
}: ChallengeDetailsScreenProps): ReactNode {
  const paused = challenge.pause.pausedAt !== null;
  const { progress, configuration } = challenge;
  const history = challengeHistory(challenge);
  const streak = streakSentence(history);
  const months = challengeCalendar(history);
  // A schedule that walks every day holds no rest day, and a key naming one
  // would describe a square the calendar never draws.
  const hasRest = months.some((month) =>
    month.weeks.some((week) => week.some((day) => day.state === "rest")),
  );
  // When it started, which the kept-walk count cannot say on any schedule that
  // skips days of the week.
  const startedOn = challengeStartedOn(challenge);
  // What one missed morning would do, which turns on the deposit and on an
  // allowance only the server can speak for.
  const miss = missCost(challenge);
  // Only completed walks count toward the total. A skipped day extends the
  // challenge and a forgiven one only keeps it alive, so neither is subtracted.
  const remaining = Math.max(0, progress.requiredTaskCount - progress.completedTaskCount);

  return (
    <Screen testID="details">
      <BackLink testID="details-back" onBack={onBack} />
      <View style={styles.header}>
        <AppText variant="display" accessibilityRole="header">
          Your challenge
        </AppText>
        <View style={styles.row}>
          <StatusPill
            testID="details-status"
            label={paused ? "Paused" : STATUS_HEADLINE[challenge.status]}
            tone={paused ? "warning" : STATUS_TONE[challenge.status]}
          />
        </View>
      </View>

      <AppText variant="caption" tone="muted">
        PROGRESS
      </AppText>
      <Card>
        <AppText variant="headline" testID="details-progress">
          {progress.completedTaskCount} of {progress.requiredTaskCount} walks done, {remaining} to
          go.
        </AppText>
        {streak === null ? null : (
          <AppText variant="small" tone="accent" testID="details-streak">
            {streak}
          </AppText>
        )}
        {/* The challenge as a wall calendar: which mornings were kept, which
            one broke a run, which dates hold no walk at all, and how many are
            still ahead. A challenge that has not been materialized yet holds
            no days and draws none. */}
        {months.length === 0 ? null : (
          <>
            <DayCalendar
              testID="details-calendar"
              accessibilityLabel={historyLabel(history)}
              months={months.map((month) => ({
                title: monthTitle(month.month),
                weeks: month.weeks.map((week) =>
                  week.map((day) => ({
                    label: String(day.dayOfMonth),
                    mark:
                      day.state === "outside"
                        ? null
                        : day.state === "rest"
                          ? REST_MARK
                          : dayMarkFor(day.state),
                  })),
                ),
              }))}
            />
            {/* Which square is which. The calendar is otherwise colour alone,
                and the two colours it leans on hardest - a kept morning and a
                missed one - are the pair most commonly seen as one. */}
            <DayLegend
              testID="details-legend"
              items={[
                ...historyLegend(history).map((entry) => ({
                  mark: dayMarkFor(entry.state),
                  label: entry.label,
                })),
                ...(hasRest ? [{ mark: REST_MARK, label: "No walk" }] : []),
              ]}
            />
          </>
        )}
        {startedOn === null ? null : (
          <DetailRow label="Started" value={startedOn} testID="details-started" />
        )}
        <DetailRow
          label="Projected end"
          value={formatDay(challenge.projectedEndDate)}
          testID="details-end-date"
        />
      </Card>

      {/* The schedule cannot be edited once the challenge exists, so the only
          thing left to do about it is say it. */}
      <AppText variant="caption" tone="muted">
        MORNINGS
      </AppText>
      <Card testID="details-schedule">
        {scheduleGroups(configuration.schedule).map((group) => (
          <DetailRow key={group.days} label={group.days} value={group.time} />
        ))}
        <DetailRow
          label="Steps per walk"
          value={String(configuration.stepTarget)}
          testID="details-steps"
        />
        <DetailRow
          label="Walk opens"
          value={walkWindowSummary(configuration.walkWindowMinutes)}
          testID="details-walk-window"
        />
        <DetailRow
          label="Time zone"
          value={timeZoneLabel(configuration.timeZone)}
          testID="details-schedule-zone"
        />
      </Card>

      <Reminders challenge={challenge} reminders={reminders} settings={settings} />

      <AppText variant="caption" tone="muted">
        DEPOSIT
      </AppText>
      <Card>
        <DetailRow
          label="At stake"
          value={
            configuration.deposit.amount === 0 ? "None" : formatMoney(configuration.deposit.amount)
          }
          testID="details-deposit"
        />
        {/* What a miss would cost, said before one happens. The terms state it
            once at setup and never again, so whether the safety net is still
            there was unreadable for the whole month it matters in. */}
        {miss === null ? null : (
          <AppText variant="small" tone={miss.tone} testID="details-miss-cost">
            {miss.text}
          </AppText>
        )}
      </Card>

      {/* Pausing belongs to a challenge that can still run. A paused one is
          resumed from the same screen, so the press is offered either way. */}
      {challenge.status === "active" ? (
        <TextButton
          testID="details-open-pause"
          tone="accent"
          label={paused ? "Resume the challenge" : "Pause the challenge"}
          onPress={onOpenPause}
        />
      ) : null}

      <EndChallenge api={api} challenge={challenge} onEnded={onEnded} />

      <AccountSection
        testID="details-account"
        onSignOut={onSignOut}
        onDeleteAccount={onDeleteAccount}
        challenge={challenge}
        heldWalks={heldWalks}
      />
    </Screen>
  );
}

/**
 * Ending the challenge before it finishes.
 *
 * Offered while the challenge still holds the account's slot, including while
 * a recovery offer stands, since ending is a separate decision from that one.
 * It is a quiet link rather than a button: it is never the next thing to do,
 * and the confirmation it opens is where the weight goes - the amount, that it
 * is charged now, and that it cannot be undone.
 */
function EndChallenge({
  api,
  challenge,
  onEnded,
}: {
  api: ApiClient;
  challenge: ChallengeView;
  onEnded: (ended: EndedChallengeSummary) => void;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const onConfirm = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      const outcome = await endChallenge({ api, challenge, confirmed: true });
      if (outcome.status === "done") {
        onEnded(outcome.value.ended);
        return;
      }
      setProblem(outcome.status === "blocked" ? outcome.reasons.join(" ") : outcome.message);
    } finally {
      setBusy(false);
    }
  }, [api, challenge, onEnded]);

  if (challenge.status !== "active" && challenge.status !== "recovery_pending") {
    return null;
  }
  const staked = challenge.configuration.deposit.amount;
  return (
    <>
      <ConfirmAction
        testID="details-end"
        quiet
        variant="danger"
        label="End challenge"
        consequence={endChallengeText(challenge)}
        confirmLabel={staked === 0 ? "End the challenge" : `End it and pay ${formatMoney(staked)}`}
        cancelLabel="Keep the challenge"
        busy={busy}
        onConfirm={onConfirm}
      />
      {problem === null ? null : (
        <Banner tone="danger">
          <AppText
            variant="small"
            tone="danger"
            testID="details-end-problem"
            accessibilityRole="alert"
          >
            {problem}
          </AppText>
        </Banner>
      )}
    </>
  );
}

/** "September 2026", read from the month's first date without a zone moving it. */
function monthTitle(firstOfMonth: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "long",
      year: "numeric",
    }).format(new Date(`${firstOfMonth}T00:00:00.000Z`));
  } catch {
    return firstOfMonth;
  }
}

/**
 * Whether the device will wake the user for this challenge.
 *
 * The offer names the time the nudge would arrive rather than the feature,
 * because "6:50 AM" is the thing worth agreeing to. A challenge that is over or
 * paused has nothing to be woken for, so it says nothing at all rather than
 * offering a switch that would schedule nothing.
 */
function Reminders({
  challenge,
  reminders,
  settings,
}: {
  challenge: ChallengeView;
  reminders: RemindersState;
  settings: OpenSettingsState;
}): ReactNode {
  if (challenge.status !== "active" || challenge.pause.pausedAt !== null) {
    return null;
  }
  const alarm = nextAlarmAt(challenge);
  const time = alarm === null ? null : formatTimeOfDay(alarm, challenge.configuration.timeZone);

  return (
    <>
      <AppText variant="caption" tone="muted">
        REMINDER
      </AppText>
      <Card testID="details-reminders">
        {reminders.permission === "granted" ? (
          <AppText variant="small" testID="details-reminders-on">
            {time === null
              ? "Reminders are on. You will be nudged before your next walk."
              : `Reminders are on. You will be nudged at ${time}, when your walk opens.`}
          </AppText>
        ) : reminders.permission === "denied" ? (
          <>
            <AppText variant="small" tone="muted" testID="details-reminders-denied">
              Reminders are off. Turn on notifications for BetterWakeUp in your device settings and
              you will be nudged as each walk opens.
            </AppText>
            <OpenSettingsAction
              testID="details-reminders-settings"
              settings={settings}
              tone="muted"
            />
          </>
        ) : (
          <>
            <AppText variant="small" testID="details-reminders-offer">
              {time === null
                ? "Get a reminder as each walk opens, so a walk is never missed by forgetting it."
                : `Get a reminder at ${time}, when your walk opens, so a walk is never missed by forgetting it.`}
            </AppText>
            <Button
              testID="details-enable-reminders"
              label="Turn on reminders"
              variant="secondary"
              busy={reminders.enabling}
              onPress={reminders.enable}
            />
          </>
        )}
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  header: { gap: 8 },
  row: { flexDirection: "row" },
});
