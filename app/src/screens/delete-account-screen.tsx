/**
 * Account deletion.
 *
 * The App Store requires deletion to be reachable from inside the app, and the
 * product requires it to be honest: an account still holding a funded
 * challenge cannot be deleted until that challenge settles, and the screen has
 * to say so instead of offering a control that would fail at the server.
 *
 * What goes is listed item by item rather than summarised, because "your data"
 * is the one phrase a user reads without picturing anything, and the
 * Emergency Recovery allowance in particular is worth more than it looks.
 */

import type { ChallengeView } from "@betterwakeup/contract";
import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
import type { ApiClient } from "../api/client.ts";
import { deleteAccount, deletionBlocker } from "../challenges/lifecycle-commands.ts";
import { AppText, Banner, Card, Screen } from "../ui/components.tsx";
import { BackLink } from "./back-link.tsx";
import { ConfirmAction } from "./confirm-action.tsx";

export interface DeleteAccountScreenProps {
  readonly api: ApiClient;
  /** The account's current challenge, or null when it holds none. */
  readonly challenge: ChallengeView | null;
  readonly onDeleted?: () => void;
  /** Offered as a way back when a caller put this screen on top of another. */
  readonly onBack?: () => void;
}

export const DELETION_PERMANENCE =
  "Deleting your account is permanent. Your challenges, completions, and your Emergency Recovery allowance go with it, and nothing can be restored afterward.";

/** What the press takes away, each thing named so none of it is a surprise. */
const DELETION_LOSSES: readonly string[] = [
  "Every challenge you have run, finished or not.",
  "Every day you completed, and the record of it.",
  "Your one Emergency Recovery allowance, spent or not.",
];

export function DeleteAccountScreen(props: DeleteAccountScreenProps) {
  const { api, challenge } = props;
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
    <Screen testID="delete-account-screen">
      <BackLink testID="delete-back" onBack={props.onBack} />
      <AppText variant="display" accessibilityRole="header">
        Delete your account
      </AppText>

      <Card>
        <AppText variant="headline">What you lose</AppText>
        {DELETION_LOSSES.map((loss) => (
          <View key={loss} style={styles.loss}>
            <AppText variant="small" tone="muted">
              •
            </AppText>
            <AppText variant="small" style={styles.shrink}>
              {loss}
            </AppText>
          </View>
        ))}
        <AppText variant="small" tone="danger" testID="deletion-permanence">
          {DELETION_PERMANENCE}
        </AppText>
      </Card>

      {blocker === null ? (
        <ConfirmAction
          testID="delete-account"
          label="Delete my account"
          consequence={DELETION_PERMANENCE}
          confirmLabel="Delete it permanently"
          variant="danger"
          busy={busy}
          onConfirm={onDelete}
        />
      ) : (
        <Banner tone="warning">
          <AppText
            variant="small"
            tone="warning"
            testID="deletion-blocked"
            accessibilityRole="alert"
          >
            {blocker}
          </AppText>
        </Banner>
      )}

      {problem === null ? null : (
        <Banner tone="danger">
          <AppText
            variant="small"
            tone="danger"
            testID="deletion-problem"
            accessibilityRole="alert"
          >
            {problem}
          </AppText>
        </Banner>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  loss: { flexDirection: "row", gap: 8 },
  shrink: { flexShrink: 1 },
});
