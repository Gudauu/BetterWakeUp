/**
 * The account controls: signing out and deleting the account.
 *
 * They are never the thing to do next, so they live off home. With a
 * challenge running they close the challenge page; with none, home offers
 * them behind a settings button on a page of their own. Either way deletion
 * stays reachable whatever the account holds, which the App Store requires.
 */

import type { ChallengeView } from "@betterwakeup/contract";
import type { ReactNode } from "react";
import {
  SIGN_OUT_CANCEL_LABEL,
  SIGN_OUT_CONFIRM_LABEL,
  signOutConsequence,
} from "../session/sign-out.ts";
import { AppText, Card, Screen, TextButton } from "../ui/components.tsx";
import { BackLink } from "./back-link.tsx";
import { ConfirmAction } from "./confirm-action.tsx";

export interface AccountSectionProps {
  /** Prefixes every control's testID, so two screens can hold the section. */
  readonly testID: string;
  readonly onSignOut: (() => void) | undefined;
  readonly onDeleteAccount: () => void;
  readonly challenge: ChallengeView | null;
  /** Walks this phone holds that the server has not acknowledged. */
  readonly heldWalks: number;
}

/** Sign out and delete account, under a heading of their own. */
export function AccountSection({
  testID,
  onSignOut,
  onDeleteAccount,
  challenge,
  heldWalks,
}: AccountSectionProps): ReactNode {
  return (
    <>
      <AppText variant="caption" tone="muted">
        ACCOUNT
      </AppText>
      <Card testID={testID}>
        <SignOutAction
          testID={`${testID}-sign-out`}
          onSignOut={onSignOut}
          challenge={challenge}
          heldWalks={heldWalks}
        />
        <TextButton
          testID={`${testID}-delete`}
          label="Delete account"
          tone="danger"
          onPress={onDeleteAccount}
        />
      </Card>
    </>
  );
}

/**
 * The page home opens from its settings button when no challenge is running,
 * which is the only time the challenge page is not there to hold the section.
 */
export function AccountScreen({
  onBack,
  ...section
}: Omit<AccountSectionProps, "testID" | "challenge"> & {
  readonly onBack: () => void;
}): ReactNode {
  return (
    <Screen testID="account-screen">
      <BackLink testID="account-back" onBack={onBack} />
      <AppText variant="display" accessibilityRole="header">
        Account
      </AppText>
      <AccountSection testID="account" challenge={null} {...section} />
    </Screen>
  );
}

/**
 * The sign-out press, guarded by what it would cost.
 *
 * Signing out can lose a deposit - the challenge carries on without the phone
 * and the alarms stop - so it asks before it acts, and only where there is
 * something to ask about: with nothing running and nothing held on the phone
 * the press is what it looks like, and a confirmation over it would be
 * ceremony.
 */
export function SignOutAction({
  testID,
  onSignOut,
  challenge,
  heldWalks,
  challengeUnknown = false,
}: {
  readonly testID: string;
  readonly onSignOut: (() => void) | undefined;
  readonly challenge: ChallengeView | null;
  readonly heldWalks: number;
  readonly challengeUnknown?: boolean;
}): ReactNode {
  if (onSignOut === undefined) {
    return null;
  }
  const consequence = signOutConsequence({ challenge, heldWalks, challengeUnknown });
  if (consequence === null) {
    return <TextButton testID={testID} label="Sign out" onPress={onSignOut} />;
  }
  return (
    <ConfirmAction
      testID={testID}
      quiet
      label="Sign out"
      consequence={consequence}
      confirmLabel={SIGN_OUT_CONFIRM_LABEL}
      cancelLabel={SIGN_OUT_CANCEL_LABEL}
      onConfirm={onSignOut}
    />
  );
}
