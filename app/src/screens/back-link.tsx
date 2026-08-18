/**
 * The way back to home.
 *
 * Every screen home puts on top of itself needs one, and they should all look
 * and read the same, so the press lives here rather than being written out
 * once per screen. It renders nothing when no caller owns the return trip,
 * which is what makes these screens still usable on their own.
 */

import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text } from "react-native";

export interface BackLinkProps {
  readonly testID: string;
  readonly onBack: (() => void) | undefined;
}

export function BackLink({ testID, onBack }: BackLinkProps): ReactNode {
  if (onBack === undefined) {
    return null;
  }
  return (
    <Pressable accessibilityRole="button" testID={testID} onPress={onBack}>
      <Text style={styles.label}>Back to home</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 15, opacity: 0.7 },
});
