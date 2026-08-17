/**
 * The draft and the disclosures: what a configuration has to be before it can
 * become a challenge, and what the user has to have been told.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MINIMUM_FUNDED_DEPOSIT_MINOR_UNITS, RECOVERY_WINDOW_HOURS } from "@betterwakeup/contract";
import {
  DISCLOSURES,
  disclosuresFor,
  outstandingDisclosures,
} from "../src/challenges/disclosures.ts";
import {
  type ChallengeDraft,
  configurationOf,
  createDraft,
  draftReducer,
  formatMoney,
  readinessOf,
} from "../src/challenges/draft.ts";

const ZONE = "America/Los_Angeles";

function acknowledgedDraft(overrides: Partial<ChallengeDraft> = {}): ChallengeDraft {
  const base: ChallengeDraft = {
    ...createDraft(ZONE),
    timeZoneConfirmed: true,
    ...overrides,
  };
  return {
    ...base,
    acknowledgedDisclosures: disclosuresFor(base.depositMinorUnits).map((item) => item.id),
  };
}

describe("the draft describes a configuration", () => {
  it("starts as a valid zero deposit configuration", () => {
    const result = configurationOf(createDraft(ZONE));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.configuration.deposit).toEqual({ amount: 0, currency: "USD" });
      expect(result.configuration.schedule).toHaveLength(5);
      expect(result.configuration.timeZone).toBe(ZONE);
    }
  });

  it("refuses a deposit in the gap between nothing and the funded minimum", () => {
    // Not a preference: a processor rejects charges this small, so the product
    // offers no stake instead of a tiny one.
    const result = configurationOf({
      ...createDraft(ZONE),
      depositMinorUnits: MINIMUM_FUNDED_DEPOSIT_MINOR_UNITS - 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.join(" ")).toContain(formatMoney(MINIMUM_FUNDED_DEPOSIT_MINOR_UNITS));
    }
  });

  it("accepts the funded minimum itself", () => {
    const result = configurationOf({
      ...createDraft(ZONE),
      depositMinorUnits: MINIMUM_FUNDED_DEPOSIT_MINOR_UNITS,
    });

    expect(result.ok).toBe(true);
  });

  it("refuses a schedule with no active day", () => {
    const result = configurationOf({ ...createDraft(ZONE), schedule: [] });

    expect(result.ok).toBe(false);
  });

  it("refuses a deadline that is not a time of day", () => {
    const draft = draftReducer(createDraft(ZONE), {
      type: "setDeadline",
      weekday: "monday",
      deadline: "7am",
    });

    expect(configurationOf(draft).ok).toBe(false);
  });

  it("refuses a time zone the runtime does not know", () => {
    const draft = draftReducer(createDraft(ZONE), {
      type: "setTimeZone",
      timeZone: "Mars/Olympus_Mons",
    });

    expect(configurationOf(draft).ok).toBe(false);
  });
});

describe("editing the draft", () => {
  it("keeps the schedule in weekday order and gives a new day the deadline already in use", () => {
    const started = draftReducer(createDraft(ZONE), {
      type: "setDeadline",
      weekday: "monday",
      deadline: "06:30",
    });

    const withSaturday = draftReducer(started, { type: "toggleWeekday", weekday: "saturday" });

    expect(withSaturday.schedule.map((day) => day.weekday)).toEqual([
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
    ]);
    expect(withSaturday.schedule.at(-1)?.deadline).toBe("06:30");
  });

  it("removes a weekday that is toggled off", () => {
    const withoutMonday = draftReducer(createDraft(ZONE), {
      type: "toggleWeekday",
      weekday: "monday",
    });

    expect(withoutMonday.schedule.some((day) => day.weekday === "monday")).toBe(false);
  });

  it("withdraws the time zone confirmation when the zone changes", () => {
    // A confirmation is about one zone. Carrying it to another would be
    // recording an answer to a question that was never asked.
    const confirmed = draftReducer(createDraft(ZONE), {
      type: "setTimeZoneConfirmed",
      confirmed: true,
    });

    const moved = draftReducer(confirmed, { type: "setTimeZone", timeZone: "Europe/Berlin" });

    expect(moved.timeZoneConfirmed).toBe(false);
  });

  it("acknowledges once however many times it is told to, and forgets on withdrawal", () => {
    const once = draftReducer(createDraft(ZONE), {
      type: "acknowledgeDisclosure",
      id: "synchronization-required",
    });
    const twice = draftReducer(once, {
      type: "acknowledgeDisclosure",
      id: "synchronization-required",
    });

    expect(twice.acknowledgedDisclosures).toEqual(["synchronization-required"]);
    expect(
      draftReducer(twice, { type: "withdrawDisclosure", id: "synchronization-required" })
        .acknowledgedDisclosures,
    ).toEqual([]);
  });
});

describe("the disclosures", () => {
  it("has a distinct id for every item", () => {
    expect(new Set(DISCLOSURES.map((item) => item.id)).size).toBe(DISCLOSURES.length);
  });

  it("keeps the money items away from a challenge with no money in it", () => {
    const free = disclosuresFor(0);

    expect(free.every((item) => item.scope === "all")).toBe(true);
    expect(free.length).toBeLessThan(disclosuresFor(2000).length);
  });

  it("states the length of the Emergency Recovery offer before a deposit", () => {
    // product.md requires this one by name: the offer's length must be
    // disclosed before the user deposits.
    const recovery = disclosuresFor(2000).find((item) => item.id === "recovery-offer-window");

    expect(recovery?.statement).toContain(String(RECOVERY_WINDOW_HOURS));
    expect(disclosuresFor(0).some((item) => item.id === "recovery-offer-window")).toBe(false);
  });

  it("names every applicable item that has not been acknowledged", () => {
    const outstanding = outstandingDisclosures(2000, ["synchronization-required"]);

    expect(outstanding.map((item) => item.id)).not.toContain("synchronization-required");
    expect(outstanding).toHaveLength(disclosuresFor(2000).length - 1);
  });
});

describe("readiness", () => {
  it("is not ready while any applicable disclosure is outstanding", () => {
    const draft = acknowledgedDraft({ depositMinorUnits: 2000 });
    const short = { ...draft, acknowledgedDisclosures: draft.acknowledgedDisclosures.slice(1) };

    expect(readinessOf(short).ready).toBe(false);
    expect(readinessOf(draft).ready).toBe(true);
  });

  it("is not ready while the time zone is unconfirmed", () => {
    expect(readinessOf({ ...acknowledgedDraft(), timeZoneConfirmed: false }).ready).toBe(false);
  });

  it("is not ready while the configuration is invalid", () => {
    expect(readinessOf({ ...acknowledgedDraft(), stepTarget: 0 }).ready).toBe(false);
  });

  it("counts a funded draft's money disclosures too", () => {
    // The same acknowledgements that are enough at zero deposit are not enough
    // once there is money at stake.
    const free = acknowledgedDraft();

    expect(readinessOf({ ...free, depositMinorUnits: 2000 }).ready).toBe(false);
  });
});

describe("the draft is held in memory and nowhere else", () => {
  it("imports nothing that could persist it", () => {
    // Product rule: leaving the app partway through discards the
    // configuration. There is nowhere for it to survive if this holds.
    const source = readFileSync(join(__dirname, "../src/challenges/draft.ts"), "utf8");

    for (const storage of [
      "expo-secure-store",
      "expo-sqlite",
      "async-storage",
      "expo-file-system",
    ]) {
      expect(source).not.toContain(storage);
    }
  });
});
