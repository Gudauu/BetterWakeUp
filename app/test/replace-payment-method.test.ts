/**
 * The card that replaces the one which stopped working.
 *
 * Two things are worth pinning here. Which challenges are worth offering the
 * replacement for at all - a terminal one has no hold left, a zero-deposit one
 * never had a card - and what each refusal is said as, because "payment
 * declined" answered with "try again" would put the user in a loop with the
 * card their bank has already refused.
 */

import { ApiError } from "../src/api/errors.ts";
import {
  DECLINED_MESSAGE,
  needsPaymentMethod,
  replacePaymentMethod,
} from "../src/payments/replace-payment-method.ts";
import { challengeView, fakeApi, fundedChallengeView as funded } from "./support/fake-api.ts";

describe("which challenges want a new card", () => {
  it("wants one for a running funded challenge whose hold lapsed", () => {
    expect(needsPaymentMethod(funded({ depositSecured: false }))).toBe(true);
  });

  it("wants one while a recovery decision is open, since the deposit is still at stake", () => {
    expect(needsPaymentMethod(funded({ status: "recovery_pending", depositSecured: false }))).toBe(
      true,
    );
  });

  it("wants nothing while the deposit is secured", () => {
    expect(needsPaymentMethod(funded())).toBe(false);
  });

  it("wants nothing from a challenge that staked no money", () => {
    expect(needsPaymentMethod(challengeView({ depositSecured: false }))).toBe(false);
  });

  it("wants nothing from a challenge that has ended, which has no hold to keep", () => {
    expect(needsPaymentMethod(funded({ status: "failed", depositSecured: false }))).toBe(false);
  });
});

describe("replacing the payment method", () => {
  it("sends the instrument the sheet saved, under the challenge it secures", async () => {
    const challenge = funded({ depositSecured: false });
    const api = fakeApi({ replacePaymentMethod: { challenge: funded() } });

    const outcome = await replacePaymentMethod({
      api,
      challenge,
      providerPaymentMethodId: "pm_new",
    });

    expect(outcome).toEqual({ status: "done", value: { challenge: funded() } });
    expect(api.calls).toEqual([
      {
        name: "replacePaymentMethod",
        input: {
          params: { challengeId: challenge.id },
          body: { providerPaymentMethodId: "pm_new" },
        },
      },
    ]);
  });

  it("asks for nothing when no card was given", async () => {
    const api = fakeApi();

    const outcome = await replacePaymentMethod({
      api,
      challenge: funded({ depositSecured: false }),
      providerPaymentMethodId: "",
    });

    expect(outcome.status).toBe("blocked");
    expect(api.calls).toEqual([]);
  });

  it("says a decline is the bank's answer about that card, not a reason to retry it", async () => {
    const api = fakeApi({
      replacePaymentMethod: new ApiError("payment_declined", "declined", { status: 402 }),
    });

    const outcome = await replacePaymentMethod({
      api,
      challenge: funded({ depositSecured: false }),
      providerPaymentMethodId: "pm_bad",
    });

    expect(outcome).toEqual({ status: "failed", message: DECLINED_MESSAGE });
    expect(DECLINED_MESSAGE).toMatch(/different one/);
  });

  it("names the network when the request never left the device", async () => {
    const api = fakeApi({
      replacePaymentMethod: new ApiError("internal_error", "did not reach", { status: null }),
    });

    const outcome = await replacePaymentMethod({
      api,
      challenge: funded({ depositSecured: false }),
      providerPaymentMethodId: "pm_new",
    });

    expect(outcome).toMatchObject({
      status: "failed",
      message: expect.stringMatching(/connection/i),
    });
  });

  it("says the challenge ended rather than repeating a generic failure", async () => {
    const api = fakeApi({
      replacePaymentMethod: new ApiError("challenge_not_active", "over", { status: 409 }),
    });

    const outcome = await replacePaymentMethod({
      api,
      challenge: funded({ depositSecured: false }),
      providerPaymentMethodId: "pm_new",
    });

    expect(outcome).toMatchObject({
      status: "failed",
      message: expect.stringMatching(/has ended/),
    });
  });
});
