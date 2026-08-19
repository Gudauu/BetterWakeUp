/**
 * The challenge being configured, held in memory and nowhere else.
 *
 * Product rule: nothing is saved until the challenge is created, so leaving
 * the app partway through discards the configuration. That is a property of
 * this module rather than a promise on a screen: it imports no storage, so
 * there is nowhere for a half-finished configuration to survive.
 *
 * Everything here is pure. The screen holds one draft in `useReducer`, and
 * every question it asks ("is this configuration valid", "what is still
 * missing before this can be created") is answered by a function a test can
 * call without rendering anything.
 */

import {
  type ChallengeConfiguration,
  challengeConfiguration,
  MINIMUM_FUNDED_DEPOSIT_MINOR_UNITS,
  outstandingDisclosures,
  type ScheduledWeekday,
  type Weekday,
} from "@betterwakeup/contract";

import { DAYS_TO_COMPLETE, NO_REGRET_MINUTES, STEP_TARGET } from "./counts.ts";

/**
 * The one currency the product takes a deposit in. Named here so the payment
 * sheet asks for the same money the configuration states, rather than the two
 * spelling it separately.
 */
export const DEPOSIT_CURRENCY = "USD";

/** Monday first, which is how the weekly schedule reads to a user. */
export const WEEKDAY_ORDER: readonly Weekday[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export interface ChallengeDraft {
  readonly requiredTaskCount: number;
  /** One entry per active weekday, each with its own wall-clock deadline. */
  readonly schedule: readonly ScheduledWeekday[];
  readonly stepTarget: number;
  readonly noRegretMinutes: number;
  /**
   * The zone the schedule is read in. Seeded from the device and confirmed by
   * the user, because a deadline in the wrong zone is a missed day.
   */
  readonly timeZone: string;
  readonly timeZoneConfirmed: boolean;
  readonly depositMinorUnits: number;
  readonly acknowledgedDisclosures: readonly string[];
}

/** The device's own zone, which is a proposal and not a decision. */
export function detectTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function createDraft(timeZone: string = detectTimeZone()): ChallengeDraft {
  return {
    requiredTaskCount: 30,
    schedule: ["monday", "tuesday", "wednesday", "thursday", "friday"].map((weekday) => ({
      weekday: weekday as Weekday,
      deadline: "07:00",
    })),
    stepTarget: 250,
    // Eight hours, the example product.md gives for No Regret Time.
    noRegretMinutes: 480,
    timeZone,
    timeZoneConfirmed: false,
    depositMinorUnits: 0,
    acknowledgedDisclosures: [],
  };
}

export type DraftAction =
  | { type: "setRequiredTaskCount"; count: number }
  | { type: "toggleWeekday"; weekday: Weekday }
  | { type: "setDeadline"; weekday: Weekday; deadline: string }
  | { type: "setStepTarget"; steps: number }
  | { type: "setNoRegretMinutes"; minutes: number }
  | { type: "setTimeZone"; timeZone: string }
  | { type: "setTimeZoneConfirmed"; confirmed: boolean }
  | { type: "setDeposit"; minorUnits: number }
  | { type: "acknowledgeDisclosure"; id: string }
  | { type: "withdrawDisclosure"; id: string };

export function draftReducer(draft: ChallengeDraft, action: DraftAction): ChallengeDraft {
  switch (action.type) {
    case "setRequiredTaskCount":
      return { ...draft, requiredTaskCount: action.count };
    case "toggleWeekday": {
      const active = draft.schedule.some((day) => day.weekday === action.weekday);
      const schedule = active
        ? draft.schedule.filter((day) => day.weekday !== action.weekday)
        : // A new day inherits the deadline already in use, so turning Saturday
          // on does not silently schedule it at some default hour.
          [
            ...draft.schedule,
            { weekday: action.weekday, deadline: draft.schedule[0]?.deadline ?? "07:00" },
          ];
      return { ...draft, schedule: sortSchedule(schedule) };
    }
    case "setDeadline":
      return {
        ...draft,
        schedule: draft.schedule.map((day) =>
          day.weekday === action.weekday ? { ...day, deadline: action.deadline } : day,
        ),
      };
    case "setStepTarget":
      return { ...draft, stepTarget: action.steps };
    case "setNoRegretMinutes":
      return { ...draft, noRegretMinutes: action.minutes };
    case "setTimeZone":
      // A zone the user changed is a zone they have not confirmed yet.
      return { ...draft, timeZone: action.timeZone, timeZoneConfirmed: false };
    case "setTimeZoneConfirmed":
      return { ...draft, timeZoneConfirmed: action.confirmed };
    case "setDeposit":
      return { ...draft, depositMinorUnits: action.minorUnits };
    case "acknowledgeDisclosure":
      return draft.acknowledgedDisclosures.includes(action.id)
        ? draft
        : { ...draft, acknowledgedDisclosures: [...draft.acknowledgedDisclosures, action.id] };
    case "withdrawDisclosure":
      return {
        ...draft,
        acknowledgedDisclosures: draft.acknowledgedDisclosures.filter((id) => id !== action.id),
      };
  }
}

function sortSchedule(schedule: readonly ScheduledWeekday[]): readonly ScheduledWeekday[] {
  return [...schedule].sort(
    (a, b) => WEEKDAY_ORDER.indexOf(a.weekday) - WEEKDAY_ORDER.indexOf(b.weekday),
  );
}

/**
 * The configuration the draft describes, or the reasons it does not describe
 * one yet.
 *
 * The contract's own schema is the judge, so the app refuses exactly what the
 * server would refuse rather than keeping a second copy of the rules. The one
 * rule stated here is the deposit gap, because "either nothing or at least a
 * dollar" needs a sentence rather than a schema error.
 */
export type DraftConfiguration =
  | { readonly ok: true; readonly configuration: ChallengeConfiguration }
  | { readonly ok: false; readonly problems: readonly string[] };

export function configurationOf(draft: ChallengeDraft): DraftConfiguration {
  const problems: string[] = [];
  if (draft.depositMinorUnits > 0 && draft.depositMinorUnits < MINIMUM_FUNDED_DEPOSIT_MINOR_UNITS) {
    problems.push(
      `A deposit is either nothing at all or at least ${formatMoney(MINIMUM_FUNDED_DEPOSIT_MINOR_UNITS)}.`,
    );
  }

  const parsed = challengeConfiguration.safeParse({
    requiredTaskCount: draft.requiredTaskCount,
    schedule: draft.schedule,
    stepTarget: draft.stepTarget,
    noRegretMinutes: draft.noRegretMinutes,
    timeZone: draft.timeZone,
    deposit: { amount: draft.depositMinorUnits, currency: DEPOSIT_CURRENCY },
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      problems.push(describeIssue(issue.path.join("."), issue.message));
    }
  }

  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, configuration: parsed.data as ChallengeConfiguration };
}

