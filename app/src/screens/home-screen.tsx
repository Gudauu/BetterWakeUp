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

import type { ChallengeView, EndedChallengeSummary, TaskView } from "@betterwakeup/contract";
import { type ReactNode, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { type AppReturnTrigger, useAppReturn } from "../challenges/app-return.ts";
import { useCurrentChallenge } from "../challenges/current-challenge.ts";
import { detectTimeZone, formatMoney } from "../challenges/draft.ts";
import { endedReading } from "../challenges/ended-challenge.ts";
import { challengeHistory } from "../challenges/history.ts";
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
import { nextActiveMorning, nextMorningText } from "../challenges/schedule.ts";
import { type TimeZoneMove, timeZoneLabel, timeZoneMoveFor } from "../challenges/time-zone.ts";
import { walkedTodayText, walkWindow } from "../challenges/walk-window.ts";
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
import { createConfiguredNotifier, type Notifier, useReminders } from "../reminders/notifier.ts";
import {
  type ReminderTapTrigger,
  tapDestination,
  useReminderTaps,
} from "../reminders/reminder-taps.ts";
import type { ReminderTarget } from "../reminders/reminders.ts";
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
import { signOutConsequence } from "../session/sign-out.ts";
import { useClock } from "../ui/clock.ts";
import {
  AppText,
  Banner,
  Button,
  Card,
  ProgressBar,
  Screen,
  StatusPill,
  TextButton,
} from "../ui/components.tsx";
import {
  formatCountdown,
  formatDay,
  formatDeadline,
  formatDuration,
  formatTimeOfDay,
} from "../ui/format.ts";
import {
  createConfiguredScreenReader,
  type ScreenReader,
  useScreenChangeAnnouncement,
} from "../ui/screen-change.ts";
import { useTheme } from "../ui/theme.ts";
import { AccountScreen, SignOutAction } from "./account-section.tsx";
import { ChallengeDetailsScreen } from "./challenge-details-screen.tsx";
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
 * Where the user is. Home keeps its own stack of these, top last: everything
 * it opens returns to the screen underneath, so a pause opened from the
 * challenge page lands back on the challenge page rather than on home.
 */
type Route =
  | "home"
  | "details"
  | "account"
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
  details: "Your challenge",
  account: "Account",
  create: "Set up a challenge",
  task: "Today's walk",
  pause: "Pause or resume",
  recovery: "Emergency Recovery",
  delete: "Delete your account",
  timeZone: "Your time zone",
  paymentMethod: "Your card",
};

/**
 * Whether a screen can still be drawn from what the last read said. Every
 * screen about the running challenge needs one, and two need more: the time
 * zone offer needs the device to disagree with the challenge's zone, and the
 * card screen needs a deposit no card secures. The rest - the form, the account
 * page, deletion - stand on the account alone.
 */
