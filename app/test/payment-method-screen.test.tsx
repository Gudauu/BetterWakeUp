/**
 * The screen behind home's "your card no longer secures this deposit".
 *
 * The user arriving here is worried about money, so what these tests pin is
 * what they are told: that the challenge is unaffected, that the amount is held
 * rather than charged, and that each way the card can fail - backed out,
 * declined, no provider at all - leaves them somewhere rather than on a dead
 * button.
 */

import { render, screen, userEvent } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ApiError } from "../src/api/errors.ts";
import { NO_PROVIDER_CARD_MESSAGE } from "../src/payments/payment-sheet.ts";
import { PaymentMethodScreen } from "../src/screens/payment-method-screen.tsx";
import { challengeView, type FakeApi, fakeApi, fundedChallengeView } from "./support/fake-api.ts";
import { type FakePaymentSheet, fakePaymentSheet } from "./support/fake-payment-sheet.ts";

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/** A running challenge with $20 on it whose hold could not be renewed. */
function unsecured() {
  return fundedChallengeView({ depositSecured: false });
}

async function drawScreen(
  options: { api?: FakeApi; sheet?: FakePaymentSheet; onSecured?: () => void } = {},
) {
  const api = options.api ?? fakeApi({ replacePaymentMethod: { challenge: challengeView() } });
  const sheet = options.sheet ?? fakePaymentSheet();
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <PaymentMethodScreen
        api={api}
        challenge={unsecured()}
        sheet={sheet}
        {...(options.onSecured === undefined ? {} : { onSecured: options.onSecured })}
      />
    </SafeAreaProvider>,
  );
  return { api, sheet };
}

describe("PaymentMethodScreen", () => {
  it("names the amount and says the challenge itself is unchanged", async () => {
    await drawScreen();

    expect(screen.getByTestId("payment-method-summary")).toHaveTextContent(/\$20\.00 hold/);
    expect(screen.getByTestId("payment-method-unchanged")).toHaveTextContent(/still running/);
  });

  it("asks for no card until the user presses for one", async () => {
    const { sheet } = await drawScreen();

    expect(sheet.collections()).toBe(0);
  });

  it("puts the card the sheet saved in place of the one that lapsed", async () => {
    const user = userEvent.setup();
    const { api, sheet } = await drawScreen();

    await user.press(screen.getByTestId("payment-method-add"));

    expect(sheet.collections()).toBe(1);
    expect(await screen.findByTestId("payment-method-done")).toBeOnTheScreen();
    expect(api.calls).toEqual([
      {
        name: "replacePaymentMethod",
        input: {
          params: { challengeId: unsecured().id },
          body: { providerPaymentMethodId: "pm_new" },
        },
      },
    ]);
    expect(screen.getByTestId("payment-method-secured")).toHaveTextContent(/\$20\.00/);
  });

  it("hands the caller back only once a card is in place", async () => {
    const user = userEvent.setup();
    let secured = 0;
    await drawScreen({
      onSecured: () => {
        secured += 1;
      },
    });

    await user.press(screen.getByTestId("payment-method-add"));
    expect(await screen.findByTestId("payment-method-done")).toBeOnTheScreen();
    expect(secured).toBe(0);

    await user.press(screen.getByTestId("payment-method-done-back"));
    expect(secured).toBe(1);
  });

  it("says nothing was charged when the user backs out of the sheet", async () => {
    const user = userEvent.setup();
    const { api } = await drawScreen({
      sheet: fakePaymentSheet({ card: { status: "cancelled" } }),
    });

    await user.press(screen.getByTestId("payment-method-add"));

    expect(await screen.findByTestId("payment-method-problem")).toHaveTextContent(
      /Nothing was charged/,
    );
    // A card nobody gave is not a card to send, so the server was never asked.
    expect(api.calls).toEqual([]);
    expect(screen.getByTestId("payment-method-add")).toBeOnTheScreen();
  });

  it("asks for a different card when the bank declines the new one", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      replacePaymentMethod: new ApiError("payment_declined", "declined", { status: 402 }),
    });
    await drawScreen({ api });

    await user.press(screen.getByTestId("payment-method-add"));

    expect(await screen.findByTestId("payment-method-problem")).toHaveTextContent(
      /Try a different one/,
    );
    expect(screen.queryByTestId("payment-method-done")).toBeNull();
  });

  it("survives a sheet that will not open", async () => {
    const user = userEvent.setup();
    await drawScreen({ sheet: fakePaymentSheet({ throws: true }) });

    await user.press(screen.getByTestId("payment-method-add"));

    expect(await screen.findByTestId("payment-method-problem")).toBeOnTheScreen();
  });

  it("stops offering a card this build cannot take, and says the challenge runs on", async () => {
    const user = userEvent.setup();
    await drawScreen({
      sheet: fakePaymentSheet({
        card: { status: "unavailable", message: NO_PROVIDER_CARD_MESSAGE },
      }),
    });

    await user.press(screen.getByTestId("payment-method-add"));

    expect(await screen.findByTestId("payment-method-unavailable")).toHaveTextContent(
      /keeps running/,
    );
    expect(screen.queryByTestId("payment-method-add")).toBeNull();
    expect(screen.getByTestId("payment-method-unavailable-back")).toBeOnTheScreen();
  });
});
