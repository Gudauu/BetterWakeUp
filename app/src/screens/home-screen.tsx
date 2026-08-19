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

import type { ChallengeStatus, ChallengeView, EndedChallengeSummary } from "@betterwakeup/contract";
import { type ReactNode, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useCurrentChallenge } from "../challenges/current-challenge.ts";
import { detectTimeZone, formatMoney } from "../challenges/draft.ts";
import { type TimeZoneMove, timeZoneLabel, timeZoneMoveFor } from "../challenges/time-zone.ts";
import {
  type CompletionRuntimeFactory,
  type CompletionRuntimeState,
  createConfiguredCompletionRuntime,
  useCompletionRuntime,
} from "../completions/runtime.ts";
import { createConfiguredPaymentSheet, type PaymentSheet } from "../payments/payment-sheet.ts";
import { needsPaymentMethod } from "../payments/replace-payment-method.ts";
import {
  createConfiguredNotifier,
  type Notifier,
  type RemindersState,
  useReminders,
} from "../reminders/notifier.ts";
import { ALARM_LEAD_MINUTES, nextAlarmAt } from "../reminders/reminders.ts";
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
import { formatDay, formatDeadline, formatTimeOfDay } from "../ui/format.ts";
import { useTheme } from "../ui/theme.ts";
import { CreateChallengeScreen } from "./create-challenge-screen.tsx";
import { DailyCompletionScreen } from "./daily-completion-screen.tsx";
import { DeleteAccountScreen } from "./delete-account-screen.tsx";
import { PauseScreen } from "./pause-screen.tsx";
import { PaymentMethodScreen } from "./payment-method-screen.tsx";
import { RecoveryScreen } from "./recovery-screen.tsx";
import { TimeZoneScreen } from "./time-zone-screen.tsx";

export interface HomeScreenProps {
  readonly onSignOut?: () => void;
  /**
   * How the store, sync and movement capture behind today's task are built.
   * Substituted in tests and by a development build, so that reaching the task
   * screen does not require a device with a step counter.
   */
  readonly createRuntime?: CompletionRuntimeFactory;
  /**
   * The zone the device is in, which is what a running challenge's own zone is
   * checked against. Taken from the device unless a caller states it, so a test
   * can stand somewhere without moving the machine.
   */
  readonly deviceTimeZone?: string;
  /**
   * How reminders reach the device. Substituted in tests, so that home can be
   * rendered without a notification permission prompt; a build passes nothing
   * and the real scheduler is used.
   */
  readonly notifier?: Notifier;
  /**
   * How a card is asked for when a challenge carries a deposit. Handed to the
   * form; substituted in tests, and a build passes nothing.
   */
  readonly paymentSheet?: PaymentSheet;
}

/**
 * Where the user is. Home is a stack one screen deep: everything it opens
 * returns here, and nothing opens anything else, so one name is the whole of
 * the navigation state. A router arrives when a screen needs to open a third.
 */
type Route =
  | "home"
  | "create"
  | "task"
  | "pause"
  | "recovery"
  | "delete"
  | "timeZone"
  | "paymentMethod";

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

