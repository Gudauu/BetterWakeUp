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
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CompletionRuntimeFactory } from "../completions/runtime.ts";
import { useSession } from "../session/session-context.tsx";
import { HomeScreen } from "./home-screen.tsx";

const LABELS: Readonly<Record<IdentityProvider, string>> = {
  apple: "Sign in with Apple",
  google: "Continue with Google",
};

export interface WelcomeScreenProps {
  /**
   * Handed straight to home, which is the screen that holds it. It is here so
   * that a test can drive the whole app from sign-in without a device under
   * today's task; a build passes nothing and home builds its own.
   */
  readonly createRuntime?: CompletionRuntimeFactory;
}

export function WelcomeScreen({ createRuntime }: WelcomeScreenProps = {}) {
  const { state, availability, signIn, signOut } = useSession();
  const insets = useSafeAreaInsets();
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
      <View style={styles.container} testID="welcome-loading">
        <ActivityIndicator accessibilityLabel="Loading" />
      </View>
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
        />
      </View>
    );
  }

  const offered: IdentityProvider[] =
    availability === null ? [] : (["apple", "google"] as const).filter((p) => availability[p]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]} testID="welcome-signed-out">
      <Text style={styles.title}>BetterWakeUp</Text>
      <Text style={styles.body}>
        Put money behind getting up. Set a wake-up time, walk when the alarm goes, and keep your
        deposit.
      </Text>

      {offered.map((provider) => (
        <Pressable
          key={provider}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy !== null, busy: busy === provider }}
          testID={`sign-in-${provider}`}
          disabled={busy !== null}
          style={[styles.button, busy !== null && styles.buttonDisabled]}
          onPress={() => void onSignIn(provider)}
        >
          <Text style={styles.buttonLabel}>{LABELS[provider]}</Text>
        </Pressable>
      ))}

      {availability !== null && offered.length === 0 ? (
        <Text style={styles.note} testID="no-providers">
          Sign-in is not available on this device.
        </Text>
      ) : null}

      {error === null ? null : (
        <Text style={styles.error} testID="sign-in-error" accessibilityRole="alert">
          {error}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    paddingHorizontal: 24,
  },
  title: { fontSize: 28, fontWeight: "600" },
  body: { fontSize: 16, textAlign: "center", lineHeight: 22 },
  button: {
    alignItems: "center",
    borderRadius: 12,
    paddingHorizontal: 24,
    paddingVertical: 14,
    minWidth: 240,
    backgroundColor: "#111111",
  },
  buttonDisabled: { opacity: 0.4 },
  buttonLabel: { color: "#ffffff", fontSize: 16, fontWeight: "600" },
  note: { fontSize: 13, opacity: 0.6, textAlign: "center" },
  error: { fontSize: 14, color: "#b00020", textAlign: "center", lineHeight: 20 },
});