function routeDrawable(route: Route, challenge: ChallengeView | null, here: string): boolean {
  switch (route) {
    case "details":
    case "task":
    case "pause":
    case "recovery":
      return challenge !== null;
    case "timeZone":
      return challenge !== null && timeZoneMoveFor(challenge, here) !== null;
    case "paymentMethod":
      return challenge !== null && needsPaymentMethod(challenge);
    case "home":
    case "account":
    case "create":
    case "delete":
      return true;
  }
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
  // The same clock as a function, for the reminders to read at the moment they
  // schedule. Held once so the scheduling effect is not re-run by a new arrow.
  const [readClock] = useState<() => Date>(() => now ?? (() => new Date()));
  const theme = useTheme();
  const { state, refreshing, refreshFailed, reload, refresh } = useCurrentChallenge(api);
  const [storedStack, setStack] = useState<readonly Route[]>([]);
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
  // A read can take away what a screen on the stack was drawn from: a
  // challenge that ended while its page was open, a deposit that no longer
  // needs a card, a device that moved back into the challenge's zone. Such a
  // screen is dropped rather than left under home, where it would swallow a
  // back press and keep the screen reader naming a page nobody can see.
  const loadedChallenge = state.status === "loaded" ? state.challenge : undefined;
  const drawable = (candidate: Route) =>
    loadedChallenge === undefined || routeDrawable(candidate, loadedChallenge, here);
  const stack = storedStack.filter(drawable);
  const route: Route = stack[stack.length - 1] ?? "home";
  const openRoute = (next: Route) => setStack((current) => [...current.filter(drawable), next]);
  // Held pruned as well, so a later read that brings a challenge back does not
  // bring back a page the user was never returned to.
  useEffect(() => {
    if (stack.length !== storedStack.length) {
      setStack(stack);
    }
  });
  // The sign-in itself is on a clock, and the app used to read it only at
  // launch: a session that ran out mid-challenge threw the user onto the
  // signed-out screen with no notice, on whichever morning the thirtieth day
  // turned out to be. Read here against the same ticking clock as the morning,
  // so the warning arrives while there is still time to act on it.
  const expiry = session.status === "signedIn" ? sessionExpiry(session.session, clock, here) : null;
  // The way back from everything home opens, one screen at a time. A command
  // that changed the challenge reads it again from here rather than while its
  // screen is still up: `reload` puts home into its loading state, which would
  // pull that screen out from under the user mid-use.
  const goBack = (changed: boolean) => {
    setStack((current) => current.filter(drawable).slice(0, -1));
    if (changed) {
      reload();
    }
  };
  // Held for as long as home is on screen rather than only while the task is
  // open: opening it is what sends a completion recorded on a day with no
  // network, and that must not wait for the user to tap anything.
  // Which account's walks the phone is holding. Home is only ever rendered
  // under a signed-in session, so the null is a type's answer rather than a
  // state a user reaches - but it is the honest one: with nobody signed in
  // there is no account to open a store for.
  const walkOwner = session.status === "signedIn" ? session.session.accountId : null;
  const runtime = useCompletionRuntime(
    api,
    walkOwner,
    createRuntime ?? createConfiguredCompletionRuntime,
  );
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
    readClock,
  );
  // What this device is still holding. Home is where someone who walked with no
  // signal comes back to, so it has to be able to say that the walk exists and
  // has not been counted yet.
  const unsent = useUnsentWork(
    runtime,
    state.status === "loaded" ? (state.challenge?.currentTask?.id ?? null) : null,
  );
  // Every walk the phone is holding, which is what signing out would strand.
  const heldWalks = unsent.earlierWaiting + (unsent.currentTask === "waiting" ? 1 : 0);
  // A phone picked up the next morning is showing last night's answer: which
  // task is open, when it is due, whether the recovery offer has expired. Home
  // asks again on every return, and only while it is the screen in front of the
  // user or the challenge page it opened - a re-read landing under the task
  // screen or the form would take it away mid-use.
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
      enabled: route === "home" || route === "details" || route === "account",
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
        goBack(false);
        return;
      }
      // The form is left with a re-read because leaving an authorized hold
      // might have changed the account, and home cannot tell from out here
      // which half of the form the press came from. A spinner on the way back
      // is the cheaper mistake than a home screen offering to start a second
      // challenge the server would refuse.
      goBack(route === "task" || route === "create");
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
      setStack([destination === "walk" ? "task" : "recovery"]);
    }
  }, [tapped, loaded]);
  // Opening the form retires the finish: whatever comes back from it, the last
  // challenge is no longer the thing the screen is about.
  const openCreate = (endedId?: string) => {
    setFinished(null);
    if (endedId !== undefined) {
      setDismissed(endedId);
    }
    openRoute("create");
  };

  if (route === "create") {
    return (
      <CreateChallengeScreen
        // Leaving the form changes nothing, but leaving an authorized hold
        // might: the challenge appears when the provider confirms it, which can
        // land after the user has stopped watching for it.
        onCancel={(accountChanged) => goBack(accountChanged)}
        // The server is the record of what exists, so the new challenge is read
        // back rather than trusted from the response the form held.
        onCreated={() => goBack(true)}
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
        {/* A spinner on its own says only that something is happening. The
            client now stops waiting after REQUEST_TIMEOUT_MS, so this state is
            bounded - but for as long as it is on screen it should name what is
            being waited for, because it is the whole app to the person holding
            the phone on the morning of a deadline. */}
        <AppText variant="small" tone="muted" testID="home-loading-message">
          Reading your challenge from BetterWakeUp.
        </AppText>
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
        <SignOutAction
          testID="home-sign-out"
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
        onBack={() => goBack(false)}
        // The two screens that can settle a challenge holding up deletion, so
        // the explanation of the hold leads somewhere rather than sending the
        // user back to home to find them.
        onOpenPause={() => openRoute("pause")}
        onOpenRecovery={() => openRoute("recovery")}
        // Nothing is left to read: the account this screen was reading is gone,
        // so the only honest next screen is the signed-out one - and it has to
        // say a deletion happened rather than showing the first-launch pitch.
        onDeleted={() => void onAccountDeleted()}
      />
    );
  }

  if (route === "account") {
    return (
      <AccountScreen
        onBack={() => goBack(false)}
        onSignOut={onSignOut}
        onDeleteAccount={() => openRoute("delete")}
        heldWalks={heldWalks}
      />
    );
  }

  if (state.challenge !== null) {
    const open = state.challenge;
    if (route === "details") {
      return (
        <ChallengeDetailsScreen
          challenge={open}
          reminders={reminders}
          settings={openSettings}
          onBack={() => goBack(false)}
          onOpenPause={() => openRoute("pause")}
          onSignOut={onSignOut}
          onDeleteAccount={() => openRoute("delete")}
          heldWalks={heldWalks}
        />
      );
    }
    if (route === "task") {
      return (
        <TodayTask
          challenge={open}
          runtime={runtime}
          settings={settingsLauncher}
          {...(now === undefined ? {} : { now })}
          onBack={() => goBack(true)}
          onFinished={() => setFinished(succeededSummary(open, clock))}
        />
      );
    }
    if (route === "pause") {
      return (
        <PauseScreen
          api={api}
          challenge={state.challenge}
          onBack={() => goBack(false)}
          onChanged={() => goBack(true)}
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
            onChanged={() => goBack(true)}
            onBack={() => {
              setKeptTimeZone(true);
              goBack(false);
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
          onSecured={() => goBack(true)}
          onBack={() => goBack(false)}
        />
      );
    }
    if (route === "recovery") {
      return (
        <RecoveryScreen
          api={api}
          challenge={state.challenge}
          {...(now === undefined ? {} : { now })}
          onBack={() => goBack(false)}
          onAccepted={() => goBack(true)}
          // Declining spends nothing and changes nothing at the server, so
          // there is nothing to read back.
          onDeclined={() => goBack(false)}
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
    // it goes down the same quiet path as the Refresh press and the app coming
    // back to the front: the numbers stay on screen while it runs.
    <Screen testID="home" onRefresh={refresh} refreshing={refreshing}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <AppText variant="display" accessibilityRole="header">
            BetterWakeUp
          </AppText>
          {/* With a challenge running the account controls close the challenge
              page. With none there is no challenge page, so home offers them
              here - deletion has to stay reachable whatever the account holds. */}
          {state.challenge === null ? (
            <TextButton
              testID="home-open-account"
              label="Account"
              onPress={() => openRoute("account")}
            />
          ) : null}
        </View>
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
        heldWalks={heldWalks}
      />

      {state.challenge === null ? (
        ended === null ? (
          <Card testID="home-no-challenge">
            <AppText variant="caption" tone="accent">
              READY WHEN YOU ARE
            </AppText>
            <AppText variant="headline">No challenge running</AppText>
            <AppText variant="small" tone="muted">
              Set a wake-up time, walk before the deadline, and keep your deposit.
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
        <HomeChallenge
          challenge={state.challenge}
          movement={movement}
          settings={openSettings}
          unsent={unsent}
          recovery={recoveryWindow(state.challenge, clock)}
          now={clock}
          timeZoneMove={keptTimeZone ? null : timeZoneMoveFor(state.challenge, here)}
          onOpenDetails={() => openRoute("details")}
          onOpenTask={() => openRoute("task")}
          onOpenPause={() => openRoute("pause")}
          onOpenRecovery={() => openRoute("recovery")}
          onOpenTimeZone={() => openRoute("timeZone")}
          onOpenPaymentMethod={() => openRoute("paymentMethod")}
        />
      )}

      {/* Asking by hand, for anyone who will not find the pull: a gesture is
          not discoverable, and it is not a control a screen reader can find.
          It goes down the same quiet path as the pull, so the numbers it is
          checking stay on screen while it runs. */}
      <TextButton
        testID="home-refresh"
        label={refreshing ? "Checking for updates" : "Refresh"}
        disabled={refreshing}
        onPress={refresh}
      />
    </Screen>
  );
}

/**
 * Home with a challenge running: the next walk, the two numbers that say where
 * the challenge stands, and only the notices that ask the user to act. The rest
 * of the challenge is one tap away on its own page.
 */
function HomeChallenge({
  challenge,
  movement,
  settings,
  unsent,
  recovery,
  now,
  timeZoneMove,
  onOpenDetails,
  onOpenTask,
  onOpenPause,
  onOpenRecovery,
  onOpenTimeZone,
  onOpenPaymentMethod,
}: {
  challenge: ChallengeView;
  movement: MovementReadinessState;
  settings: OpenSettingsState;
  unsent: UnsentWork;
  recovery: RecoveryWindow | null;
  now: Date;
  timeZoneMove: TimeZoneMove | null;
  onOpenDetails: () => void;
  onOpenTask: () => void;
  onOpenPause: () => void;
  onOpenRecovery: () => void;
  onOpenTimeZone: () => void;
  onOpenPaymentMethod: () => void;
}) {
  const paused = challenge.pause.pausedAt !== null;
  // How long the pause has stood and how close it is to the year that closes
  // the challenge. Read here as well as on the pause screen, because a pause
  // ends only when its owner ends it and home is the screen they open.
  const pause = pausePresentation({ challenge, now });
  const { configuration, currentTask } = challenge;
  // Where the open task stands against the day it is now. The moment a morning
  // is kept the server's open task is the next morning's.
  const walk = walkWindow(challenge, now);
  const history = challengeHistory(challenge);

  return (
    <View style={styles.stack}>
      {/* Whether the phone can still settle a morning. Above the walk itself,
          because a walk this phone cannot count is not a smaller version of a
          walk - it is nothing at all, and the fix lives in a settings page that
          takes a moment to reach. */}
      <StepCounter challenge={challenge} movement={movement} settings={settings} />

      {/* A morning that has already been kept, said before the card moves on
          to asking for the next one. */}
      {walk?.walkedToday === true && walk.opensLater ? (
        <Banner tone="success" testID="home-walked-today">
          <AppText variant="headline" tone="success" testID="home-walked-today-text">
            {walkedTodayText(history.streak)}
          </AppText>
        </Banner>
      ) : null}

      {currentTask === null ? null : (
        <NextWalkCard
          challenge={challenge}
          task={currentTask}
          opensLater={walk?.opensLater === true}
          opensTomorrow={walk?.opensTomorrow === true}
          unsent={unsent}
          now={now}
          onOpenTask={onOpenTask}
          onOpenDetails={onOpenDetails}
        />
      )}

      {/* A pause standing still. Nothing is due, nothing will ring, and no day
          passes until the user comes back here and resumes, so the way to do
          that is the button in this banner. */}
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

      <ChallengeSummary challenge={challenge} now={now} onOpenDetails={onOpenDetails} />
    </View>
  );
}

/**
 * The next walk: which morning, how long until its deadline, and the way in.
 *
 * The countdown is the largest thing on home because it is the one number that
 * changes what the user does next. It is drawn even for tomorrow's walk, since
 * how long is left until the deadline is worth knowing the night before too.
 */
function NextWalkCard({
  challenge,
  task,
  opensLater,
  opensTomorrow,
  unsent,
  now,
  onOpenTask,
  onOpenDetails,
}: {
  challenge: ChallengeView;
  task: TaskView;
  opensLater: boolean;
  opensTomorrow: boolean;
  unsent: UnsentWork;
  now: Date;
  onOpenTask: () => void;
  onOpenDetails: () => void;
}) {
  const theme = useTheme();
  const { configuration } = challenge;
  const left = timeLeftUntil(task.deadline, now);
  const deadlineTime = formatTimeOfDay(task.deadline, configuration.timeZone);
  // Past the deadline nothing walked now can count, so the card stops asking
  // for a walk and says what happened instead.
  const morningGone = left !== null && left.urgency === "expired";
  const closing = left !== null && left.urgency === "closing" && !opensLater;
  // Why a walk this phone is holding has not landed. Without it the card
  // blames the signal for every delay, including the two the server itself
  // asked for.
  const waiting = unsent.currentPending === null ? null : waitingReading(unsent.currentPending);
  const attempts = unsent.currentPending === null ? null : attemptsText(unsent.currentPending);
  // A walk already saved here is on a different clock: it has until the
  // deadline plus the server's receipt grace to arrive, and the morning's
  // countdown is the wrong number for someone who has already walked.
  const receipt =
    unsent.currentTask !== "waiting"
      ? null
      : receiptWindow(task.deadline, configuration.timeZone, now);

  return (
    <Card
      testID="home-current-task"
      onPress={onOpenDetails}
      style={[
        styles.taskCard,
        closing ? { borderColor: theme.colors.warning, borderWidth: 2 } : null,
      ]}
    >
      <View style={styles.cardHead}>
        <AppText variant="caption" tone="accent">
          {opensLater ? (opensTomorrow ? "NEXT WALK · TOMORROW" : "NEXT WALK") : "TODAY'S WALK"}
        </AppText>
        <AppText variant="caption" tone="muted">
          {configuration.stepTarget} STEPS
        </AppText>
      </View>
      <AppText variant="title">{formatDay(task.date)}</AppText>

      {/* The clock, as big as the screen has: quiet while the morning is
          long, amber from the moment the alarm would have gone off, and gone
          once the deadline is behind - what is left to say then is said below.
          A screen reader hears the words rather than "2h 5m". */}
      {left === null || morningGone || receipt !== null ? null : (
        <View
          accessible
          accessibilityLabel={`${formatDuration(left.minutes)} until the deadline.`}
          testID="home-task-time-left"
        >
          <AppText variant="caption" tone="muted">
            UNTIL THE DEADLINE
          </AppText>
          <AppText variant="display" tone={closing ? "warning" : "default"}>
            {formatCountdown(left.minutes)}
          </AppText>
        </View>
      )}
      {/* The time alone: the day is the card's title just above. */}
      <AppText variant="small" tone="muted" testID="home-task-deadline">
        Deadline {deadlineTime}
      </AppText>

      {receipt === null ? null : (
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
      )}
      {/* What this device is holding for this walk: someone who has already
          walked is asking a different question from someone who has not. */}
      {unsent.currentTask === "waiting" ? (
        <>
          <AppText variant="small" tone="warning" testID="home-task-waiting">
            {receipt?.urgency === "gone"
              ? `Walked and saved on this phone. ${receiptGoneText(receipt.closesAt)}`
              : morningGone
                ? unsentPastDeadlineText(deadlineTime)
                : `Walked and saved on this phone. It still has to reach the server before the deadline. ${waiting?.advice ?? ""}`.trim()}
          </AppText>
          {/* Why it has not landed. Worth saying even once the deadline has
              gone by: the walk is still being sent, and what is holding it up
              is the difference between a phone to move and a server to wait
              for. */}
          {waiting?.reason == null ? null : (
            <AppText variant="small" tone="muted" testID="home-task-waiting-reason">
              {waiting.reason}
              {attempts === null ? "" : ` ${attempts}`}
            </AppText>
          )}
        </>
      ) : unsent.currentTask === "refused" ? (
        <AppText variant="small" tone="danger" testID="home-task-refused" accessibilityRole="alert">
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
      ) : null}

      {/* No way in until the day the walk belongs to starts. The task screen
          would offer a walk whose completion the server refuses for being
          outside the task's own window. */}
      {opensLater ? null : (
        <Button
          testID="home-open-task"
          label={taskButtonLabel(unsent.currentTask, morningGone)}
          onPress={onOpenTask}
        />
      )}
    </Card>
  );
}

/**
 * Where the challenge stands, in two numbers: which walk is next out of the
 * total, and what is at stake. Everything else about it is behind the link.
 */
function ChallengeSummary({
  challenge,
  now,
  onOpenDetails,
}: {
  challenge: ChallengeView;
  now: Date;
  onOpenDetails: () => void;
}) {
  const theme = useTheme();
  const { progress, configuration, currentTask } = challenge;
  const paused = challenge.pause.pausedAt !== null;
  // The walk being asked for, counted the way the server counts toward the
  // total: completed walks only, since a skipped or forgiven day is not one.
  const day = Math.min(progress.completedTaskCount + 1, progress.requiredTaskCount);
  const tile = [styles.tile, { backgroundColor: theme.colors.surfaceMuted }];

  return (
    <Card testID="home-summary" onPress={onOpenDetails}>
      <View style={styles.tiles}>
        <View
          style={tile}
          accessible
          accessibilityLabel={`Day ${day} of ${progress.requiredTaskCount}.`}
          testID="home-day-count"
        >
          <AppText variant="title">
            Day {day}
            <AppText variant="headline" tone="muted">
              {" "}
              / {progress.requiredTaskCount}
            </AppText>
          </AppText>
          <ProgressBar
            done={progress.completedTaskCount}
            total={progress.requiredTaskCount}
            testID="home-progress-bar"
          />
        </View>
        <View style={tile} accessible testID="home-stake">
          <AppText variant="title" tone="accent">
            {configuration.deposit.amount === 0
              ? "None"
              : formatMoney(configuration.deposit.amount)}
          </AppText>
          <AppText variant="caption" tone="muted">
            AT STAKE
          </AppText>
        </View>
      </View>
      {/* With no walk open, when the next one comes. A paused challenge's
          banner already says nothing is due, so it is not said twice. */}
      {currentTask === null && !paused ? (
        <AppText variant="caption" tone="muted" testID="home-no-task">
          {nextMorningText(nextActiveMorning(configuration.schedule, now, configuration.timeZone))}
        </AppText>
      ) : null}
      <TextButton
        testID="home-open-details"
        tone="accent"
        label="Challenge details  ›"
        onPress={onOpenDetails}
      />
    </Card>
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
  now,
  onBack,
  onFinished,
}: {
  challenge: ChallengeView;
  runtime: CompletionRuntimeState;
  settings: SettingsLauncher;
  /** The same clock home reads, so the task screen and home agree on the time. */
  now?: () => Date;
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
      {...(now === undefined ? {} : { now })}
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

const styles = StyleSheet.create({
  header: { gap: 4 },
  titleRow: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  stack: { gap: 16 },
  wide: { alignSelf: "stretch" },
  taskCard: { gap: 8 },
  cardHead: { flexDirection: "row", gap: 8, justifyContent: "space-between" },
  tiles: { flexDirection: "row", gap: 8 },
  tile: { borderRadius: 12, flex: 1, gap: 8, padding: 12 },
});
