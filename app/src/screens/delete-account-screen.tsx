/**
 * Account deletion.
 *
 * The App Store requires deletion to be reachable from inside the app, and the
 * product requires it to be honest: an account still holding a funded
 * challenge cannot be deleted until that challenge settles, and the screen has
 * to say so instead of offering a control that would fail at the server.
 */

import type { ChallengeView } from "@betterwakeup/contract";
import { useCallback, useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ApiClient } from "../api/client.ts";
import { deleteAccount, deletionBlocker } from "../challenges/lifecycle-commands.ts";
import { ConfirmAction } from "./confirm-action.tsx";

export interface DeleteAccountScreenProps {
  readonly api: ApiClient;
  /** The account's current challenge, or null when it holds none. */
  readonly challenge: ChallengeView | null;
  readonly onDeleted?: () => void;
}

export const DELETION_PERMANENCE =
  "Deleting your account is permanent. Your challenges, completions, and your Emergency Recovery allowance go with it, and nothing can be restored afterward.";

export function DeleteAccountScreen(props: DeleteAccountScreenProps) {
  const { api, challenge } = props;
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const blocker = deletionBlocker(challenge);

  const onDelete = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      const outcome = await deleteAccount({ api, challenge, confirmed: true });
      if (outcome.status === "done") {
        props.onDeleted?.();
        return;
      }
      setProblem(outcome.status === "blocked" ? outcome.reasons.join(" ") : outcome.message);
    } finally {
      setBusy(false);
    }
  }, [api, challenge, props.onDeleted]);

  return (
    <ScrollView
      testID="delete-account-screen"
      contentContainerStyle={[styles.container, { paddingTop: insets.top }]}
    >
      <Text style={styles.title} accessibilityRole="header">
        Delete your account
      </Text>
      <Text style={styles.permanence} testID="deletion-permanence">
        {DELETION_PERMANENCE}
      </Text>

      {blocker === null ? (
        <ConfirmAction
          testID="delete-account"
          label="Delete my account"
          consequence={DELETION_PERMANENCE}
          confirmLabel="Delete it permanently"
          busy={busy}
          onConfirm={onDelete}
        />
      ) : (
        <Text style={styles.blocked} testID="deletion-blocked" accessibilityRole="alert">
          {blocker}
        </Text>
      )}

      {problem === null ? null : (
        <Text style={styles.error} testID="deletion-problem" accessibilityRole="alert">
          {problem}
        </Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { gap: 16, paddingHorizontal: 24, paddingBottom: 48 },
  title: { fontSize: 28, fontWeight: "600" },
  permanence: { fontSize: 15, lineHeight: 21, fontWeight: "600" },
  blocked: { fontSize: 15, lineHeight: 21, color: "#8a5300" },
  error: { fontSize: 14, color: "#b00020", lineHeight: 20 },
});
