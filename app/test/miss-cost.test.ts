/**
 * What one missed morning would cost.
 *
 * The rule is the sweep's and the server states it per challenge; what is
 * pinned here is that the app words the three situations differently, that it
 * raises its voice only where the safety net is gone, and that it says nothing
 * where a miss is not the question on screen.
 */

import { missCost } from "../src/challenges/miss-cost.ts";
import { challengeView, fundedChallengeView, PAUSED_AT, taskView } from "./support/fake-api.ts";

describe("what a miss would cost", () => {
  it("names the money and the allowance while both stand", () => {
    const cost = missCost(fundedChallengeView());

    expect(cost?.text).toContain("$20.00");
    expect(cost?.text).toContain("one lifetime Emergency Recovery");
    expect(cost?.text).toContain("24 hours");
    // A safety net that is still there is a fact, not an alarm.
    expect(cost?.tone).toBe("muted");
  });

  it("says the net is gone once the allowance is spent, and raises its voice", () => {
    const cost = missCost(fundedChallengeView({ recoveryAvailable: false }));

    expect(cost?.text).toContain("already spent");
    expect(cost?.text).toContain("ends this challenge and charges your $20.00");
    expect(cost?.tone).toBe("warning");
  });

  it("says a challenge staking nothing still ends on a miss", () => {
    const cost = missCost(challengeView());

    expect(cost?.text).toContain("costs no money");
    expect(cost?.text).toContain("It does end the challenge");
    expect(cost?.tone).toBe("muted");
  });

  it("says nothing while a recovery offer is already standing", () => {
    // The offer and its countdown are on screen above this; a challenge in
    // `recovery_pending` is living the answer rather than planning for it.
    expect(missCost(fundedChallengeView({ status: "recovery_pending" }))).toBeNull();
  });

  it("says nothing about a challenge that has ended", () => {
    expect(missCost(fundedChallengeView({ status: "failed" }))).toBeNull();
  });

  it("says nothing while a pause has taken the morning away", () => {
    expect(
      missCost(
        fundedChallengeView({
          pause: { pausedAt: PAUSED_AT, expiresAt: null },
          currentTask: null,
        }),
      ),
    ).toBeNull();
  });

  it("still says it for a task that stayed live through a pause", () => {
    // The server keeps a task whose pause cutoff had already passed, so a
    // paused challenge can still lose a morning and its deposit with it.
    const cost = missCost(
      fundedChallengeView({
        pause: { pausedAt: PAUSED_AT, expiresAt: null },
        currentTask: taskView(),
      }),
    );

    expect(cost).not.toBeNull();
  });
});