/**
 * The schema's complaints in the words the form uses.
 *
 * A path into the request body is the right thing to log and the wrong thing to
 * show: `stepTarget: Too small: expected number to be >=1` names a field the
 * user never saw under that name. Every field the form can actually put in this
 * state has its sentence here, and the wording is shared with the field's own
 * reader so the banner and the line under the box cannot disagree.
 */
const PROBLEM_BY_PATH: Readonly<Record<string, string>> = {
  requiredTaskCount: DAYS_TO_COMPLETE.tooSmall,
  schedule: "Pick at least one morning for your challenge.",
  stepTarget: STEP_TARGET.tooSmall,
  noRegretMinutes: NO_REGRET_MINUTES.tooSmall,
  timeZone: "That time zone is not one deadlines can be read in.",
};

function describeIssue(path: string, message: string): string {
  return PROBLEM_BY_PATH[path] ?? message;
}

/** `2000` reads as `$20.00`, which is the only place the app writes dollars. */
export function formatMoney(minorUnits: number): string {
  return `$${(minorUnits / 100).toFixed(2)}`;
}

/**
 * Everything still standing between this draft and a challenge.
 *
 * `blockingDeposit` is the acceptance boundary of this issue: while it holds
 * anything, the action that would take the user's money is not offered and
 * would be refused if it were.
 */
export interface DraftReadiness {
  readonly configuration: DraftConfiguration;
  readonly timeZoneConfirmed: boolean;
  readonly outstandingDisclosureIds: readonly string[];
  readonly ready: boolean;
}

export function readinessOf(draft: ChallengeDraft): DraftReadiness {
  const configuration = configurationOf(draft);
  const outstanding = outstandingDisclosures(
    draft.depositMinorUnits,
    draft.acknowledgedDisclosures,
  ).map((item) => item.id);
  return {
    configuration,
    timeZoneConfirmed: draft.timeZoneConfirmed,
    outstandingDisclosureIds: outstanding,
    ready: configuration.ok && draft.timeZoneConfirmed && outstanding.length === 0,
  };
}
