/**
 * A payment sheet that records what it was asked to authorize.
 *
 * The provider's real sheet is a native modal, so nothing about the funded path
 * could be walked in a test without one of these. What it records is what the
 * assertions are about: that the app asks for a card at all, that it asks for
 * the intent's own client secret and the deposit the user typed, and that each
 * answer - authorized, cancelled, declined - lands the user somewhere sensible.
 */

import type {
  PaymentSheet,
  PaymentSheetRequest,
  PaymentSheetResult,
} from "../../src/payments/payment-sheet.ts";

export interface FakePaymentSheet extends PaymentSheet {
  /** Every presentation, oldest first. */
  readonly presented: readonly PaymentSheetRequest[];
}

export function fakePaymentSheet(
  options: {
    /**
     * What the sheet answers, by attempt. A single result answers every
     * attempt; a function is how a declined card is followed by a good one.
     */
    answer?: PaymentSheetResult | ((attempt: number) => PaymentSheetResult);
    /** A sheet that could not be opened at all, which the screen must survive. */
    throws?: boolean;
  } = {},
): FakePaymentSheet {
  const presented: PaymentSheetRequest[] = [];
  const answer = options.answer ?? { status: "authorized" };

  return {
    presented,
    async present(request) {
      presented.push(request);
      if (options.throws === true) {
        throw new Error("The sheet could not be opened.");
      }
      return typeof answer === "function" ? answer(presented.length - 1) : answer;
    },
  };
}
