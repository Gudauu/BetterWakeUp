/**
 * When the first morning actually is, before anyone commits to it.
 *
 * The plan summary reads a configuration back as three dates and an amount, and
 * the one number a person weighs before pressing Start is missing from it: the
 * time they would have to be up and walking, and how soon that is. "First
 * morning: Tuesday, September 1" is the same sentence whether the deadline is
 * fourteen hours away or twenty minutes away, and those are opposite decisions.
 *
 * The server has answered this since the projection endpoint was written -
 * `firstTaskDeadline` carries the comment "so the app can show a real time" -
 * and the app read every other field of the same response and dropped that one.
 *
 * The staleness rule is the same one the schedule engine applies: a challenge
 * starts on the first morning whose No Regret cutoff is still ahead, so a
 * projection worked out before that cutoff describes a morning the server would
 * no longer choose. The projection is only re-asked when the configuration
 * changes, so nothing on the form corrects it on its own - which is exactly why
 * it has to be said rather than left to be discovered after the press.
 */

import type { CreateProjectionResponse } from "@betterwakeup/contract";
import { ALARM_LEAD_MINUTES } from "../reminders/reminders.ts";
import { formatDay, formatDuration, formatTimeOfDay } from "../ui/format.ts";

/**
 * How the wait until the first deadline reads.
 *
 * `closing` uses the alarm's own lead, the way every other countdown in the app
 * does: inside it the phone has no time left to wake anybody, so the challenge
 * would begin with a morning nothing but the user's own attention can meet.
 * `stale` is not a matter of urgency at all - it is the plan on screen having
 * stopped describing what the server would make.
 */
export type FirstMorningUrgency = "ample" | "closing" | "stale";

export interface FirstMorningReading {
  /** The first morning as the day and the time it is actually due. */
  readonly due: string;
  readonly urgency: FirstMorningUrgency;
  /** How far off that deadline is, said as a person would say it. */
  readonly countdown: string;
  /** The one thing worth saying before the press, or null when there is none. */
  readonly caution: string | null;
}

/**
 * The projection's first deadline, read against the clock.
 *
 * Null when the instant cannot be read at all, so a summary drawn over a
 * malformed answer keeps the plain date it always had rather than counting down
 * to nothing.
 */
export function firstMorningReading(input: {
  readonly projection: CreateProjectionResponse;
  readonly timeZone: string;
  readonly noRegretMinutes: number;
  readonly now: Date;
}): FirstMorningReading | null {
  const { projection, timeZone, noRegretMinutes, now } = input;
  const at = new Date(projection.firstTaskDeadline).getTime();
  if (Number.isNaN(at)) {
    return null;
  }

  const minutes = Math.floor((at - now.getTime()) / 60_000);
  const due = `${formatDay(projection.firstTaskDate)}, by ${formatTimeOfDay(projection.firstTaskDeadline, timeZone)}`;

  // The engine takes the first morning whose cutoff is still ahead, so at or
  // inside the cutoff this plan is describing a morning the server has already
  // passed over.
  if (minutes <= noRegretMinutes) {
    return {
      due,
      urgency: "stale",
      countdown:
        minutes < 0
          ? `That deadline passed ${formatDuration(-minutes)} ago.`
          : `That is only ${formatDuration(minutes)} from now.`,
      caution: staleCaution(noRegretMinutes),
    };
  }

  if (minutes <= ALARM_LEAD_MINUTES) {
    return {
      due,
      urgency: "closing",
      countdown: `That is ${formatDuration(minutes)} from now.`,
      caution: `Your first deadline is less than ${ALARM_LEAD_MINUTES} minutes away, which is sooner than this phone would set its alarm for, so nothing will wake you for it. Start now only if you can walk it straight away.`,
    };
  }

  return {
    due,
    urgency: "ample",
    countdown: `That is ${formatDuration(minutes)} from now.`,
    caution: null,
  };
}

function staleCaution(noRegretMinutes: number): string {
  const gone =
    noRegretMinutes === 0
      ? "That morning is already behind you"
      : "That deadline is now inside your No Regret Time, which is as good as behind you";
  return `${gone}, so BetterWakeUp would start you on the next morning your schedule holds. The first morning and the end date would both be later than the ones shown here.`;
}
