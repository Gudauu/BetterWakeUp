/**
 * Reading the numbers a challenge is configured with.
 *
 * The setup screen asks for three whole numbers - how many days, how many
 * steps, how many minutes - and each one was read by stripping every character
 * that was not a digit and calling an empty field zero. That is two defects in
 * one line: a field cleared to type a new number snapped back to `0` under the
 * cursor, so `30` could only be replaced by selecting the text first, and the
 * zero it wrote reached the contract's schema, which answered with a message
 * naming a path into the request body, drawn in a banner two cards below.
 *
 * So the reading moves here, beside the wake-up time's: what was typed becomes
 * a number, or a sentence saying what is wrong with it in the words the field
 * was labelled with. Everything is pure, so the rules are tested without
 * rendering a form.
 *
 * @see readWakeTime in ./wake-time.ts, which does the same job for a deadline.
 */

/** What the app should show for text that is not a number at all. */
export const COUNT_NOT_A_NUMBER = "Whole numbers only, with no decimal point.";

/**
 * A number past what the contract can carry. Its own sentence rather than the
 * general one, because the digits typed were digits and the mistake is size.
 */
export const COUNT_TOO_LARGE = "That number is larger than a challenge can hold.";

/**
 * One numeric field's own vocabulary: the smallest number it accepts, what to
 * say when it is empty, and what to say when the number is below the minimum.
 * The wording belongs to the field rather than to the reader because "at least
 * one day" and "at least one step" are different sentences about the same rule.
 */
export interface CountSpec {
  readonly minimum: number;
  /** Shown while the field holds nothing. */
  readonly missing: string;
  /** Shown for a number below the minimum. */
  readonly tooSmall: string;
}

export const DAYS_TO_COMPLETE: CountSpec = {
  minimum: 1,
  missing: "Type how many days you want to complete.",
  tooSmall: "A challenge needs at least one day to complete.",
};

export const STEP_TARGET: CountSpec = {
  minimum: 1,
  missing: "Type how many steps a morning walk has to reach.",
  tooSmall: "A morning needs a target of at least one step.",
};

/**
 * Zero is a real answer here - it means a skip may be asked for at any notice -
 * so this field's only complaint is an empty one.
 */
export const NO_REGRET_MINUTES: CountSpec = {
  minimum: 0,
  missing: "Type how many minutes you have to stay up for.",
  tooSmall: "Minutes cannot be negative.",
};

export interface CountReading {
  /** The number to store, or null while the text is not one the field accepts. */
  readonly count: number | null;
  /** The one sentence to draw under the field, or null when it is fine. */
  readonly problem: string | null;
}

/**
 * The forms accepted:
 *
 *   `30`  `030`   -> 30       digits, however they are padded
 *   `1,000` `1 000` -> 1000   a pasted number with its thousands separators
 *   ``            -> refused, because an empty field is not a zero
 *   `12.5` `many` -> refused, because a challenge counts whole things
 *
 * A number below the field's minimum is read - the digits are a number - and
 * carries the field's own complaint, so the screen can show what was typed
 * while refusing to configure a challenge with it.
 */
export function readCount(text: string, spec: CountSpec): CountReading {
  const cleaned = text.trim().replace(/[\s,]/g, "");
  if (cleaned.length === 0) {
    return { count: null, problem: spec.missing };
  }
  if (!/^\d+$/.test(cleaned)) {
    return { count: null, problem: COUNT_NOT_A_NUMBER };
  }
  const count = Number(cleaned);
  if (!Number.isSafeInteger(count)) {
    return { count: null, problem: COUNT_TOO_LARGE };
  }
  return count < spec.minimum ? { count: null, problem: spec.tooSmall } : { count, problem: null };
}
