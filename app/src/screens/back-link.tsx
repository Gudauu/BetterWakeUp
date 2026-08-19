/**
 * The way back to home.
 *
 * Every screen home puts on top of itself needs one, and they should all look
 * and read the same, so the press lives here rather than being written out
 * once per screen. It renders nothing when no caller owns the return trip,
 * which is what makes these screens still usable on their own.
 *
 * It sits left rather than centred, and carries a chevron, because it is a
 * direction rather than a choice - the rest of the app's quiet actions are
 * centred and this one should not be mistaken for them.
 */

import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { TextButton } from "../ui/components.tsx";

export interface BackLinkProps {
  readonly testID: string;
  readonly onBack: (() => void) | undefined;
}

export function BackLink({ testID, onBack }: BackLinkProps): ReactNode {
  if (onBack === undefined) {
    return null;
  }
  return (
    <View style={styles.left}>
      <TextButton testID={testID} label="‹  Back to home" onPress={onBack} />
    </View>
  );
}

const styles = StyleSheet.create({
  left: { alignItems: "flex-start" },
});
