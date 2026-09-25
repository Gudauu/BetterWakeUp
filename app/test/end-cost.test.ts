/**
 * What ending a challenge early costs.
 *
 * The confirmation is the last thing between a press and a charge, so what is
 * pinned here is that the charge is named with its amount, that it is said to
 * happen now and to be final, and that the Emergency Recovery is never made to
 * sound like the price of leaving.
 */

import { endChallengeText } from "../src/challenges/end-cost.ts";
import { challengeView, fundedChallengeView } from "./support/fake-api.ts";

describe("what ending a challenge costs", () => {
  it("names the amount, that it is charged now, and that it cannot be undone", () => {
    const text = endChallengeText(fundedChallengeView({ recoveryAvailable: false }));

    expect(text).toContain("charges your $20.00 now");
    expect(text).toContain("cannot be undone");
    expect(text).not.toContain("Emergency Recovery");
  });

  it("says a held allowance is not spent by ending", () => {
    const text = endChallengeText(fundedChallengeView());

    expect(text).toContain("Emergency Recovery is not spent and stays with your account");
  });

  it("says an open offer is given up while the allowance stays for a future challenge", () => {
    const text = endChallengeText(fundedChallengeView({ status: "recovery_pending" }));

    expect(text).toContain("gives up this recovery offer");
    expect(text).toContain("charges your $20.00 now");
    expect(text).toContain("stays with your account for a future challenge");
  });

  it("says nothing is charged when nothing is staked", () => {
    const text = endChallengeText(challengeView());

    expect(text).toContain("charges nothing");
    expect(text).toContain("cannot be undone");
  });
});
