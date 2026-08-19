/**
 * The Emergency Recovery offer.
 *
 * The allowance is once in a lifetime and never replenishes, so the screen's
 * job is to make the permanence unmissable before anything is spent: the word
 * is in the heading, in the consequence the confirmation opens, and in the
 * label of the press that acts. Declining is a real option here rather than a
 * dismissal, because letting the window pass is what the product expects of a
 * user who would rather keep the allowance.
 *
 * The two outcomes are drawn as a pair of cards - what spending it does, what
 * keeping it does - so the choice is a comparison rather than a wall of
 * warnings with one button under it.
 *
 * Spending it is the one irreversible press in the app, so both ends of it are
 * spelled out: the trade before, including the replacement morning appended at
 * the end that the screen used to leave out, and what the server actually did
 * after, read from its own answer rather than left to a screen change.
 */

import type { AcceptRecoveryResponse, ChallengeView } from "@betterwakeup/contract";
import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
import type { ApiClient } from "../api/client.ts";
import { acceptRecovery } from "../challenges/lifecycle-commands.ts";
import {
  RECOVERY_REPLACEMENT,
  recoveryResult,
  recoveryTrade,
} from "../challenges/recovery-outcome.ts";
import { recoveryWindow } from "../challenges/recovery-window.ts";
import { useClock } from "../ui/clock.ts";
import {
  AppText,
  Banner,
  Button,
  Card,
  Screen,
  StatusPill,
  TextButton,
} from "../ui/components.tsx";
import { formatDeadline } from "../ui/format.ts";
import { BackLink } from "./back-link.tsx";
import { ConfirmAction } from "./confirm-action.tsx";

export interface RecoveryScreenProps {
  readonly api: ApiClient;
  readonly challenge: ChallengeView;
  readonly now?: () => Date;
  readonly onAccepted?: (challenge: ChallengeView) => void;
  /** Called when the user chooses to keep the allowance and let the deposit settle. */
  readonly onDeclined?: () => void;
  /** Offered as a way back when a caller put this screen on top of another. */
  readonly onBack?: () => void;
}

export const RECOVERY_PERMANENCE =
  "Spending your Emergency Recovery is permanent. Each account gets exactly one, it never comes back, and any later failure forfeits the deposit immediately.";

