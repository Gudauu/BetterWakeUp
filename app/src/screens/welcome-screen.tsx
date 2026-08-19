/**
 * The first screen: who is signed in, and nothing else.
 *
 * A signed-in account is handed to `HomeScreen`, which is where what the
 * account is actually doing gets read. Sign-in is the whole of this screen's
 * job, so that question is asked in one place.
 *
 * It renders one of the three session states, and in the signed-out one offers
 * whichever providers this device and build can actually use. A provider that
 * cannot work is absent rather than disabled: a greyed-out Apple button on
 * Android is a mystery, and a Google button in a build with no client ID is a
 * promise the app cannot keep.
 */

import type { IdentityProvider } from "@betterwakeup/contract";
import { useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { signInOptions } from "../auth/provider-availability.ts";
import type { AppReturnTrigger } from "../challenges/app-return.ts";
import type { CompletionRuntimeFactory } from "../completions/runtime.ts";
import type { MovementDevice } from "../movement/device-readiness.ts";
import type { PaymentSheet } from "../payments/payment-sheet.ts";
import {
  createConfiguredNotifier,
  type Notifier,
  useRemindersClearedWhenSignedOut,
} from "../reminders/notifier.ts";
import type { ReminderTapTrigger } from "../reminders/reminder-taps.ts";
import { useSession } from "../session/session-context.tsx";
import { AppText, Banner, Button, Screen, TextButton } from "../ui/components.tsx";
import { useTheme } from "../ui/theme.ts";
import { HomeScreen } from "./home-screen.tsx";

const LABELS: Readonly<Record<IdentityProvider, string>> = {
  apple: "Sign in with Apple",
  google: "Continue with Google",
};

/**
 * What the app asks of the user, in the order it happens. Shown before sign-in
 * because the deal - money on the line, a walk to keep it - is the thing worth
 * knowing before handing over an identity, and a sentence of prose hides it.
 */
const HOW_IT_WORKS: readonly { readonly step: string; readonly line: string }[] = [
  { step: "1", line: "Pick a wake-up time and put a deposit behind it." },
  { step: "2", line: "When the alarm goes, walk until you hit your step target." },
  { step: "3", line: "Finish the run of days and your deposit comes back." },
];

/**
 * What a signed-out user is told when they did not ask to be signed out. The
 * screen otherwise sells the app to someone who has never seen it, which reads
 * as an insult to someone who was three weeks into a challenge a moment ago.
 *
 * It stops short of naming the challenge or its numbers because there is no
 * session left to read them with; what it can say for certain is that being
 * signed out is not a pause, that the alarms have stopped, and that nothing on
 * the phone was thrown away.
 */
const EXPIRED_NOTICE = {
  title: "You were signed out",
  body: "Your sign-in expired, so the app can no longer reach your account.",
  // Said out loud because the phone has gone quiet without being asked to. An
  // alarm the app cannot honour is worse than none, so they are cancelled - but
  // a user relying on one tomorrow has to hear that it will not sound.
  alarms:
    "Your wake-up reminders on this phone have been turned off. Sign back in to have them set again.",
  reassurance:
    "If a challenge is running it carries on without you: its deadlines still count while you are signed out, and only a walk taken in the app can meet one. Any walk already saved on this phone is still here, and will be sent once you sign back in.",
} as const;

/**
 * The receipt for the one thing the app can do that nothing undoes.
 *
 * A deletion that ends on the first-launch pitch leaves the user unsure it
 * happened at all, which on this action is the worst thing to be unsure about.
 * So the screen states it plainly, and then states the one fact a user is
 * likeliest to get wrong next: the sign-in buttons below still work, and
 * pressing one builds a new account rather than finding the old one.
 *
 * It says nothing about a deposit beyond the hold, because a deletion is only
 * allowed once every funded challenge has settled - which is a fact about what
 * is still held, not about what was charged along the way.
 */
const DELETED_NOTICE = {
  title: "Your account has been deleted",
  body: "Your challenges, your completed days, and your Emergency Recovery allowance are gone from BetterWakeUp. No deposit is still held: an account can only be deleted once its challenges have settled.",
  phone:
    "This phone has been cleared too. Any walk it had saved and not yet sent has been thrown away, and its wake-up reminders have been turned off.",
  // Not a footnote: the buttons under this banner are the same buttons, and
  // pressing one after deleting is the likeliest next thing to happen.
  again:
    "You can sign in again with the same Apple or Google account. That starts a new account from scratch - nothing from the deleted one comes back with it.",
} as const;

export interface WelcomeScreenProps {
  /**
   * Handed straight to home, which is the screen that holds it. It is here so
   * that a test can drive the whole app from sign-in without a device under
   * today's task; a build passes nothing and home builds its own.
   */
  readonly createRuntime?: CompletionRuntimeFactory;
  /**
   * The device's reminders, so a test schedules nothing. Held here rather than
   * passed through, because this screen both hands it to home and clears it
   * when the session ends; a build passes nothing and the configured one is
   * built once for the life of the screen.
   */
  readonly notifier?: Notifier;
  /** Handed straight to home, so a test can walk a deposit without a provider. */
  readonly paymentSheet?: PaymentSheet;
  /** Handed straight to home, so a test can put the app away and come back. */
  readonly appReturn?: AppReturnTrigger;
  /** Handed straight to home, so a test can set up a challenge without a sensor. */
  readonly movementDevice?: MovementDevice;
  /** Handed straight to home, so a test can tap a wake-up reminder. */
  readonly reminderTaps?: ReminderTapTrigger;
}

export function WelcomeScreen({
  createRuntime,
  notifier,
  paymentSheet,
  appReturn,
  movementDevice,
  reminderTaps,
}: WelcomeScreenProps = {}) {
  const { state, availability, recheckAvailability, signIn, signOut } = useSession();
  const theme = useTheme();
  const [busy, setBusy] = useState<IdentityProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Built here rather than left to home, because the device's reminders outlive
  // the screen that scheduled them: this is the only component that is mounted
  // both while a session exists and after it is gone, so it is the only one
  // that can take them off.
  const [reminderNotifier] = useState<Notifier>(() => notifier ?? createConfiguredNotifier());
  useRemindersClearedWhenSignedOut(reminderNotifier, state.status === "signedOut");

  async function onSignIn(provider: IdentityProvider) {
    setError(null);
    setBusy(provider);
    try {
      const outcome = await signIn(provider);
      // Cancellation is silent on purpose: the user closed the sheet, and
      // telling them something went wrong would be telling them a falsehood.
      if (outcome.status === "failed") {
        setError(outcome.message);
      }
    } finally {
      setBusy(null);
    }
  }

  if (state.status === "loading") {
    return (
      <Screen centered testID="welcome-loading">
        <ActivityIndicator accessibilityLabel="Loading" color={theme.colors.accent} />
      </Screen>
    );
  }

  if (state.status === "signedIn") {
    // Home decides what a signed-in account sees, because that depends on
    // whether it already holds a challenge and this screen has not asked.
    return (
      <View style={styles.fill} testID="welcome-signed-in">
        <HomeScreen
          onSignOut={() => void signOut()}
          {...(createRuntime === undefined ? {} : { createRuntime })}
          notifier={reminderNotifier}
          {...(paymentSheet === undefined ? {} : { paymentSheet })}
          {...(appReturn === undefined ? {} : { appReturn })}
          {...(movementDevice === undefined ? {} : { movementDevice })}
          {...(reminderTaps === undefined ? {} : { reminderTaps })}
        />
      </View>
    );
  }

  const options = signInOptions(availability);
  const expired = state.reason === "expired";
  const deleted = state.reason === "deleted";

  return (
    <Screen testID="welcome-signed-out" style={styles.signedOut}>
      {deleted ? (
        <Banner tone="info" testID="account-deleted">
          <AppText variant="headline" accessibilityRole="alert">
            {DELETED_NOTICE.title}
          </AppText>
          <AppText variant="small">{DELETED_NOTICE.body}</AppText>
          <AppText variant="small" testID="account-deleted-phone">
            {DELETED_NOTICE.phone}
          </AppText>
          <AppText variant="small" tone="muted" testID="account-deleted-again">
            {DELETED_NOTICE.again}
          </AppText>
        </Banner>
      ) : null}

      {expired ? (
        <Banner tone="warning" testID="session-expired">
          <AppText variant="headline" accessibilityRole="alert">
            {EXPIRED_NOTICE.title}
          </AppText>
          <AppText variant="small">{EXPIRED_NOTICE.body}</AppText>
          <AppText variant="small" testID="session-expired-alarms">
            {EXPIRED_NOTICE.alarms}
          </AppText>
          <AppText variant="small" tone="muted">
            {EXPIRED_NOTICE.reassurance}
          </AppText>
        </Banner>
      ) : null}

      <View style={styles.hero}>
        <AppText variant="caption" tone="accent">
          WAKE UP ON PURPOSE
        </AppText>
        <AppText variant="display" accessibilityRole="header">
          BetterWakeUp
        </AppText>
        <AppText variant="body" tone="muted">
          Put money behind getting up. Set a wake-up time, walk when the alarm goes, and keep your
          deposit.
        </AppText>
      </View>

      {/* The three steps are the pitch, and someone who was signed in a moment
          ago has already bought it; the room goes to why they are looking at
          this screen instead. */}
      {expired || deleted ? null : (
        <View style={styles.steps} testID="welcome-how-it-works">
          {HOW_IT_WORKS.map(({ step, line }) => (
            <View key={step} style={styles.step}>
              <View
                style={[
                  styles.stepBadge,
                  { backgroundColor: theme.colors.accentSoft, borderRadius: theme.radius.pill },
                ]}
              >
                <AppText variant="caption" tone="accent">
                  {step}
                </AppText>
              </View>
              <AppText variant="small" style={styles.stepLine}>
                {line}
              </AppText>
            </View>
          ))}
        </View>
      )}

      <View style={styles.actions}>
        {options.kind === "offered"
          ? options.providers.map((provider) => (
              <Button
                key={provider}
                testID={`sign-in-${provider}`}
                label={LABELS[provider]}
                disabled={busy !== null && busy !== provider}
                busy={busy === provider}
                onPress={() => void onSignIn(provider)}
              />
            ))
          : null}

        {/* The buttons cannot be drawn until the native modules answer, and an
            empty space where they belong reads as a broken screen rather than
            as a wait. */}
        {options.kind === "checking" ? (
          <View style={styles.checking} testID="providers-checking">
            <ActivityIndicator color={theme.colors.accent} />
            <AppText variant="caption" tone="muted">
              {options.message}
            </AppText>
          </View>
        ) : null}

        {options.kind === "unavailable" ? (
          <AppText variant="caption" tone="muted" center testID="no-providers">
            {options.message}
          </AppText>
        ) : null}

        {/* Not the same as having no provider: the question was never answered,
            so the one thing the user can do is make the app ask again. */}
        {options.kind === "unknown" ? (
          <Banner tone="warning" testID="providers-unknown">
            <AppText variant="small" accessibilityRole="alert">
              {options.message}
            </AppText>
            <TextButton
              testID="providers-retry"
              label="Try again"
              tone="accent"
              onPress={recheckAvailability}
            />
          </Banner>
        ) : null}

        {error === null ? null : (
          <Banner tone="danger">
            <AppText variant="small" tone="danger" testID="sign-in-error" accessibilityRole="alert">
              {error}
            </AppText>
          </Banner>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // The sign-in column sits low: the pitch is read first and the buttons are
  // where a thumb already is.
  signedOut: { flexGrow: 1, gap: 28, justifyContent: "center" },
  hero: { gap: 8 },
  steps: { gap: 14 },
  step: { flexDirection: "row", alignItems: "center", gap: 12 },
  stepBadge: { alignItems: "center", justifyContent: "center", height: 28, width: 28 },
  stepLine: { flexShrink: 1 },
  actions: { gap: 12 },
  checking: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
});