export function HomeScreen({
  onSignOut,
  createRuntime,
  deviceTimeZone,
  notifier,
  paymentSheet,
}: HomeScreenProps) {
  const { api, signOut } = useSession();
  const theme = useTheme();
  const { state, reload } = useCurrentChallenge(api);
  const [route, setRoute] = useState<Route>("home");
  // The challenge as it stood when its last day was acknowledged, so the finish
  // is on screen the moment it happens rather than after the next read.
  const [finished, setFinished] = useState<EndedChallengeSummary | null>(null);
  // The ended challenge the user has already taken in. The server keeps
  // reporting the last outcome until another challenge exists, which is right
  // for someone opening the app to find out - and wrong for someone who has
  // read it and come back for something else.
  const [dismissed, setDismissed] = useState<string | null>(null);
  // A user who looked at the time zone offer and chose to keep their deadlines
  // where they are - a weekend away is a real reason - is not asked again while
  // the app is open. The device's zone is checked again on the next launch.
  const [keptTimeZone, setKeptTimeZone] = useState(false);
  const here = deviceTimeZone ?? detectTimeZone();
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
  // Built once for as long as home lives, so the effect that follows the
  // challenge is not re-run by a new object on every render.
  const [reminderNotifier] = useState<Notifier>(() => notifier ?? createConfiguredNotifier());
  // The same sheet the form uses, kept here as well: a lapsed hold is asked
  // about from home, and the card that answers it is the same kind of card.
  const [cardSheet] = useState<PaymentSheet>(() => paymentSheet ?? createConfiguredPaymentSheet());
  // Only a loaded read says anything about what is due. A read in flight or a
  // read that failed leaves the device's reminders where they are.
  const reminders = useReminders(
    state.status === "loaded" ? state.challenge : undefined,
    reminderNotifier,
  );
  // Opening the form retires the finish: whatever comes back from it, the last
  // challenge is no longer the thing the screen is about.
  const openCreate = (endedId?: string) => {
    setFinished(null);
    if (endedId !== undefined) {
      setDismissed(endedId);
    }
    setRoute("create");
  };

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
        {...(paymentSheet === undefined ? {} : { paymentSheet })}
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
    const open = state.challenge;
    if (route === "task") {
      return (
        <TodayTask
          challenge={open}
          runtime={runtime}
          onBack={() => goHome(true)}
          onFinished={() => setFinished(succeededSummary(open))}
        />
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
    if (route === "timeZone") {
      const move = timeZoneMoveFor(open, here);
      // Only reachable while the disagreement stands, so a challenge that ended
      // or a device that moved back drops the user home rather than onto a
      // screen offering a move to the zone they are already in.
      if (move !== null) {
        return (
          <TimeZoneScreen
            api={api}
            challenge={open}
            move={move}
            onChanged={() => goHome(true)}
            onBack={() => {
              setKeptTimeZone(true);
              goHome(false);
            }}
          />
        );
      }
    }
    if (route === "paymentMethod" && needsPaymentMethod(open)) {
      return (
        <PaymentMethodScreen
          api={api}
          challenge={open}
          sheet={cardSheet}
          onSecured={() => goHome(true)}
          onBack={() => goHome(false)}
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

  // What the account has just been through, if anything: the finish the task
  // screen reported, or the outcome the server is still holding for it. Both
  // are read the same way, because a month that ended is a month that ended
  // however the app came to hear about it.
  const ended =
    state.challenge !== null
      ? null
      : (finished ?? (state.lastEnded?.id === dismissed ? null : state.lastEnded));

  return (
    <Screen testID="home">
      <View style={styles.header}>
        <AppText variant="caption" tone="accent">
          {state.challenge !== null
            ? "TODAY"
            : ended === null
              ? "READY WHEN YOU ARE"
              : ENDED_CAPTION[ended.status]}
        </AppText>
        <AppText variant="display" accessibilityRole="header">
          BetterWakeUp
        </AppText>
      </View>

      {state.challenge === null ? (
        ended === null ? (
          <Card testID="home-no-challenge">
            <AppText variant="headline">No challenge running</AppText>
            <AppText variant="small" tone="muted">
              Set a wake-up time, walk when the alarm goes, and keep your deposit.
            </AppText>
            <Button
              testID="home-create-challenge"
              label="Start a challenge"
              onPress={() => openCreate()}
            />
          </Card>
        ) : (
          <FinishedCard
            ended={ended}
            onStartAnother={() => openCreate(ended.id)}
            onDismiss={() => {
              setFinished(null);
              setDismissed(ended.id);
            }}
          />
        )
      ) : (
        <ChallengeCard
          challenge={state.challenge}
          reminders={reminders}
          timeZoneMove={keptTimeZone ? null : timeZoneMoveFor(state.challenge, here)}
          onOpenTask={() => setRoute("task")}
          onOpenPause={() => setRoute("pause")}
          onOpenRecovery={() => setRoute("recovery")}
          onOpenTimeZone={() => setRoute("timeZone")}
          onOpenPaymentMethod={() => setRoute("paymentMethod")}
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
  reminders,
  timeZoneMove,
  onOpenTask,
  onOpenPause,
  onOpenRecovery,
  onOpenTimeZone,
  onOpenPaymentMethod,
}: {
  challenge: ChallengeView;
  reminders: RemindersState;
  timeZoneMove: TimeZoneMove | null;
  onOpenTask: () => void;
  onOpenPause: () => void;
  onOpenRecovery: () => void;
  onOpenTimeZone: () => void;
  onOpenPaymentMethod: () => void;
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

      <Reminders challenge={challenge} reminders={reminders} />

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

      {/* The deadline the user is judged against is the one thing on this
          screen that can be quietly wrong, and only the device knows it is.
          The banner names the two times rather than the two zones, because
          "10:00 AM" is what the user would have noticed. */}
      {timeZoneMove === null ? null : (
        <Banner tone="warning" testID="home-time-zone-move">
          <AppText variant="small" tone="warning">
            You are in {timeZoneLabel(timeZoneMove.to)}, but this challenge reads its deadlines in{" "}
            {timeZoneLabel(timeZoneMove.from)} time
            {currentTask === null
              ? ""
              : `, so your ${formatTimeOfDay(currentTask.deadline, timeZoneMove.from)} walk is due at ${formatTimeOfDay(currentTask.deadline, timeZoneMove.to)} here`}
            .
          </AppText>
          <Button
            testID="home-open-time-zone"
            label={`Switch to ${timeZoneLabel(timeZoneMove.to)} time`}
            onPress={onOpenTimeZone}
          />
        </Banner>
      )}

      {needsPaymentMethod(challenge) ? (
        <Banner tone="danger" testID="home-deposit-unsecured-banner">
          <AppText
            variant="small"
            tone="danger"
            testID="home-deposit-unsecured"
            accessibilityRole="alert"
          >
            Your card no longer secures this deposit. Add a new one to keep the challenge honest.
          </AppText>
          <Button
            testID="home-open-payment-method"
            label="Add a card"
            onPress={onOpenPaymentMethod}
          />
        </Banner>
      ) : null}

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

/**
 * Whether the device will wake the user for this challenge.
 *
 * The whole product rests on the user being at their phone before a wall-clock
 * time with money on it, so a challenge running on a device that will never
 * make a sound is the quietest way to lose a deposit. The offer names the time
 * the nudge would arrive rather than the feature, because "6:15 AM" is the
 * thing worth agreeing to.
 *
 * A challenge that is over or paused has nothing to be woken for, so it says
 * nothing at all rather than offering a switch that would schedule nothing.
 */
function Reminders({
  challenge,
  reminders,
}: {
  challenge: ChallengeView;
  reminders: RemindersState;
}) {
  const alarm = nextAlarmAt(challenge);
  if (challenge.status !== "active" || challenge.pause.pausedAt !== null) {
    return null;
  }

  if (reminders.permission === "granted") {
    return (
      <AppText variant="small" tone="muted" testID="home-reminders-on">
        {alarm === null
          ? "Reminders are on. You will be nudged before your next walk."
          : `Reminders are on. You will be nudged at ${formatTimeOfDay(alarm, challenge.configuration.timeZone)}, ${ALARM_LEAD_MINUTES} minutes before the deadline.`}
      </AppText>
    );
  }

  if (reminders.permission === "denied") {
    return (
      <AppText variant="small" tone="muted" testID="home-reminders-denied">
        Reminders are off. Turn on notifications for BetterWakeUp in your device settings and you
        will be nudged before each walk.
      </AppText>
    );
  }

  return (
    <Banner tone="info" testID="home-reminders-offer">
      <AppText variant="small">
        {alarm === null
          ? `Let us wake you ${ALARM_LEAD_MINUTES} minutes before each deadline, so a walk is never missed by forgetting it.`
          : `Let us wake you at ${formatTimeOfDay(alarm, challenge.configuration.timeZone)}, ${ALARM_LEAD_MINUTES} minutes before your deadline, so a walk is never missed by forgetting it.`}
      </AppText>
      <Button
        testID="home-enable-reminders"
        label="Turn on reminders"
        busy={reminders.enabling}
        onPress={reminders.enable}
      />
    </Banner>
  );
}

/** The caption over an account holding no challenge, once one has ended. */
const ENDED_CAPTION: Readonly<Record<EndedChallengeSummary["status"], string>> = {
  succeeded: "WELL DONE",
  failed: "THAT ONE'S OVER",
  expired: "THAT ONE'S OVER",
};

const ENDED_PILL: Readonly<
  Record<EndedChallengeSummary["status"], { label: string; tone: "success" | "danger" }>
> = {
  succeeded: { label: "Challenge complete", tone: "success" },
  failed: { label: "Challenge ended short", tone: "danger" },
  expired: { label: "Challenge expired", tone: "danger" },
};

/**
 * The challenge that just ended, in place of the empty state.
 *
 * A challenge that succeeds says so on the completion that ended it, and one
 * that fails or expires is decided by a sweep the app never hears, so the
 * server reports the last outcome until another challenge exists. Either way
 * this is the same card: what happened, how many days were done, and what
 * became of the money - the three things the user staked a month on.
 */
function FinishedCard({
  ended,
  onStartAnother,
  onDismiss,
}: {
  ended: EndedChallengeSummary;
  onStartAnother: () => void;
  onDismiss: () => void;
}) {
  const pill = ENDED_PILL[ended.status];
  return (
    <Card testID="home-finished">
      <StatusPill testID="home-finished-status" label={pill.label} tone={pill.tone} />
      <AppText variant="display" testID="home-finished-days">
        {endedDaysCount(ended)}
        <AppText variant="headline" tone="muted">
          {endedDaysSuffix(ended)}
        </AppText>
      </AppText>
      <AppText variant="small" tone="muted" testID="home-finished-deposit">
        {endedDepositText(ended)}
      </AppText>
      <Button
        testID="home-create-challenge"
        label={ended.status === "succeeded" ? "Start another challenge" : "Start a new challenge"}
        onPress={onStartAnother}
      />
      {/* The way to put it down. The card stands until another challenge
          exists, which is right for someone opening the app to find out what
          happened and wrong for someone who already knows. */}
      <TextButton testID="home-finished-dismiss" label="Got it" onPress={onDismiss} />
    </Card>
  );
}

/**
 * A success is read as the whole month it was; anything else is read as the
 * days that were actually done, because that is the honest number and the one
 * the user is about to compare against what they set out to do.
 */
function endedDaysCount(ended: EndedChallengeSummary): string {
  return ended.status === "succeeded"
    ? String(ended.requiredTaskCount)
    : `${ended.completedTaskCount} / ${ended.requiredTaskCount}`;
}

function endedDaysSuffix(ended: EndedChallengeSummary): string {
  if (ended.status === "succeeded") {
    return ended.requiredTaskCount === 1 ? " day, all yours" : " days, all yours";
  }
  return ended.requiredTaskCount === 1 ? " day done" : " days done";
}

/** What became of the money, which is the first thing asked about any ending. */
function endedDepositText(ended: EndedChallengeSummary): string {
  const amount = formatMoney(ended.deposit.amount);
  if (ended.depositOutcome === "none") {
    return ended.status === "succeeded"
      ? "You staked nothing on this one. The next one could be worth something."
      : "You staked nothing on this one, so nothing was charged.";
  }
  if (ended.depositOutcome === "charged") {
    return `Your ${amount} deposit was charged. A new challenge starts a new deposit.`;
  }
  return ended.status === "succeeded"
    ? `Your ${amount} deposit was never charged.`
    : `Your ${amount} deposit was released, not charged.`;
}

/**
 * The finish the task screen just reported, as the summary the server would
 * answer with once asked again. Home draws it immediately rather than waiting
 * for a read, and the two have to be the same shape or the card would have to
 * know which of them it was looking at.
 */
function succeededSummary(challenge: ChallengeView): EndedChallengeSummary {
  const { configuration } = challenge;
  return {
    id: challenge.id,
    status: "succeeded",
    endedAt: new Date().toISOString(),
    requiredTaskCount: configuration.requiredTaskCount,
    // The completion that ended it was the last one the challenge asked for.
    completedTaskCount: configuration.requiredTaskCount,
    deposit: configuration.deposit,
    depositOutcome: configuration.deposit.amount === 0 ? "none" : "kept",
  };
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
  onFinished,
}: {
  challenge: ChallengeView;
  runtime: CompletionRuntimeState;
  onBack: () => void;
  onFinished: () => void;
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
      onFinished={onFinished}
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