export function RecoveryScreen(props: RecoveryScreenProps) {
  const { api, challenge } = props;
  // Ticking rather than read once: the window this screen is about can close
  // while it is open, and the choice it draws has to go with it.
  const clock = useClock(props.now);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Held rather than handed straight back to the caller: the answer names the
  // day that was forgiven and the morning that replaced it, and returning home
  // on the press would acknowledge the one irreversible act in the app with a
  // screen change.
  const [accepted, setAccepted] = useState<AcceptRecoveryResponse | null>(null);

  const offer = challenge.recoveryOffer;

  const onAccept = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      const outcome = await acceptRecovery({
        api,
        challenge,
        confirmed: true,
        now: clock,
      });
      if (outcome.status === "done") {
        setAccepted(outcome.value);
        return;
      }
      setProblem(outcome.status === "blocked" ? outcome.reasons.join(" ") : outcome.message);
    } finally {
      setBusy(false);
    }
  }, [api, challenge, clock]);

  // What the server did, before anything else this screen would draw: the
  // offer is gone from the challenge it was given, so every branch below would
  // otherwise render "No recovery offer" over the press that just worked.
  if (accepted !== null) {
    const result = recoveryResult({
      challenge: accepted.challenge,
      forgivenTask: accepted.forgivenTask,
      appendedTask: accepted.appendedTask,
    });
    return (
      <Screen testID="recovery-screen">
        <View style={styles.header}>
          <StatusPill label="Recovery spent" tone="success" />
          <AppText variant="display" accessibilityRole="header">
            Your challenge is back
          </AppText>
        </View>

        <Card>
          <AppText variant="headline">What changed</AppText>
          <AppText variant="small" testID="recovery-forgiven">
            {result.forgiven}
          </AppText>
          <AppText variant="small" testID="recovery-appended">
            {result.appended}
          </AppText>
          <AppText variant="small" testID="recovery-ends">
            {result.ends}
          </AppText>
        </Card>

        <Banner tone="warning" testID="recovery-spent">
          <AppText variant="small" tone="warning" accessibilityRole="alert">
            {result.spent}
          </AppText>
        </Banner>

        <Button
          testID="recovery-done"
          label="Back to home"
          onPress={() => props.onAccepted?.(accepted.challenge)}
        />
      </Screen>
    );
  }

  if (offer === null) {
    return (
      <Screen testID="recovery-screen">
        <BackLink testID="recovery-back" onBack={props.onBack} />
        <AppText variant="display" accessibilityRole="header">
          No recovery offer
        </AppText>
        <AppText variant="body" tone="muted">
          Nothing is waiting on a decision right now.
        </AppText>
      </Screen>
    );
  }

  const closing = formatDeadline(offer.expiresAt, challenge.configuration.timeZone);
  const window = recoveryWindow(challenge, clock);

  // The window went by while the offer was on screen, or before the user ever
  // reached it. There is nothing to decide: the command refuses an expired
  // offer without sending anything, so drawing the choice would be offering a
  // press whose only outcome is a refusal.
  if (window !== null && !window.decidable) {
    return (
      <Screen testID="recovery-screen">
        <BackLink testID="recovery-back" onBack={props.onBack} />

        <View style={styles.header}>
          <StatusPill label="Window closed" tone="danger" />
          <AppText variant="display" accessibilityRole="header">
            That decision has been made
          </AppText>
        </View>

        <Banner tone="danger" testID="recovery-closed">
          <AppText variant="small" tone="danger" accessibilityRole="alert">
            The offer closed at {closing}. {window.sentence}
          </AppText>
        </Banner>

        <Card>
          <AppText variant="headline">Your recovery is still yours</AppText>
          <AppText variant="small" testID="recovery-unspent">
            Nothing was spent. Your one Emergency Recovery stays unused and is there for a future
            challenge.
          </AppText>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen testID="recovery-screen">
      <BackLink testID="recovery-back" onBack={props.onBack} />

      <View style={styles.header}>
        <StatusPill label="One decision left" tone="warning" />
        <AppText variant="display" accessibilityRole="header">
          Spend your one Emergency Recovery?
        </AppText>
        <AppText variant="body" tone="muted">
          A task was missed, so the challenge has ended unless you undo it.
        </AppText>
      </View>

      <Banner
        tone={window?.urgency === "closing" ? "danger" : "warning"}
        testID="recovery-deadline"
      >
        {/* How long is left, before when it closes. A user who has just been
            told they missed a day needs to know whether this is a decision for
            now or for later, and an absolute time alone does not answer it. */}
        {window === null ? null : (
          <AppText
            variant="headline"
            tone={window.urgency === "closing" ? "danger" : "warning"}
            testID="recovery-time-left"
          >
            {window.sentence}
          </AppText>
        )}
        <AppText
          variant="small"
          tone={window?.urgency === "closing" ? "danger" : "warning"}
          accessibilityRole="alert"
        >
          This offer closes at {closing}. After that the decision is made for you.
        </AppText>
      </Banner>

      <Card>
        <AppText variant="headline">If you spend it</AppText>
        <AppText variant="small" testID="recovery-trade">
          {recoveryTrade(challenge)}
        </AppText>
        {/* The half of the trade the screen used to leave out: recovery buys
            the missed morning back by adding another one at the end, so the
            user is agreeing to walk an extra day, not to skip one. */}
        <AppText variant="small" testID="recovery-replacement">
          {RECOVERY_REPLACEMENT}
        </AppText>
        <AppText variant="small" tone="danger" testID="recovery-permanence">
          {RECOVERY_PERMANENCE}
        </AppText>
      </Card>

      <Card>
        <AppText variant="headline">If you keep it</AppText>
        <AppText variant="small" testID="recovery-expiry">
          This challenge ends here, the deposit is charged, and your recovery stays unspent for a
          future challenge.
        </AppText>
      </Card>

      <ConfirmAction
        testID="accept-recovery"
        label="Spend the recovery"
        consequence={`${RECOVERY_PERMANENCE} ${RECOVERY_REPLACEMENT}`}
        confirmLabel="Spend it permanently"
        variant="danger"
        busy={busy}
        onConfirm={onAccept}
      />

      <TextButton
        testID="decline-recovery"
        label="Keep my recovery and let the deposit settle"
        onPress={() => props.onDeclined?.()}
      />

      {problem === null ? null : (
        <Banner tone="danger">
          <AppText
            variant="small"
            tone="danger"
            testID="recovery-problem"
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
  header: { gap: 8 },
});
