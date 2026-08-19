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
import { type ReactNode, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { type AppReturnTrigger, useAppReturn } from "../challenges/app-return.ts";
import { challengeAge } from "../challenges/challenge-age.ts";
import { useCurrentChallenge } from "../challenges/current-challenge.ts";
import { detectTimeZone, formatMoney } from "../challenges/draft.ts";
import { endedReading } from "../challenges/ended-challenge.ts";
import {
  challengeHistory,
  type DayState,
  historyLabel,
  historyLegend,
  streakSentence,
} from "../challenges/history.ts";
import { missCost } from "../challenges/miss-cost.ts";
import {
  pausedForSentence,
  pausedRestSentence,
  pauseExpirySentence,
  pausePresentation,
} from "../challenges/pause.ts";
import {
  type RecoveryWindow,
  recoveryOfferSummary,
  recoveryWindow,
} from "../challenges/recovery-window.ts";
import { nextActiveMorning, nextMorningText, scheduleGroups } from "../challenges/schedule.ts";
import { type TimeZoneMove, timeZoneLabel, timeZoneMoveFor } from "../challenges/time-zone.ts";
import { walkedTodayText, walkOpensText, walkWindow } from "../challenges/walk-window.ts";
import { receiptGoneText, receiptWindow } from "../completions/receipt-window.ts";
import {
  type CompletionRuntimeFactory,
  type CompletionRuntimeState,
  createConfiguredCompletionRuntime,
  useCompletionRuntime,
} from "../completions/runtime.ts";
import {
  morningGoneText,
  timeLeftUntil,
  unsentPastDeadlineText,
} from "../completions/time-left.ts";
import { heldWalksText, type UnsentWork, useUnsentWork } from "../completions/unsent-work.ts";
import { attemptsText, waitingReading } from "../completions/waiting-reason.ts";
import { type BackPressTrigger, useBackPress } from "../device/back-press.ts";
import {
  createConfiguredSettingsLauncher,
  type OpenSettingsState,
  type SettingsLauncher,
  useOpenSettings,
} from "../device/settings.ts";
import {
  ALLOW_MOVEMENT_LABEL,
  createConfiguredMovementDevice,
  type MovementDevice,
  type MovementReadinessState,
  runningMovementNotice,
  useMovementReadiness,
} from "../movement/device-readiness.ts";
import { createConfiguredPaymentSheet, type PaymentSheet } from "../payments/payment-sheet.ts";
import { needsPaymentMethod } from "../payments/replace-payment-method.ts";
import {
  createConfiguredNotifier,
  type Notifier,
  type RemindersState,
  useReminders,
} from "../reminders/notifier.ts";
import {
  type ReminderTapTrigger,
  tapDestination,
  useReminderTaps,
} from "../reminders/reminder-taps.ts";
import { ALARM_LEAD_MINUTES, nextAlarmAt, type ReminderTarget } from "../reminders/reminders.ts";
import { useSession } from "../session/session-context.tsx";
import {
  SESSION_RENEW_CANCEL_LABEL,
  SESSION_RENEW_CONFIRM_LABEL,
  SESSION_RENEW_LABEL,
  SESSION_RENEWAL_TEXT,
  type SessionExpiry,
  sessionExpiry,
  sessionExpiryText,
  sessionRenewalConsequence,
} from "../session/session-expiry.ts";
import {
  SIGN_OUT_CANCEL_LABEL,
  SIGN_OUT_CONFIRM_LABEL,
  signOutConsequence,
} from "../session/sign-out.ts";
import { useClock } from "../ui/clock.ts";
import {
  AppText,
  Banner,
  Button,
  Card,
  DayLegend,
  type DayMark,
  type DayMarkTone,
  DayStrip,
  DetailRow,
  Divider,
  ProgressBar,
  Screen,
  StatusPill,
  TextButton,
} from "../ui/components.tsx";
import { formatDay, formatDeadline, formatTimeOfDay } from "../ui/format.ts";
import {
  createConfiguredScreenReader,
  type ScreenReader,
  useScreenChangeAnnouncement,
} from "../ui/screen-change.ts";
import { useTheme } from "../ui/theme.ts";
import { ConfirmAction } from "./confirm-action.tsx";
import { CreateChallengeScreen } from "./create-challenge-screen.tsx";
import { DailyCompletionScreen } from "./daily-completion-screen.tsx";
import { DeleteAccountScreen } from "./delete-account-screen.tsx";
import { OpenSettingsAction } from "./open-settings-action.tsx";
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
  /**
   * This phone's step counter, asked about by the form before a deposit is
   * staked on it. Handed to the form; substituted in tests so no suite reaches
   * for a sensor, and a build passes nothing.
   */
  readonly movementDevice?: MovementDevice;
  /**
   * How home hears that the app came back to the front, which is when it asks
   * the server again. Substituted in tests, so that a return is drivable
   * without an operating system; a build passes nothing.
   */
  readonly appReturn?: AppReturnTrigger;
  /**
   * How home hears Android's back press, which is the way out of whatever it
   * opened. Substituted in tests, so that a back press is drivable without a
   * device; a build passes nothing.
   */
  readonly backPress?: BackPressTrigger;
  /**
   * How home hears that a wake-up reminder was tapped, which is what opens the
   * walk it was about. Substituted in tests, so that a tap is drivable without
   * a notification; a build passes nothing.
   */
  readonly reminderTaps?: ReminderTapTrigger;
  /**
   * How the app says out loud which screen it has just opened, since swapping
   * what home renders is not a navigation any screen reader can see.
   * Substituted in tests so what is announced is readable back; a build passes
   * nothing and React Native's own announcement is used.
   */
  readonly screenReader?: ScreenReader;
  /**
   * How the device's settings page is opened, which is the only way out of a
   * refused notification or motion permission. Substituted in tests so a press
   * opens nothing; a build passes nothing and the real one is used.
   */
  readonly settings?: SettingsLauncher;
  /**
   * How the clock is read, for the two windows this screen counts down: the
   * morning's deadline and the recovery offer's expiry. Stated in tests so that
   * how long is left is a fact of the test rather than of the day it is run on
   * - and a stated clock that keeps answering the same instant never ticks, so
   * a test's screen stands still. A build passes nothing and the device's clock
   * is read on a timer.
   */
  readonly now?: () => Date;
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
 * What each screen is called when the app has to say where it has just gone.
 *
 * These are destinations rather than headlines: a screen's own title depends on
 * what it found there - today's walk leads with the date, the pause screen with
 * whether the challenge is running - and none of those answer the question a
 * reader whose focus has just been thrown off is asking, which is which screen
 * this is.
 */
const ROUTE_NAMES: Readonly<Record<Route, string>> = {
  home: "Home",
  create: "Set up a challenge",
  task: "Today's walk",
  pause: "Pause or resume",
  recovery: "Emergency Recovery",
  delete: "Delete your account",
  timeZone: "Your time zone",
  paymentMethod: "Your card",
};

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

/**
 * The colour each day in the row is read in. A skipped and a forgiven day are
 * both warnings rather than failures: the day was not walked, and neither of
 * them cost the user anything.
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

function dayMarkFor(state: DayState): DayMark {
  return DAY_OUTLINED[state]
    ? { tone: DAY_TONE[state], outlined: true }
    : { tone: DAY_TONE[state] };
}

export function HomeScreen({
  onSignOut,
  createRuntime,
  deviceTimeZone,
  notifier,
  paymentSheet,
  movementDevice,
  appReturn,
  backPress,
  reminderTaps,
  now,
  settings,
  screenReader,
}: HomeScreenProps) {
  const { api, signOut, state: session } = useSession();
  // The clock is state that ticks, not a read at render time. Everything on
  // this screen that counts down - how much of the morning is left, how long
  // is left to decide on a recovery offer, whether either window has closed -
  // would otherwise be true only for the instant home was drawn, and a phone
  // left face-up would go on offering a walk the server stopped accepting.
  const clock = useClock(now);
  const theme = useTheme();
  const { state, refreshing, refreshFailed, reload, refresh } = useCurrentChallenge(api);
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
  // The sign-in itself is on a clock, and the app used to read it only at
  // launch: a session that ran out mid-challenge threw the user onto the
  // signed-out screen with no notice, on whichever morning the thirtieth day
  // turned out to be. Read here against the same ticking clock as the morning,
  // so the warning arrives while there is still time to act on it.
  const expiry = session.status === "signedIn" ? sessionExpiry(session.session, clock, here) : null;
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
  // The account is gone from the server, and home is the last component still
  // holding the phone's own copy of it. Every stored walk names a challenge and
  // a task that no longer exist, so none of them can ever be sent; they are
  // thrown away here, before the sign-out unmounts the runtime that owns them.
  async function onAccountDeleted() {
    if (runtime.status === "ready") {
      // Best effort, the same way sign-out treats revoking the session: a
      // database that will not answer must not strand the user on a screen
      // reading an account that no longer exists.
      await runtime.runtime.store.discardAll().catch(() => undefined);
    }
    await signOut("deleted");
  }
  // Built once for as long as home lives, so the effect that follows the
  // challenge is not re-run by a new object on every render.
  const [reminderNotifier] = useState<Notifier>(() => notifier ?? createConfiguredNotifier());
  // The same sheet the form uses, kept here as well: a lapsed hold is asked
  // about from home, and the card that answers it is the same kind of card.
  const [cardSheet] = useState<PaymentSheet>(() => paymentSheet ?? createConfiguredPaymentSheet());
  // The way to the page that answers a refused permission. Held here rather
  // than in the two places that offer the press, so home and today's task send
  // the user to the same place.
  const [settingsLauncher] = useState<SettingsLauncher>(
    () => settings ?? createConfiguredSettingsLauncher(),
  );
  const openSettings = useOpenSettings(settingsLauncher);
  // The step counter the whole challenge is settled by. Built once here and
  // handed on to the form as well, so home and the screen that stakes the money
  // ask the same device the same question.
  const [device] = useState<MovementDevice>(
    () => movementDevice ?? createConfiguredMovementDevice(),
  );
  // Whether this phone can still count a walk. Read on home rather than only at
  // setup, because motion access can be taken away long after the deposit was
  // authorized and the next place the app would have noticed is the press of
  // "Start the walk", with the morning already running.
  const movement = useMovementReadiness(device);
  // Built once for the life of the screen, so the announcement effect is not
  // re-run by a new object arriving on every render.
  const [reader] = useState<ScreenReader>(() => screenReader ?? createConfiguredScreenReader());
  // Home swaps what it renders instead of pushing a screen, which no screen
  // reader can see: without this, activating "Open today's task" leaves the
  // reader focused on a control that no longer exists and silent about where
  // the user now is.
  useScreenChangeAnnouncement({ name: ROUTE_NAMES[route], overHome: route !== "home" }, reader);
  // Only a loaded read says anything about what is due. A read in flight or a
  // read that failed leaves the device's reminders where they are.
  const reminders = useReminders(
    state.status === "loaded" ? state.challenge : undefined,
    reminderNotifier,
  );
  // What this device is still holding. Home is where someone who walked with no
  // signal comes back to, so it has to be able to say that the walk exists and
  // has not been counted yet.
  const unsent = useUnsentWork(
    runtime,
    state.status === "loaded" ? (state.challenge?.currentTask?.id ?? null) : null,
  );
  // A phone picked up the next morning is showing last night's answer: which
  // task is open, when it is due, whether the recovery offer has expired. Home
  // asks again on every return, and only while it is the screen in front of the
  // user - a re-read landing under the task screen or the form would take it
  // away mid-use.
  useAppReturn(
    () => {
      refresh();
      // Motion access is turned on in a settings page the app is not in front
      // of, so coming back is the one moment the answer is worth asking for
      // again - and the moment the user expects the warning they just acted on
      // to be gone.
      movement.recheck();
    },
    {
      enabled: route === "home",
      ...(appReturn === undefined ? {} : { trigger: appReturn }),
    },
  );
  // Android's back gesture, answered with whatever that screen's own "Back to
  // home" control does. Home itself is the top of the app and keeps the
  // operating system's own answer, which is to close it.
  useBackPress(
    () => {
      if (route === "timeZone") {
        // Backing out of the offer is declining it, the same as the link does;
        // otherwise the banner that sent the user here would be waiting for
        // them when they arrive back on home.
        setKeptTimeZone(true);
        goHome(false);
        return;
      }
      // The form is left with a re-read because leaving an authorized hold
      // might have changed the account, and home cannot tell from out here
      // which half of the form the press came from. A spinner on the way back
      // is the cheaper mistake than a home screen offering to start a second
      // challenge the server would refuse.
      goHome(route === "task" || route === "create");
    },
    {
      enabled: route !== "home",
      ...(backPress === undefined ? {} : { trigger: backPress }),
    },
  );
  // A tapped alarm names what it was asking for, but not whether that is still
  // there: the tap may have launched the app, in which case the challenge has
  // not been read yet. It is held until there is an answer to check it against.
  const [tapped, setTapped] = useState<ReminderTarget | null>(null);
  useReminderTaps(setTapped, {
    ...(reminderTaps === undefined ? {} : { trigger: reminderTaps }),
  });
  const loaded = state.status === "loaded" ? state.challenge : undefined;
  useEffect(() => {
    if (tapped === null || loaded === undefined) {
      return;
    }
    setTapped(null);
    const destination = tapDestination(tapped, loaded);
    // Home is where the app already is, so a tap whose subject has gone leaves
    // the user looking at what is true instead of at an empty screen.
    if (destination !== "home") {
      setRoute(destination === "walk" ? "task" : "recovery");
    }
  }, [tapped, loaded]);
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
        {...(now === undefined ? {} : { now })}
        {...(paymentSheet === undefined ? {} : { paymentSheet })}
        movementDevice={device}
        settings={settingsLauncher}
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
    // With no challenge read there is no current task to belong to, so every
    // record the device holds counts as waiting here.
    const held = heldWalksText(unsent.earlierWaiting);
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
        {held === null ? null : (
          <Banner tone="info">
            <AppText variant="small" testID="home-error-held-walks">
              {held}
            </AppText>
          </Banner>
        )}
        <Button testID="home-retry" label="Try again" onPress={reload} style={styles.wide} />
        <SignOut
          onSignOut={onSignOut}
          challenge={null}
          challengeUnknown
          heldWalks={unsent.earlierWaiting}
        />
      </Screen>
    );
  }

  if (route === "delete") {
    return (
      <DeleteAccountScreen
        api={api}
        challenge={state.challenge}
        onBack={() => goHome(false)}
        // The two screens that can settle a challenge holding up deletion, so
        // the explanation of the hold leads somewhere rather than sending the
        // user back to home to find them.
        onOpenPause={() => setRoute("pause")}
        onOpenRecovery={() => setRoute("recovery")}
        // Nothing is left to read: the account this screen was reading is gone,
        // so the only honest next screen is the signed-out one - and it has to
        // say a deletion happened rather than showing the first-launch pitch.
        onDeleted={() => void onAccountDeleted()}
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
          settings={settingsLauncher}
          onBack={() => goHome(true)}
          onFinished={() => setFinished(succeededSummary(open, clock))}
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
          {...(now === undefined ? {} : { now })}
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
    // Pulling down is what a user does to a screen of this morning's facts, and
    // it goes down the same quiet path as the footer's button and the app
    // coming back to the front: the numbers stay on screen while it runs.
    <Screen testID="home" onRefresh={refresh} refreshing={refreshing}>
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
        {/* A re-read that did not come back. Said quietly, under the title,
            because nothing here is broken - it is the last answer, and the
            user needs to know it is the last one rather than this morning's. */}
        {refreshFailed ? (
          <AppText variant="small" tone="warning" testID="home-refresh-failed">
            Could not reach BetterWakeUp just now, so this is your last connection's answer.
          </AppText>
        ) : null}
      </View>

      <SessionExpiryNotice
        expiry={expiry}
        onSignOut={onSignOut}
        challenge={state.challenge}
        heldWalks={unsent.earlierWaiting + (unsent.currentTask === "waiting" ? 1 : 0)}
      />

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
            timeZone={here}
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
          movement={movement}
          settings={openSettings}
          unsent={unsent}
          recovery={recoveryWindow(state.challenge, clock)}
          now={clock}
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
        {/* Asking by hand goes down the same quiet path as a return: pressing
            Refresh used to replace everything on screen with a spinner, which
            hid the very numbers the press was checking. */}
        <TextButton
          testID="home-refresh"
          label={refreshing ? "Checking for updates" : "Refresh"}
          disabled={refreshing}
          onPress={refresh}
        />
        <SignOut
          onSignOut={onSignOut}
          challenge={state.challenge}
          heldWalks={unsent.earlierWaiting + (unsent.currentTask === "waiting" ? 1 : 0)}
        />
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
  movement,
  settings,
  unsent,
  recovery,
  now,
  timeZoneMove,
  onOpenTask,
  onOpenPause,
  onOpenRecovery,
  onOpenTimeZone,
  onOpenPaymentMethod,
}: {
  challenge: ChallengeView;
  reminders: RemindersState;
  movement: MovementReadinessState;
  settings: OpenSettingsState;
  unsent: UnsentWork;
  recovery: RecoveryWindow | null;
  now: Date;
  timeZoneMove: TimeZoneMove | null;
  onOpenTask: () => void;
  onOpenPause: () => void;
  onOpenRecovery: () => void;
  onOpenTimeZone: () => void;
  onOpenPaymentMethod: () => void;
}) {
  const paused = challenge.pause.pausedAt !== null;
  // How long the pause has stood and how close it is to the year that closes
  // the challenge. Read here as well as on the pause screen, because a pause
  // ends only when its owner ends it and home is the only screen they open.
  const pause = pausePresentation({ challenge, now });
  const { progress, configuration, currentTask } = challenge;
  // How much of this morning is left. Home is the screen most people open
  // first, and a deadline stated as "7:00 AM" alone leaves the reader to work
  // out whether that is hours away or eight minutes.
  const left = currentTask === null ? null : timeLeftUntil(currentTask.deadline, now);
  const deadlineTime =
    currentTask === null ? "" : formatTimeOfDay(currentTask.deadline, configuration.timeZone);
  // Where the open task stands against the day it is now. The moment a morning
  // is kept the server's open task is the next morning's, and a walk taken for
  // it tonight is refused, so the card asks for nothing until its day starts.
  const walk = walkWindow(challenge, now);
  const opensLater = walk?.opensLater === true;
  // Past the deadline nothing walked now can count, so the card stops asking
  // for a walk and says what happened instead.
  const morningGone = left !== null && left.urgency === "expired";
  // Why a walk this phone is holding has not landed. Without it the card
  // blames the signal for every delay, including the two the server itself
  // asked for.
  const waiting = unsent.currentPending === null ? null : waitingReading(unsent.currentPending);
  const attempts = unsent.currentPending === null ? null : attemptsText(unsent.currentPending);
  // A walk already saved here is on a different clock from the one above: it
  // has until the deadline plus the server's receipt grace to arrive, and the
  // morning's "left to walk" countdown is the wrong sentence for someone who
  // has already walked.
  const receipt =
    currentTask === null || unsent.currentTask !== "waiting"
      ? null
      : receiptWindow(currentTask.deadline, configuration.timeZone, now);
  // What one missed morning would do, which turns on the deposit and on an
  // allowance only the server can speak for.
  const miss = missCost(challenge);
  const history = challengeHistory(challenge);
  const streak = streakSentence(history);
  // How long this has been going, which the kept-morning count cannot say on
  // any schedule that skips days of the week.
  const age = challengeAge(challenge, now);
  const remaining = Math.max(
    0,
    progress.requiredTaskCount -
      progress.completedTaskCount -
      progress.skippedTaskCount -
      progress.forgivenTaskCount,
  );

  return (
    <View style={styles.stack}>
      {/* Whether the phone can still settle a morning. Above the walk itself,
          because a walk this phone cannot count is not a smaller version of a
          walk - it is nothing at all, and the fix lives in a settings page that
          takes a moment to reach. */}
      <StepCounter challenge={challenge} movement={movement} settings={settings} />

      {/* Today's task is the reason the screen exists, so it is its own card
          above the challenge's numbers rather than a row buried inside them. */}
      {/* A morning that has already been kept. The row of days marks it with a
          square, and until now that square was the whole of what home said
          about the thing the user got out of bed for - the card above simply
          moved on to asking for the next one. */}
      {walk?.walkedToday === true && opensLater ? (
        <Banner tone="success" testID="home-walked-today">
          <AppText variant="headline" tone="success" testID="home-walked-today-text">
            {walkedTodayText(history.streak)}
          </AppText>
        </Banner>
      ) : null}

      {currentTask === null ? null : (
        <Card testID="home-current-task" style={styles.taskCard}>
          <AppText variant="caption" tone="accent">
            {opensLater ? "YOUR NEXT WALK" : "TODAY'S WALK"}
          </AppText>
          <AppText variant="title">{formatDay(currentTask.date)}</AppText>
          <AppText variant="small" tone="muted" testID="home-task-deadline">
            Deadline {formatDeadline(currentTask.deadline, configuration.timeZone)}
          </AppText>
          {/* The clock, under the deadline it counts to: quiet while the
              morning is long, amber from the moment the alarm would have gone
              off, and silent once the deadline is behind - what is left to say
              then is said in place of the step target below. It is silent on a
              walk whose day has not started too: counting down twenty hours to
              a morning nobody is being asked about yet is noise. */}
          {receipt !== null ? (
            <AppText
              variant="small"
              tone={
                receipt.urgency === "gone"
                  ? "danger"
                  : receipt.urgency === "closing"
                    ? "warning"
                    : "muted"
              }
              testID="home-task-receipt-left"
            >
              {receipt.sentence}
            </AppText>
          ) : left === null || morningGone || opensLater ? null : (
            <AppText
              variant="small"
              tone={left.urgency === "closing" ? "warning" : "muted"}
              testID="home-task-time-left"
            >
              {left.sentence}
            </AppText>
          )}
          {/* What this device is holding for today, in place of the step
              target: someone who has already walked is asking a different
              question, and the target is no longer the answer to it. */}
          {unsent.currentTask === "waiting" ? (
            <>
              <AppText variant="small" tone="warning" testID="home-task-waiting">
                {receipt?.urgency === "gone"
                  ? `Walked and saved on this phone. ${receiptGoneText(receipt.closesAt)}`
                  : morningGone
                    ? unsentPastDeadlineText(deadlineTime)
                    : `Walked and saved on this phone. It still has to reach the server before the deadline. ${waiting?.advice ?? ""}`.trim()}
              </AppText>
              {/* Why it has not landed. Worth saying even once the deadline
                  has gone by: the walk is still being sent, and what is
                  holding it up is the difference between a phone to move and
                  a server to wait for. */}
              {waiting?.reason == null ? null : (
                <AppText variant="small" tone="muted" testID="home-task-waiting-reason">
                  {waiting.reason}
                  {attempts === null ? "" : ` ${attempts}`}
                </AppText>
              )}
            </>
          ) : unsent.currentTask === "refused" ? (
            <AppText
              variant="small"
              tone="danger"
              testID="home-task-refused"
              accessibilityRole="alert"
            >
              The server would not take today's walk. Open it to see why.
            </AppText>
          ) : morningGone ? (
            <AppText
              variant="small"
              tone="danger"
              testID="home-task-morning-gone"
              accessibilityRole="alert"
            >
              {morningGoneText(deadlineTime)}
            </AppText>
          ) : walk !== null && opensLater ? (
            <AppText variant="small" tone="muted" testID="home-task-opens">
              {walkOpensText(walk, formatDay(currentTask.date), deadlineTime)}
            </AppText>
          ) : (
            <AppText variant="small" tone="muted">
              {configuration.stepTarget} steps to keep the day.
            </AppText>
          )}
          {/* No way in until the day it belongs to starts. The task screen
              would offer a walk whose completion the server refuses for being
              outside the task's own window, which is the same reason the
              invitation is withdrawn once the deadline has gone by. */}
          {opensLater ? null : (
            <Button
              testID="home-open-task"
              label={taskButtonLabel(unsent.currentTask, morningGone)}
              onPress={onOpenTask}
            />
          )}
        </Card>
      )}

      {/* A pause standing still. The status pill in the card below says the
          word, and the word alone is easy to read as a state the app is
          managing - it is not. Nothing is due, nothing will ring, and no day
          passes until the user comes back here and resumes, so the way to do
          that is the button in this banner rather than a quiet link under the
          challenge's numbers. */}
      {paused && challenge.status === "active" ? (
        <Banner tone={pause.expiryWarning ? "danger" : "warning"} testID="home-paused">
          <AppText variant="headline" testID="home-paused-days">
            {pausedForSentence(pause.pausedDays)}
          </AppText>
          <AppText variant="small" tone="muted" testID="home-paused-explainer">
            {pausedRestSentence(currentTask !== null)}
          </AppText>
          {pause.expiryWarning && pause.daysUntilExpiry !== null ? (
            <AppText
              variant="small"
              tone="danger"
              accessibilityRole="alert"
              testID="home-pause-expiry"
            >
              {pauseExpirySentence(pause.daysUntilExpiry)}
            </AppText>
          ) : null}
          <Button testID="home-open-pause" label="Resume the challenge" onPress={onOpenPause} />
        </Banner>
      ) : null}

      {/* A walk from an earlier day that the server never took. Nothing to
          press: sync retries it on every trigger, and saying so is the point -
          the day is not lost work sitting unnoticed on the phone. */}
      {unsent.earlierWaiting === 0 ? null : (
        <AppText variant="small" tone="warning" testID="home-earlier-unsent">
          {unsent.earlierWaiting === 1
            ? "An earlier walk is still waiting to reach the server. It sends itself as soon as you are online."
            : `${unsent.earlierWaiting} earlier walks are still waiting to reach the server. They send themselves as soon as you are online.`}
        </AppText>
      )}

      <Reminders challenge={challenge} reminders={reminders} settings={settings} />

      {/* The offer that decides whether the deposit is charged. It leads with
          how long is left rather than with when it closes, turns red inside the
          last hour, and once the window has gone by it stops offering a
          decision the server would refuse and says what happened instead. */}
      {challenge.recoveryOffer === null || recovery === null ? null : (
        <Banner
          tone={recovery.urgency === "open" ? "warning" : "danger"}
          testID="home-recovery-offer"
        >
          <AppText
            variant="small"
            tone={recovery.urgency === "open" ? "warning" : "danger"}
            accessibilityRole="alert"
            testID="home-recovery-summary"
          >
            {recoveryOfferSummary(
              recovery,
              formatDeadline(challenge.recoveryOffer.expiresAt, configuration.timeZone),
            )}
          </AppText>
          {recovery.decidable ? (
            <Button
              testID="home-open-recovery"
              label="Decide on your recovery"
              onPress={onOpenRecovery}
            />
          ) : null}
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

          {/* The month as a shape: which mornings were kept, which one broke a
              run, and how many are still ahead. A challenge that has not been
              materialized yet holds no days and draws no row. */}
          {history.days.length === 0 ? null : (
            <View style={styles.historyBlock}>
              <DayStrip
                testID="home-day-strip"
                accessibilityLabel={historyLabel(history)}
                days={history.days.map((day) => dayMarkFor(day.state))}
              />
              {/* Which square is which. The row is otherwise colour alone, and
                  the two colours it leans on hardest - a kept morning and a
                  missed one - are the pair most commonly seen as one. */}
              <DayLegend
                testID="home-day-legend"
                items={historyLegend(history).map((entry) => ({
                  mark: dayMarkFor(entry.state),
                  label: entry.label,
                }))}
              />
              {streak === null ? null : (
                <AppText variant="caption" tone="accent" testID="home-streak">
                  {streak}
                </AppText>
              )}
            </View>
          )}
        </View>

        {currentTask === null ? (
          <AppText variant="caption" tone="muted" testID="home-no-task">
            {paused
              ? "Nothing is due while this challenge is paused."
              : nextMorningText(
                  nextActiveMorning(configuration.schedule, now, configuration.timeZone),
                )}
          </AppText>
        ) : null}

        <Divider />

        {/* The schedule cannot be edited once the challenge exists, so the only
            thing left to do about it is say it. Nothing past the setup form
            showed the days or the times, which left "which mornings am I on the
            hook for?" unanswerable between tasks. */}
        <AppText variant="caption" tone="muted">
          YOUR MORNINGS
        </AppText>
        <View testID="home-schedule">
          {scheduleGroups(configuration.schedule).map((group) => (
            <DetailRow key={group.days} label={group.days} value={group.time} />
          ))}
        </View>
        <DetailRow
          label="Read in"
          value={timeZoneLabel(configuration.timeZone)}
          testID="home-schedule-zone"
        />

        <Divider />

        {/* When it started, so the end date has something to be measured from.
            The kept-morning count above is not a measure of time: five mornings
            on a Monday/Wednesday/Friday challenge is a fortnight, and nothing
            on the card let a reader tell the two apart. */}
        {age === null ? null : (
          <DetailRow label="Started" value={age.startedOn} testID="home-started" />
        )}
        <DetailRow
          label="Projected end"
          value={formatDay(challenge.projectedEndDate)}
          testID="home-end-date"
        />
        {age === null ? null : (
          <AppText variant="caption" tone="muted" testID="home-challenge-day">
            {age.dayText}
          </AppText>
        )}
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

        {/* What a miss would cost, said before one happens. The terms state it
            once at setup and never again, so whether the safety net is still
            there - the fact that decides whether tomorrow is recoverable - was
            unreadable for the whole month it matters in. */}
        {miss === null ? null : (
          <View style={styles.missCost}>
            <AppText variant="caption" tone="muted">
              IF YOU MISS A MORNING
            </AppText>
            <AppText variant="small" tone={miss.tone} testID="home-miss-cost">
              {miss.text}
            </AppText>
          </View>
        )}

        {/* Pausing belongs to a challenge that can still run. A finished one has
            nothing to pause, and offering it would be a press the server refuses.
            A paused one is resumed from the banner above instead, where the
            reason to press it is on screen beside the button. */}
        {challenge.status === "active" && !paused ? (
          <TextButton
            testID="home-open-pause"
            tone="accent"
            label="Pause the challenge"
            onPress={onOpenPause}
          />
        ) : null}
      </Card>
    </View>
  );
}

/**
 * What the way into today's task is called.
 *
 * A walk this device is holding is opened to see it, and a morning that has
 * gone by is opened to read what happened - "Open today's task" would be
 * inviting a walk the server has already stopped being able to accept.
 */
function taskButtonLabel(held: UnsentWork["currentTask"], morningGone: boolean): string {
  if (held !== "none") {
    return "See today's walk";
  }
  return morningGone ? "See what happened" : "Open today's task";
}

/**
 * Whether this phone can still count the walk the challenge is settled by.
 *
 * The setup screen asks the same question before any money is staked. What it
 * cannot cover is everything after: motion access is revoked in a settings page
 * the app never sees, an operating system update can reset it, and the account
 * can be signed into on a second phone with no step counter at all. Every one
 * of those left the app saying nothing until the press of "Start the walk", on
 * a morning that was already running with a deposit behind it.
 *
 * A terminal challenge is left alone - there is no morning left to settle - but
 * a paused one is not, because a pause ends when its owner ends it and the
 * first morning back should not be the first they hear of this.
 */
function StepCounter({
  challenge,
  movement,
  settings,
}: {
  challenge: ChallengeView;
  movement: MovementReadinessState;
  settings: OpenSettingsState;
}) {
  const notice = runningMovementNotice(movement.readiness);
  if (
    notice === null ||
    (challenge.status !== "active" && challenge.status !== "recovery_pending")
  ) {
    return null;
  }

  return (
    <Banner tone={notice.tone} testID="home-movement">
      <AppText
        variant="small"
        tone={notice.tone === "info" ? "muted" : notice.tone}
        accessibilityRole="alert"
        testID="home-movement-text"
      >
        {notice.text}
      </AppText>
      {/* The app can ask for motion access itself exactly once. After that only
          the settings page answers, which is why a refused phone gets a link
          out rather than a button that would do nothing. */}
      {movement.readiness === "askable" ? (
        <Button
          testID="home-allow-movement"
          label={ALLOW_MOVEMENT_LABEL}
          busy={movement.asking}
          onPress={movement.ask}
        />
      ) : null}
      {movement.readiness === "refused" ? (
        <OpenSettingsAction testID="home-movement-settings" settings={settings} tone="muted" />
      ) : null}
    </Banner>
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
  settings,
}: {
  challenge: ChallengeView;
  reminders: RemindersState;
  settings: OpenSettingsState;
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
      <Banner tone="info" testID="home-reminders-denied-banner">
        <AppText variant="small" tone="muted" testID="home-reminders-denied">
          Reminders are off. Turn on notifications for BetterWakeUp in your device settings and you
          will be nudged before each walk.
        </AppText>
        <OpenSettingsAction testID="home-reminders-settings" settings={settings} tone="muted" />
      </Banner>
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
  timeZone,
  onStartAnother,
  onDismiss,
}: {
  ended: EndedChallengeSummary;
  timeZone: string;
  onStartAnother: () => void;
  onDismiss: () => void;
}) {
  const pill = ENDED_PILL[ended.status];
  const reading = endedReading(ended, timeZone);
  return (
    <Card testID="home-finished">
      <StatusPill testID="home-finished-status" label={pill.label} tone={pill.tone} />
      {/* When it happened. A sweep decides a failure and an expiry, so the
          first thing anyone opening this card wants is which morning it was -
          above all the reader who woke up late and is asking whether it was
          this one. */}
      <AppText variant="small" tone="muted" testID="home-finished-when">
        {reading.when}
      </AppText>
      <AppText variant="display" testID="home-finished-days">
        {endedDaysCount(ended)}
        <AppText variant="headline" tone="muted">
          {endedDaysSuffix(ended)}
        </AppText>
      </AppText>
      {/* What ended it. The pill names the outcome and the count names the
          score, and neither says what the app did - a failure otherwise reads
          as a verdict with the charge left off. */}
      <AppText variant="small" tone="muted" testID="home-finished-cause">
        {reading.cause}
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
function succeededSummary(challenge: ChallengeView, endedAt: Date): EndedChallengeSummary {
  const { configuration } = challenge;
  return {
    id: challenge.id,
    status: "succeeded",
    endedAt: endedAt.toISOString(),
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
  settings,
  onBack,
  onFinished,
}: {
  challenge: ChallengeView;
  runtime: CompletionRuntimeState;
  settings: SettingsLauncher;
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
      settings={settings}
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

/**
 * The sign-in about to run out, and the press that gets ahead of it.
 *
 * It sits at the top of home rather than among the account controls because it
 * is news with a date on it, not a setting. The press signs out, which is the
 * opposite of what the label promises until the confirmation explains that
 * signing back in is what it is for: there is no endpoint that renews a
 * session, so the only way to a fresh one is through the sign-in screen.
 *
 * With no `onSignOut` there is nowhere to send the user, so the warning still
 * appears - it is true either way - and simply carries no press.
 */
function SessionExpiryNotice({
  expiry,
  onSignOut,
  challenge,
  heldWalks,
}: {
  expiry: SessionExpiry | null;
  onSignOut: (() => void) | undefined;
  challenge: ChallengeView | null;
  heldWalks: number;
}): ReactNode {
  if (expiry === null) {
    return null;
  }
  return (
    <Banner tone={expiry.urgency === "gone" ? "danger" : "warning"} testID="home-session-expiry">
      <AppText
        variant="small"
        tone={expiry.urgency === "gone" ? "danger" : "warning"}
        accessibilityRole="alert"
        testID="home-session-expiry-when"
      >
        {sessionExpiryText(expiry)}
      </AppText>
      <AppText variant="small" testID="home-session-expiry-renewal">
        {SESSION_RENEWAL_TEXT}
      </AppText>
      {onSignOut === undefined ? null : (
        <ConfirmAction
          testID="home-session-renew"
          label={SESSION_RENEW_LABEL}
          consequence={sessionRenewalConsequence(signOutConsequence({ challenge, heldWalks }))}
          confirmLabel={SESSION_RENEW_CONFIRM_LABEL}
          cancelLabel={SESSION_RENEW_CANCEL_LABEL}
          onConfirm={onSignOut}
        />
      )}
    </Banner>
  );
}

/**
 * The sign-out press, guarded by what it would cost.
 *
 * Signing out is the one control on home that can lose a deposit - the
 * challenge carries on without the phone and the alarms stop - so it asks
 * before it acts, and only where there is something to ask about: with nothing
 * running and nothing held on the phone the press is what it looks like, and a
 * confirmation over it would be ceremony.
 */
function SignOut({
  onSignOut,
  challenge,
  heldWalks,
  challengeUnknown = false,
}: {
  onSignOut: (() => void) | undefined;
  challenge?: ChallengeView | null;
  heldWalks?: number;
  challengeUnknown?: boolean;
}): ReactNode {
  if (onSignOut === undefined) {
    return null;
  }
  const consequence = signOutConsequence({
    challenge: challenge ?? null,
    heldWalks: heldWalks ?? 0,
    challengeUnknown,
  });
  if (consequence === null) {
    return <TextButton testID="home-sign-out" label="Sign out" onPress={onSignOut} />;
  }
  return (
    <ConfirmAction
      testID="home-sign-out"
      quiet
      label="Sign out"
      consequence={consequence}
      confirmLabel={SIGN_OUT_CONFIRM_LABEL}
      cancelLabel={SIGN_OUT_CANCEL_LABEL}
      onConfirm={onSignOut}
    />
  );
}

const styles = StyleSheet.create({
  header: { gap: 4 },
  stack: { gap: 16 },
  footer: { gap: 4, paddingTop: 8 },
  wide: { alignSelf: "stretch" },
  taskCard: { gap: 8 },
  statusRow: { flexDirection: "row" },
  progressBlock: { gap: 10 },
  historyBlock: { gap: 8, paddingTop: 2 },
  missCost: { gap: 4, paddingTop: 4 },
});
