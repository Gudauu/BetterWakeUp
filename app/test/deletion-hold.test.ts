/**
 * What a funded challenge holding up deletion is told to say.
 *
 * The rule under test is the difference between "it can be deleted once that
 * challenge settles" and an answer: what is held, when it stops being held, and
 * what waiting costs. The paused case is the one worth pinning hardest, because
 * it is the only state with no date to wait for.
 */

import { deletionHold } from "../src/challenges/deletion-hold.ts";
import { challengeView } from "./support/fake-api.ts";

function funded(overrides: Parameters<typeof challengeView>[0] = {}) {
  const base = challengeView();
  return challengeView({
    configuration: { ...base.configuration, deposit: { amount: 2000, currency: "USD" } },
    ...overrides,
  });
}

describe("deletionHold", () => {
  it("says nothing when nothing is holding deletion up", () => {
    expect(deletionHold(null)).toBeNull();
    // An unfunded challenge holds no money, so deletion is not blocked at all.
    expect(deletionHold(challengeView())).toBeNull();
    // A settled challenge has nothing left on the card either.
    expect(deletionHold(funded({ status: "succeeded" }))).toBeNull();
  });

  it("names the amount held and the day a running challenge releases it", () => {
    const hold = deletionHold(funded({ projectedEndDate: "2026-10-12" }));

    expect(hold?.held).toContain("$20.00");
    expect(hold?.settles).toContain("Monday, October 12");
    // Only time settles a running challenge, so there is nothing to press.
    expect(hold?.action).toBeNull();
  });

  it("tells a paused challenge that nothing settles while it stands still", () => {
    const hold = deletionHold(
      funded({ pause: { pausedAt: "2026-09-02T09:00:00.000Z", expiresAt: null } }),
    );

    expect(hold?.settles).toContain("nothing settles while it stands still");
    // The date on a paused challenge is not a date to wait for, so the
    // projection must not be offered as one.
    expect(hold?.settles).not.toContain("October");
    expect(hold?.action).toEqual({ route: "pause", label: "Resume the challenge" });
  });

  it("sends an open recovery decision to the decision rather than to a date", () => {
    const hold = deletionHold(funded({ status: "recovery_pending" }));

    expect(hold?.settles).toContain("recovery decision is open");
    expect(hold?.action).toEqual({ route: "recovery", label: "Decide on your recovery" });
  });

  it("states that waiting is not itself a charge", () => {
    const hold = deletionHold(funded());

    expect(hold?.cost).toContain("Waiting costs nothing");
    expect(hold?.cost).toContain("missed morning");
  });
});
