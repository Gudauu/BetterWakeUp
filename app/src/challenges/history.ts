/**
 * The month so far, as a row of days.
 *
 * A challenge is thirty mornings, and until now the app said so with two
 * numbers - "4 of 30 days done" - which is a fact about a spreadsheet rather
 * than a thing anyone gets out of bed for. The row of days is what makes the
 * month legible: yesterday is on it, the day that broke a run is on it, and the
 * days still ahead are on it, so a user can see the shape of what they have
 * done and what is left rather than a fraction of it.
 *
 * Nothing here asks the server anything. `challenge.days` is the challenge's own
 * calendar, materialized when it activated, so the whole row is already in the
 * read home performs at launch.
 *
 * Nothing here decides what a day *means*, either: a day's status is the
 * server's word, and this only re-reads it from the user's side - "kept",
 * "missed" - and finds where the current one is.
 */

import type { ChallengeDay, ChallengeView } from "@betterwakeup/contract";

/**
 * What a day is to the person who lived it.
 *
 * `due` and `ahead` are both the server's `scheduled`, split because the day
 * being asked for right now is the only one the user can still act on, and a
 * row that drew it like next Thursday would hide the one day that matters.
 */
export type DayState = "kept" | "missed" | "forgiven" | "skipped" | "due" | "ahead";

export interface HistoryDay {
  readonly date: string;
  readonly state: DayState;
}

export interface ChallengeHistory {
  /** Every day the challenge holds, oldest first. Empty before it activates. */
  readonly days: readonly HistoryDay[];
  /**
   * Walked days in an unbroken run ending at the last day already decided. A
   * day that was missed, skipped or forgiven ends a run: only a walk continues
   * one, because the streak is a count of mornings the user actually got up.
   */
  readonly streak: number;
  /** Days already decided, however they went. What the row has behind it. */
  readonly decided: number;
}

const DECIDED: Readonly<Record<DayState, boolean>> = {
  kept: true,
  missed: true,
  forgiven: true,
  skipped: true,
  due: false,
  ahead: false,
};

/**
 * The challenge's days, read from the user's side.
 *
 * The first `scheduled` day is the one due now - the same day `currentTask`
 * names - because the server hands out one open task at a time and materializes
 * them in date order. Reading it from the row rather than comparing identifiers
 * keeps this a function of the calendar alone, so a paused challenge whose
 * `currentTask` is null still draws the next morning as the one coming.
 */
export function challengeHistory(challenge: ChallengeView): ChallengeHistory {
  let seenScheduled = false;
  const days = challenge.days.map((day) => {
    const state = stateOf(day, seenScheduled);
    if (day.status === "scheduled") {
      seenScheduled = true;
    }
    return { date: day.date, state };
  });
  const decided = days.filter((day) => DECIDED[day.state]).length;
  return { days, streak: streakOf(days), decided };
}

function stateOf(day: ChallengeDay, seenScheduled: boolean): DayState {
  switch (day.status) {
    case "completed":
      return "kept";
    case "missed":
      return "missed";
    case "forgiven":
      return "forgiven";
    case "skipped":
      return "skipped";
    default:
      return seenScheduled ? "ahead" : "due";
  }
}

/**
 * The run ending at the last decided day.
 *
 * Counting back from the end of the decided days rather than forward from the
 * start is what makes this the *current* run: a user who kept ten days, missed
 * one and kept two is on two, and hearing "ten" would be a congratulation for
 * something that is over.
 */
function streakOf(days: readonly HistoryDay[]): number {
  let streak = 0;
  for (let index = days.length - 1; index >= 0; index -= 1) {
    const day = days[index];
    if (day === undefined || !DECIDED[day.state]) {
      continue;
    }
    if (day.state !== "kept") {
      break;
    }
    streak += 1;
  }
  return streak;
}

/**
 * The row of days as a sentence, for a reader who is not looking at it.
 *
 * Colour is the whole of what the row says visually, so without this the strip
 * would be thirty squares announcing nothing. It names the counts rather than
 * reading the days out one by one, because "four kept, one missed" is what a
 * glance at the row gives and thirty dates is not.
 */
export function historyLabel(history: ChallengeHistory): string {
  const counts = { kept: 0, missed: 0, forgiven: 0, skipped: 0, ahead: 0 };
  for (const day of history.days) {
    if (day.state === "due" || day.state === "ahead") {
      counts.ahead += 1;
    } else {
      counts[day.state] += 1;
    }
  }
  const parts = [
    `${counts.kept} kept`,
    counts.missed === 0 ? null : `${counts.missed} missed`,
    counts.forgiven === 0 ? null : `${counts.forgiven} forgiven`,
    counts.skipped === 0 ? null : `${counts.skipped} skipped`,
    `${counts.ahead} still to come`,
  ].filter((part): part is string => part !== null);
  return `Your days: ${parts.join(", ")}.`;
}

/**
 * The line over the row of days, or null when there is nothing worth saying.
 *
 * One kept day is not a streak, and saying "1 day in a row" on the morning
 * after the first walk reads as a machine counting rather than anyone noticing.
 * A broken run is not mentioned at all: the row already shows the day that
 * broke it, and a sentence about it would be the app scolding someone who
 * turned up today.
 */
export function streakSentence(history: ChallengeHistory): string | null {
  if (history.streak < 2) {
    return null;
  }
  return `${history.streak} days in a row.`;
}
