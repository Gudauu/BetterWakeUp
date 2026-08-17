/**
 * The Emergency Recovery offer.
 *
 * The allowance is once in a lifetime and never replenishes, so the screen's
 * job is to make the permanence unmissable before anything is spent: the word
 * is in the heading, in the consequence the confirmation opens, and in the
 * label of the press that acts. Declining is a real option here rather than a
 * dismissal, because letting the window pass is what the product expects of a
 * user who would rather keep the allowance.
 */

import type { ChallengeView } from "@betterwakeup/contract";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ApiClient } from "../api/client.ts";
import { acceptRecovery } from "../challenges/lifecycle-commands.ts";
import { ConfirmAction } from "./confirm-action.tsx";

export interface RecoveryScreenProps {
  readonly api: ApiClient;
  readonly challenge: ChallengeView;
  readonly now?: () => Date;
  readonly onAccepted?: (challenge: ChallengeView) => void;
  /** Called when the user chooses to keep the allowance and let the deposit settle. */
  readonly onDeclined?: () => void;
}

export const RECOVERY_PERMANENCE =
  "Spending your Emergency Recovery is permanent. Each account gets exactly one, it never comes back, and any later failure forfeits the deposit immediately.";

export function RecoveryScreen(props: RecoveryScreenProps) {
  const { api, challenge } = props;
  const insets = useSafeAreaInsets();
  const readClock = props.now ?? (() => new Date());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const offer = challenge.recoveryOffer;

  const onAccept = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      const outcome = await acceptRecovery({
        api,
        challenge,
        confirmed: true,
        now: readClock(),
      });
      if (outcome.status === "done") {
        props.onAccepted?.(outcome.value.challenge);
        return;
      }
      setProblem(outcome.status === "blocked" ? outcome.reasons.join(" ") : outcome.message);
    } finally {
      setBusy(false);
    }
  }, [api, challenge, props.onAccepted, readClock]);

  if (offer === null) {
    return (
      <ScrollView
        testID="recovery-screen"
        contentContainerStyle={[styles.container, { paddingTop: insets.top }]}
      >
        <Text style={styles.title} accessibilityRole="header">
          No recovery offer
        </Text>
        <Text style={styles.body}>Nothing is waiting on a decision right now.</Text>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      testID="recovery-screen"
      contentContainerStyle={[styles.container, { paddingTop: insets.top }]}
    >
      <Text style={styles.title} accessibilityRole="header">
        Spend your one Emergency Recovery?
      </Text>
      <Text style={styles.body}>
        A task was missed, so the challenge has ended unless you undo it. Spending the recovery
        forgives that day and the challenge continues.
      </Text>
      <Text style={styles.permanence} testID="recovery-permanence">
        {RECOVERY_PERMANENCE}
      </Text>
      <Text style={styles.note} testID="recovery-expiry">
        This offer closes at {new Date(offer.expiresAt).toISOString()}. Letting it pass charges the
        deposit and leaves your recovery unspent for a future challenge.
      </Text>

      <ConfirmAction
        testID="accept-recovery"
        label="Spend the recovery"
        consequence={RECOVERY_PERMANENCE}
        confirmLabel="Spend it permanently"
        busy={busy}
        onConfirm={onAccept}
      />

      <Pressable
        accessibilityRole="button"
        testID="decline-recovery"
        onPress={() => props.onDeclined?.()}
      >
        <Text style={styles.decline}>Keep my recovery and let the deposit settle</Text>
      </Pressable>

      {problem === null ? null : (
        <Text style={styles.error} testID="recovery-problem" accessibilityRole="alert">
          {problem}
        </Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { gap: 16, paddingHorizontal: 24, paddingBottom: 48 },
  title: { fontSize: 28, fontWeight: "600" },
  body: { fontSize: 15, lineHeight: 21 },
  permanence: { fontSize: 15, lineHeight: 21, fontWeight: "600" },
  note: { fontSize: 13, opacity: 0.6, lineHeight: 18 },
  decline: { fontSize: 15, textAlign: "center", paddingVertical: 8 },
  error: { fontSize: 14, color: "#b00020", lineHeight: 20 },
});
