/**
 * The first screen, and for now the only one.
 *
 * It renders one of the three session states. The signed-out branch is the
 * screen issue 27 has to reach; its two sign-in buttons are inert until issue
 * 28 wires the native providers to `POST /sessions`.
 */

import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSession } from "../session/session-context.tsx";

export function WelcomeScreen() {
  const { state, signOut } = useSession();
  const insets = useSafeAreaInsets();

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

  return (
    <View style={[styles.container, { paddingTop: insets.top }]} testID="welcome-signed-out">
      <Text style={styles.title}>BetterWakeUp</Text>
      <Text style={styles.body}>
        Put money behind getting up. Set a wake-up time, walk when the alarm goes, and keep your
        deposit.
      </Text>
      <Pressable accessibilityRole="button" disabled style={[styles.button, styles.buttonDisabled]}>
        <Text style={styles.buttonLabel}>Sign in with Apple</Text>
      </Pressable>
      <Pressable accessibilityRole="button" disabled style={[styles.button, styles.buttonDisabled]}>
        <Text style={styles.buttonLabel}>Continue with Google</Text>
      </Pressable>
      <Text style={styles.note}>Sign-in is not available in this build yet.</Text>
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
  note: { fontSize: 13, opacity: 0.6 },
});
