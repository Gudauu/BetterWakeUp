/**
 * How a refused walk is explained.
 *
 * The rule the whole module exists for: the stored error code decides what is
 * said, and the server's own message - which the contract declares is for
 * developers - is never read at all.
 */

import { ERROR_DISPOSITIONS, type ErrorCode } from "@betterwakeup/contract";
import { refusalReading } from "../src/completions/refusal.ts";

describe("the reading of a refusal", () => {
  it("names the deadline as the thing that was missed and rules out another walk", () => {
    const refusal = refusalReading("deadline_passed");

    expect(refusal.reason).toMatch(/after the deadline/);
    expect(refusal.nextStep).toMatch(/Emergency Recovery/);
    expect(refusal.canWalkAgain).toBe(false);
  });

  it("asks for another walk when the target was the only thing missing", () => {
    const refusal = refusalReading("step_target_not_met");

    expect(refusal.reason).toMatch(/under the step target/);
    expect(refusal.canWalkAgain).toBe(true);
  });

  it("tells a walk counted outside the app to be taken with the app open", () => {
    const refusal = refusalReading("movement_provenance_rejected");

    expect(refusal.reason).toMatch(/with the app open/);
    expect(refusal.nextStep).toMatch(/leave the app open until you save it/);
    expect(refusal.canWalkAgain).toBe(true);
  });

  it("treats a settled day as nothing to act on", () => {
    expect(refusalReading("task_already_resolved").canWalkAgain).toBe(false);
    expect(refusalReading("challenge_not_active").canWalkAgain).toBe(false);
  });

  it("falls back to one sentence for a code it has no wording for", () => {
    // `rate_limited` is a retry, so a record is never rejected with it; a
    // stored code the app does not recognise reaches the same answer.
    const unlisted = refusalReading("rate_limited");
    const nonsense = refusalReading("no_such_code_at_all");
    const missing = refusalReading(null);

    expect(nonsense).toEqual(unlisted);
    expect(missing).toEqual(unlisted);
    expect(unlisted.reason).toMatch(/could not accept this walk/);
  });

  it("never repeats the server's own words, whatever the code", () => {
    const codes = Object.keys(ERROR_DISPOSITIONS) as ErrorCode[];

    for (const code of codes) {
      const refusal = refusalReading(code);
      expect(refusal.reason.length).toBeGreaterThan(0);
      expect(refusal.nextStep.length).toBeGreaterThan(0);
      // The codes themselves are operator vocabulary and are not shown either.
      expect(`${refusal.reason} ${refusal.nextStep}`).not.toMatch(/_/);
    }
  });
});
