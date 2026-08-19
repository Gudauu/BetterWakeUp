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
  PaymentMethodResult,
  PaymentSheet,
  PaymentSheetRequest,
  PaymentSheetResult,
} from "../../src/payments/payment-sheet.ts";

export interface FakePaymentSheet extends PaymentSheet {
  /** Every presentation, oldest first. */
  readonly presented: readonly PaymentSheetRequest[];
  /** How many times a card was asked for without authorizing anything. */
  collections(): number;
}

export function fakePaymentSheet(
  options: {
    /**
     * What the sheet answers, by attempt. A single result answers every
     * attempt; a function is how a declined card is followed by a good one.
     */
    answer?: PaymentSheetResult | ((attempt: number) => PaymentSheetResult);
    /**
     * What collecting a card answers, by attempt, the same way `answer` does.
     * A saved instrument by default, which is what the replacement path needs.
     */
    card?: PaymentMethodResult | ((attempt: number) => PaymentMethodResult);
    /** A sheet that could not be opened at all, which the screen must survive. */
    throws?: boolean;
  } = {},
): FakePaymentSheet {
  const presented: PaymentSheetRequest[] = [];
  const answer = options.answer ?? { status: "authorized" };
  const card = options.card ?? { status: "collected", providerPaymentMethodId: "pm_new" };
  let collected = 0;

  return {
    presented,
    collections: () => collected,
    async present(request) {
      presented.push(request);
      if (options.throws === true) {
        throw new Error("The sheet could not be opened.");
      }
      return typeof answer === "function" ? answer(presented.length - 1) : answer;
    },
    async collect() {
      collected += 1;
      if (options.throws === true) {
        throw new Error("The sheet could not be opened.");
      }
      return typeof card === "function" ? card(collected - 1) : card;
    },
  };
}
