/**
 * "Your deposit is not secured. Here is the card."
 *
 * The screen a user reaches from home's unsecured-deposit banner, which until
 * now was a sentence with nothing behind it. What it has to be clear about is
 * the thing money makes people anxious: the challenge is still running, the
 * days already done still count, and adding a card holds the same amount that
 * was agreed at the start rather than charging anything now.
 *
 * The sheet is opened by a press, not on arrival. A screen that threw a card
 * modal at someone the moment they tapped a warning would be asking for a card
 * before they had read why.
 */

import type { ChallengeView } from "@betterwakeup/contract";
import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
import type { ApiClient } from "../api/client.ts";
import { formatMoney } from "../challenges/draft.ts";
import type { PaymentSheet } from "../payments/payment-sheet.ts";
import { replacePaymentMethod } from "../payments/replace-payment-method.ts";
import { AppText, Banner, Button, Card, Divider, Screen, StatusPill } from "../ui/components.tsx";
import { BackLink } from "./back-link.tsx";

export interface PaymentMethodScreenProps {
  readonly api: ApiClient;
  readonly challenge: ChallengeView;
  /** How a card is asked for. The provider's sheet on a device; a fake in tests. */
  readonly sheet: PaymentSheet;
  /** Called once a card secures the deposit, so the caller re-reads the challenge. */
  readonly onSecured?: () => void;
  readonly onBack?: () => void;
}

export const SHEET_FAILED_MESSAGE = "The card form could not be opened. Try again in a moment.";
export const CANCELLED_MESSAGE =
  "No card was added, so this deposit is still unsecured. Nothing was charged.";

export function PaymentMethodScreen({
  api,
  challenge,
  sheet,
  onSecured,
  onBack,
}: PaymentMethodScreenProps) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Set only when the provider itself is missing, because that is the one
  // answer no amount of pressing changes and the offer has to stop being made.
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [secured, setSecured] = useState(false);
  const amount = formatMoney(challenge.configuration.deposit.amount);

  const onAddCard = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      const card = await sheet.collect().catch(() => ({
        status: "failed" as const,
        message: SHEET_FAILED_MESSAGE,
      }));
      if (card.status === "cancelled") {
        setProblem(CANCELLED_MESSAGE);
        return;
      }
      if (card.status === "unavailable") {
        setUnavailable(card.message);
        return;
      }
      if (card.status === "failed") {
        setProblem(card.message);
        return;
      }
      const outcome = await replacePaymentMethod({
        api,
        challenge,
        providerPaymentMethodId: card.providerPaymentMethodId,
      });
      if (outcome.status === "done") {
        setSecured(true);
        return;
      }
      setProblem(outcome.status === "blocked" ? outcome.reasons.join(" ") : outcome.message);
    } finally {
      setBusy(false);
    }
  }, [api, challenge, sheet]);

  if (secured) {
    return (
      <Screen testID="payment-method-done">
        <View style={styles.header}>
          <StatusPill label="Deposit secured" tone="success" />
          <AppText variant="display" accessibilityRole="header">
            Your challenge is backed again
          </AppText>
        </View>
        <Card>
          <AppText variant="small" testID="payment-method-secured">
            Your new card holds {amount} until this challenge ends. Finish it and the hold is
            released without ever being charged.
          </AppText>
        </Card>
        <Button
          testID="payment-method-done-back"
          label="Back to home"
          onPress={() => onSecured?.()}
        />
      </Screen>
    );
  }

  return (
    <Screen testID="payment-method-screen">
      <BackLink testID="payment-method-back" onBack={onBack} />

      <View style={styles.header}>
        <StatusPill label="Deposit not secured" tone="danger" />
        <AppText variant="display" accessibilityRole="header">
          Your card stopped working
        </AppText>
        <AppText variant="body" tone="muted" testID="payment-method-summary">
          The {amount} hold on this challenge could not be renewed - a card expires, or a bank
          replaces it. Adding a card puts the same hold back.
        </AppText>
      </View>

      <Card>
        <AppText variant="headline">What this changes</AppText>
        <AppText variant="small" tone="muted" testID="payment-method-unchanged">
          Nothing about your challenge. It is still running, the days you have done still count, and
          your wake-up times are unchanged.
        </AppText>
        <Divider />
        <AppText variant="small" tone="muted">
          {amount} is held, not charged. It is only taken if this challenge ends short, and it is
          released when it ends any other way.
        </AppText>
      </Card>

      {unavailable === null ? (
        <Button
          testID="payment-method-add"
          label="Add a card"
          busy={busy}
          onPress={() => void onAddCard()}
        />
      ) : (
        <Banner tone="info">
          <AppText variant="small" testID="payment-method-unavailable">
            {unavailable}
          </AppText>
          <Button
            testID="payment-method-unavailable-back"
            label="Back to home"
            onPress={() => onBack?.()}
          />
        </Banner>
      )}

      {problem === null ? null : (
        <Banner tone="danger">
          <AppText
            variant="small"
            tone="danger"
            testID="payment-method-problem"
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
