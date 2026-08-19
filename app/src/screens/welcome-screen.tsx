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
import type { AppReturnTrigger } from "../challenges/app-return.ts";
import type { CompletionRuntimeFactory } from "../completions/runtime.ts";
import type { PaymentSheet } from "../payments/payment-sheet.ts";
import type { Notifier } from "../reminders/notifier.ts";
import { useSession } from "../session/session-context.tsx";
import { AppText, Banner, Button, Screen } from "../ui/components.tsx";
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
 * signed out is not a pause, and that nothing on the phone was thrown away.
 */
const EXPIRED_NOTICE = {
  title: "You were signed out",
  body: "Your sign-in expired, so the app can no longer reach your account.",
  reassurance:
    "If a challenge is running it carries on without you: its deadlines still count while you are signed out, and only a walk taken in the app can meet one. Any walk already saved on this phone is still here, and will be sent once you sign back in.",
} as const;

export interface WelcomeScreenProps {
  /**
   * Handed straight to home, which is the screen that holds it. It is here so
   * that a test can drive the whole app from sign-in without a device under
   * today's task; a build passes nothing and home builds its own.
   */
  readonly createRuntime?: CompletionRuntimeFactory;
  /** Handed straight to home for the same reason, so a test schedules nothing. */
  readonly notifier?: Notifier;
  /** Handed straight to home, so a test can walk a deposit without a provider. */
  readonly paymentSheet?: PaymentSheet;
  /** Handed straight to home, so a test can put the app away and come back. */
  readonly appReturn?: AppReturnTrigger;
}

export function WelcomeScreen({
  createRuntime,
  notifier,
  paymentSheet,
  appReturn,
}: WelcomeScreenProps = {}) {
  const { state, availability, signIn, signOut } = useSession();
  const theme = useTheme();
  const [busy, setBusy] = useState<IdentityProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          {...(notifier === undefined ? {} : { notifier })}
          {...(paymentSheet === undefined ? {} : { paymentSheet })}
          {...(appReturn === undefined ? {} : { appReturn })}
        />
      </View>
    );
  }

  const offered: IdentityProvider[] =
    availability === null ? [] : (["apple", "google"] as const).filter((p) => availability[p]);
  const expired = state.reason === "expired";

  return (
    <Screen testID="welcome-signed-out" style={styles.signedOut}>
      {expired ? (
        <Banner tone="warning" testID="session-expired">
          <AppText variant="headline" accessibilityRole="alert">
            {EXPIRED_NOTICE.title}
          </AppText>
          <AppText variant="small">{EXPIRED_NOTICE.body}</AppText>
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
      {expired ? null : (
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
        {offered.map((provider) => (
          <Button
            key={provider}
            testID={`sign-in-${provider}`}
            label={LABELS[provider]}
            disabled={busy !== null && busy !== provider}
            busy={busy === provider}
            onPress={() => void onSignIn(provider)}
          />
        ))}

        {availability !== null && offered.length === 0 ? (
          <AppText variant="caption" tone="muted" center testID="no-providers">
            Sign-in is not available on this device.
          </AppText>
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
});
