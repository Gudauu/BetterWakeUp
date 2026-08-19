/**
 * The payment sheet this build ships with.
 *
 * There is no processor yet, so the only thing worth pinning is that the sheet
 * says so - clearly, and without pretending. A stub that answered "authorized"
 * would put the user back on the endless wait this port exists to end, and
 * would do it while they believed they had paid.
 */

import {
  createConfiguredPaymentSheet,
  NO_PROVIDER_MESSAGE,
} from "../src/payments/payment-sheet.ts";

const REQUEST = { clientSecret: "secret_abc", amountMinorUnits: 2000, currency: "USD" };

describe("the configured payment sheet", () => {
  it("reports that this build cannot take a card, rather than failing or claiming success", async () => {
    const result = await createConfiguredPaymentSheet().present(REQUEST);

    expect(result).toEqual({ status: "unavailable", message: NO_PROVIDER_MESSAGE });
  });

  it("says what the user can do instead", async () => {
    expect(NO_PROVIDER_MESSAGE).toMatch(/without a deposit|no deposit/i);
  });
});
