/**
 * Reading a wake-up time the way somebody types one.
 *
 * The contract's `localTime` is a strict 24-hour `HH:MM`, and that is the right
 * thing to send: the server computes a real instant from it and a loose format
 * would be a wrong deadline rather than a rejected one. It is the wrong thing
 * to demand of a user, though. Somebody putting money on getting up at seven
 * types `7`, or `7:00 AM`, or `700`, and the strict field answered every one of
 * those with a schema message naming a path into the request body.
 *
 * So the strictness stays and the typing gets forgiving: this module turns what
 * was typed into the canonical form, or says - in one sentence, without a path
 * in it - that it is not a time yet. Everything here is pure, so the rule is
 * tested without rendering a field.
 */

/** What the app should show for a time it does not accept yet. */
export const WAKE_TIME_PROBLEM = "Not a time yet. Try 7:00 AM, 7am, or 06:30.";

/**
 * A time that parses but names an hour that does not exist. Separated from the
 * general problem because "25:00" is a different mistake from "morning" and the
 * user is one keystroke from fixing it.
 */
export const WAKE_TIME_OUT_OF_RANGE =
  "There is no such time of day. Hours run 12:00 AM to 11:59 PM.";

export interface WakeTimeReading {
  /** The canonical `HH:MM` to store, or null while the text is not a time. */
  readonly wallClock: string | null;
  /** The one sentence to draw under the field, or null when it is fine. */
  readonly problem: string | null;
}

/**
 * The forms accepted, in the order a person is likely to produce them:
 *
 *   `7` `07`            -> 07:00      a bare hour, which is how most alarms are said
 *   `7:5`               -> not a time, because `7:5` is ambiguous between :05 and :50
 *   `7:30` `07:30`      -> 07:30
 *   `730` `0730`        -> 07:30      the digits without the colon
 *   `7am` `7 AM`        -> 07:00
 *   `7:30 pm` `730pm`   -> 19:30
 *   `19:30`             -> 19:30
 *
 * A meridiem is only meaningful on a 1-12 hour, so `19 pm` is refused rather
 * than guessed at, and `12 AM` is midnight while `12 PM` is noon - the one pair
 * everybody gets wrong, and the one the arithmetic below has to get right.
 */
export function readWakeTime(text: string): WakeTimeReading {
  const cleaned = text.trim().toLowerCase().replace(/\s+/g, "");
  if (cleaned.length === 0) {
    return { wallClock: null, problem: WAKE_TIME_PROBLEM };
  }

  const meridiem = /(am|pm)\.?$/.exec(cleaned);
  const digits = meridiem === null ? cleaned : cleaned.slice(0, meridiem.index);
  const parsed = splitDigits(digits);
  if (parsed === null) {
    return { wallClock: null, problem: WAKE_TIME_PROBLEM };
  }

  const { hour, minute } = parsed;
  if (minute > 59) {
    return { wallClock: null, problem: WAKE_TIME_OUT_OF_RANGE };
  }

  if (meridiem === null) {
    return hour > 23
      ? { wallClock: null, problem: WAKE_TIME_OUT_OF_RANGE }
      : { wallClock: pad(hour, minute), problem: null };
  }

  if (hour === 0 || hour > 12) {
    return { wallClock: null, problem: WAKE_TIME_OUT_OF_RANGE };
  }
  const afternoon = meridiem[1] === "pm";
  const hour24 = hour === 12 ? (afternoon ? 12 : 0) : afternoon ? hour + 12 : hour;
  return { wallClock: pad(hour24, minute), problem: null };
}

/**
 * The digits, however they were grouped. A colon says where the split is; a run
 * of digits without one is split by length, which is the convention a keypad
 * user already has from every microwave and oven they own.
 */
function splitDigits(digits: string): { hour: number; minute: number } | null {
  const colon = /^(\d{1,2}):(\d{2})$/.exec(digits);
  if (colon !== null) {
    return { hour: Number(colon[1]), minute: Number(colon[2]) };
  }
  if (!/^\d+$/.test(digits)) {
    return null;
  }
  switch (digits.length) {
    case 1:
    case 2:
      return { hour: Number(digits), minute: 0 };
    case 3:
      return { hour: Number(digits.slice(0, 1)), minute: Number(digits.slice(1)) };
    case 4:
      return { hour: Number(digits.slice(0, 2)), minute: Number(digits.slice(2)) };
    default:
      return null;
  }
}

function pad(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
