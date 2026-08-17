/**
 * The two parts of issue 24a that a request cannot demonstrate.
 *
 * The plan asks for one of them in as many words: **a failed renewal must never
 * fail a challenge**, asserted directly rather than as a consequence of other
 * logic. The integration suite asserts it for the decline it stages; this
 * asserts it for every decline there could ever be, by establishing that the
 * renewal path contains no writer that could fail a challenge and no call that
 * could move money.
 *
 * A source scan is blunt and is the right shape here for the same reason it was
 * for pause mode: the claim is about a module's whole reach rather than about
 * one code path, and a test that sends requests can only ever sample it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = join(import.meta.dirname, "..", "src");
const RENEWAL = readFileSync(join(SOURCE_ROOT, "payments", "renewal.ts"), "utf8");
const REPLACEMENT = readFileSync(
  join(SOURCE_ROOT, "challenges", "replace-payment-method.ts"),
  "utf8",
);

/** Everything a provider can be asked to do that moves money. */
const MONEY_MOVING_CALLS = ["captureAuthorization", "chargeOffSession", "recordUncollectedForfeit"];

describe("the renewal path", () => {
  it("never captures, charges, or forfeits", () => {
    for (const call of MONEY_MOVING_CALLS) {
      expect(RENEWAL).not.toContain(call);
      expect(REPLACEMENT).not.toContain(call);
    }
  });

  it("writes no ledger row, because replacing a hold moves no value", () => {
    for (const table of ["ledgerTransactions", "ledgerEntries"]) {
      expect(RENEWAL).not.toContain(table);
      expect(REPLACEMENT).not.toContain(table);
    }
  });

  it("never writes a challenge status, a terminal instant, or a task", () => {
    // The only column of `challenges` either module sets is `depositSecured`,
    // which is a statement about the deposit and not about the challenge's
    // outcome. Nothing here can end a challenge, whatever the card does.
    for (const source of [RENEWAL, REPLACEMENT]) {
      expect(source).not.toMatch(/status:\s*"(failed|expired|succeeded)"/);
      expect(source).not.toMatch(/terminalAt/);
      expect(source).not.toMatch(/scheduledTasks/);
      expect(source).not.toMatch(/paymentCommands/);
    }
  });

  it("takes the replacement hold before releasing the one it replaces", () => {
    // Order matters more than either call does: the release is reachable only
    // through the helper that runs after the replacement is committed.
    const takesReplacement = RENEWAL.indexOf("renewAuthorization(claimed.providerAuthorizationId)");
    const releasesOld = RENEWAL.indexOf("releaseSuperseded(options, supersededHold)");

    expect(takesReplacement).toBeGreaterThan(-1);
    expect(releasesOld).toBeGreaterThan(takesReplacement);
  });
});
