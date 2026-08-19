/**
 * The card, and the sheet it is typed into.
 *
 * A funded challenge is authorized on the device, not on the server: the
 * funding intent carries `providerClientSecret` precisely because the hold is
 * completed by the provider's own sheet, in front of the user, and confirmed
 * back to us by a webhook. The app had no sheet at all. It asked for the
 * intent, threw the client secret away, and then sat on "Waiting for your
 * bank" - a wait for something nobody had started, since the user had never
 * been asked for a card.
 *
 * The port is here for the same reason the notifier's and the pedometer's are:
 * the provider's SDK can only run on a device, and what a screen does with each
 * answer - authorized, cancelled, declined - is worth testing without one.
 *
 * The one thing the sheet does not carry back is money. It reports that the
 * user completed the authorization; whether a hold exists is the server's
 * answer, read from `GET /challenges/current` after the webhook lands. A device
 * that claimed a challenge into existence would be the whole funding flow's
 * trust model inverted.
 */

/** What the user is being asked to authorize, in their own terms. */
export interface PaymentSheetRequest {
  /** Provider-side material from the funding intent. Opaque, never logged. */
  readonly clientSecret: string;
  /** The hold, so the sheet can name the amount the user is confirming. */
  readonly amountMinorUnits: number;
  readonly currency: string;
}

export type PaymentSheetResult =
  /** The user completed the sheet. The provider confirms the hold out of band. */
  | { readonly status: "authorized" }
  /** The user backed out. Nothing was authorized and nothing was charged. */
  | { readonly status: "cancelled" }
  /**
   * This build has no payment provider wired up. Separate from a failure
   * because it is not the user's card that is the problem, and no amount of
   * trying again will change the answer.
   */
  | { readonly status: "unavailable"; readonly message: string }
  /** The card was declined, or the sheet could not be completed. Retryable. */
  | { readonly status: "failed"; readonly message: string };

export interface PaymentSheet {
  present(request: PaymentSheetRequest): Promise<PaymentSheetResult>;
}

/** How a sheet is built. Substituted in tests; a build passes nothing. */
export type PaymentSheetFactory = () => PaymentSheet;

export const NO_PROVIDER_MESSAGE =
  "Deposits are not available in this build yet. You can still run a challenge with no deposit.";

/**
 * The sheet this build uses.
 *
 * There is no processor yet - the server runs its fake provider until counsel
 * and a real one approve the funds flow - so the honest answer is that a card
 * cannot be taken. It is deliberately not a stub that reports success: a sheet
 * that lied would put the user back on the same endless wait, only now
 * believing they had paid. Naming it means the screen offers the no-deposit
 * challenge instead, which is a product that works today.
 *
 * The real implementation replaces this function and nothing else.
 */
export function createConfiguredPaymentSheet(): PaymentSheet {
  return {
    present: async () => ({ status: "unavailable", message: NO_PROVIDER_MESSAGE }),
  };
}
