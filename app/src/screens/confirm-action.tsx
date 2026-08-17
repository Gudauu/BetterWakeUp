/**
 * A two-step control for an action that cannot be undone.
 *
 * The first press opens the consequence and the second one takes the action,
 * so a single mistaken tap never spends a recovery, skips a task, or deletes
 * an account. Cancelling is always offered beside the confirmation and is the
 * wider target of the two.
 */

import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

export interface ConfirmActionProps {
  readonly testID: string;
  /** The label of the control before anything is opened. */
  readonly label: string;
  /** What will happen, in the user's terms. Shown only once opened. */
  readonly consequence: string;
  /** The label of the press that actually acts. */
  readonly confirmLabel: string;
  readonly busy?: boolean;
  readonly onConfirm: () => Promise<void> | void;
}

export function ConfirmAction(props: ConfirmActionProps) {
  const [open, setOpen] = useState(false);
  const busy = props.busy ?? false;

  const onConfirm = useCallback(async () => {
    await props.onConfirm();
    setOpen(false);
  }, [props.onConfirm]);

  if (!open) {
    return (
      <Pressable
        accessibilityRole="button"
        testID={props.testID}
        disabled={busy}
        style={[styles.button, busy && styles.disabled]}
        onPress={() => setOpen(true)}
      >
        <Text style={styles.buttonLabel}>{props.label}</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.panel} testID={`${props.testID}-confirmation`}>
      <Text style={styles.consequence} testID={`${props.testID}-consequence`}>
        {props.consequence}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy, busy }}
        testID={`${props.testID}-confirm`}
        disabled={busy}
        style={[styles.button, busy && styles.disabled]}
        onPress={() => void onConfirm()}
      >
        <Text style={styles.buttonLabel}>{props.confirmLabel}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        testID={`${props.testID}-cancel`}
        onPress={() => setOpen(false)}
      >
        <Text style={styles.cancelLabel}>Keep things as they are</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 12, borderRadius: 12, borderWidth: 1, borderColor: "#d8d8d8", padding: 16 },
  consequence: { fontSize: 15, lineHeight: 21 },
  button: {
    alignItems: "center",
    backgroundColor: "#111111",
    borderRadius: 12,
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  disabled: { opacity: 0.4 },
  buttonLabel: { color: "#ffffff", fontSize: 16, fontWeight: "600" },
  cancelLabel: { fontSize: 15, textAlign: "center", paddingVertical: 8 },
});
