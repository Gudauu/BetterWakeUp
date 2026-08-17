/**
 * The first screen, and for now the only one.
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
import { useSession } from "../session/session-context.tsx";

const LABELS: Readonly<Record<IdentityProvider, string>> = {
  apple: "Sign in with Apple",
  google: "Continue with Google",
};

export function WelcomeScreen() {
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
    return (
      <View style={[styles.container, { paddingTop: insets.top }]} testID="welcome-signed-in">
        <Text style={styles.title}>BetterWakeUp</Text>
        <Text style={styles.body}>You are signed in.</Text>
        <Pressable accessibilityRole="button" style={styles.button} onPress={() => void signOut()}>
          <Text style={styles.buttonLabel}>Sign out</Text>
        </Pressable>
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
