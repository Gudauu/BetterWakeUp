/**
 * Reading the money a challenge is staked with.
 *
 * The deposit was the one field the form still read by hand: every character
 * that was not a digit or a point was stripped, and whatever came out of
 * `parseFloat` was multiplied by a hundred with `|| 0` behind it. That silently
 * turned text it could not read into "no deposit at all", and it left the one
 * complaint about the amount - that a funded deposit is at least the
 * processor's minimum - to a banner made of the contract's own words rather
 * than a sentence under the box that caused it.
 *
 * So the reading moves here, beside the wake-up time's and the whole numbers':
 * what was typed becomes minor units, or a sentence saying what is wrong with
 * it. Everything is pure, so the rules are tested without rendering a form.
 *
 * The deposit differs from the other fields in two ways, and both are product
 * rules rather than parsing ones:
 *
 *  - An empty box is a real answer. Every other field refuses one, because a
 *    challenge with no step target is not a challenge; a challenge with no
 *    deposit is the product's own default.
 *  - A large amount is not refused. There is no maximum in the contract and the
 *    app has no business inventing one, but the difference between `20` and
 *    `200` is one keystroke and a hundred and eighty dollars, so an amount past
 *    the point where a slip stops being cheap is read back as a caution.
 *
 * @see readCount in ./counts.ts, which does the same job for the whole numbers.
 * @see readWakeTime in ./wake-time.ts, which does it for a deadline.
 */

import { MINIMUM_FUNDED_DEPOSIT_MINOR_UNITS } from "@betterwakeup/contract";
import { formatMoney } from "./draft.ts";

/** What the app shows for text that is not an amount of money. */
export const DEPOSIT_NOT_AN_AMOUNT = "Type an amount in dollars, like 20 or 19.99.";

/**
 * Money stops at cents. Its own sentence rather than the general one, because
 * the digits typed were digits and the mistake is how many of them.
 */
export const DEPOSIT_TOO_PRECISE = "Money goes down to cents, so two places after the point.";

/** An amount past what the contract's whole minor units can carry. */
export const DEPOSIT_TOO_LARGE = "That is more money than a deposit can hold.";

/** A funded deposit below the processor's minimum, named in the user's money. */
export const DEPOSIT_BELOW_MINIMUM = `A deposit is either nothing at all or at least ${formatMoney(
  MINIMUM_FUNDED_DEPOSIT_MINOR_UNITS,
)}.`;

/**
 * Where a mistyped deposit stops being cheap. Two hundred dollars is not a
 * refusal and not a limit: it is the point past which the app says the number
 * back out loud, because `200` and `20` are one keystroke apart and only one of
 * them is a hold the user meant to authorize.
 */
export const LARGE_DEPOSIT_MINOR_UNITS = 20_000;

export interface DepositReading {
  /**
   * The amount to store, or null while the text is not one the field accepts.
   * Zero is an accepted answer and not a refusal: it is the unfunded challenge.
   */
  readonly minorUnits: number | null;
  /** The one sentence to draw under the field, or null when it is fine. */
  readonly problem: string | null;
  /**
   * What the amount comes to, drawn under the box so the reading of `20` is
   * visibly twenty dollars rather than twenty cents. Null when there is a
   * problem, and null for an empty box, whose hint already says what nothing
   * means.
   */
  readonly reading: string | null;
  /**
   * The same read-back for an amount large enough to be worth checking, said in
   * the warning tone instead. Never set at the same time as `reading`.
   */
  readonly caution: string | null;
}

/**
 * The forms accepted:
 *
 *   ``  `   `      -> 0, the challenge with nothing but the habit at stake
 *   `20` `$20`     -> 2000, because the field asks in dollars
 *   `19.99` `.5`   -> 1999, 50
 *   `1,000`        -> 100000, a pasted amount with its thousands separators
 *   `0` `0.00`     -> 0, which is the same answer as an empty box
 *   `12.` `.`      -> refused while it is still being typed
 *   `19.999` `ten` -> refused, because neither is an amount of money
 *   `0.50`         -> refused, naming the processor's minimum
 */
export function readDeposit(text: string): DepositReading {
  const cleaned = text.trim().replace(/[\s,$]/g, "");
  if (cleaned.length === 0) {
    return { minorUnits: 0, problem: null, reading: null, caution: null };
  }
  const match = /^(\d*)(?:\.(\d*))?$/.exec(cleaned);
  if (match === null) {
    return refuse(DEPOSIT_NOT_AN_AMOUNT);
  }
  const whole = match[1] ?? "";
  const cents = match[2];
  // A point with nothing after it is a number mid-keystroke rather than a
  // mistake, but it is not an amount either, so the challenge cannot be staked
  // on it yet. `.` alone has no digits at all and lands here too.
  if (cents !== undefined && cents.length === 0) {
    return refuse(DEPOSIT_NOT_AN_AMOUNT);
  }
  if (cents !== undefined && cents.length > 2) {
    return refuse(DEPOSIT_TOO_PRECISE);
  }
  const minorUnits =
    Number(whole === "" ? "0" : whole) * 100 + Number((cents ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(minorUnits)) {
    return refuse(DEPOSIT_TOO_LARGE);
  }
  if (minorUnits > 0 && minorUnits < MINIMUM_FUNDED_DEPOSIT_MINOR_UNITS) {
    return refuse(DEPOSIT_BELOW_MINIMUM);
  }
  if (minorUnits === 0) {
    return { minorUnits: 0, problem: null, reading: null, caution: null };
  }
  const said = `That is ${formatMoney(minorUnits)} held on your card until you finish.`;
  return minorUnits >= LARGE_DEPOSIT_MINOR_UNITS
    ? {
        minorUnits,
        problem: null,
        reading: null,
        caution: `${said} Check that is the amount you meant.`,
      }
    : { minorUnits, problem: null, reading: said, caution: null };
}

function refuse(problem: string): DepositReading {
  return { minorUnits: null, problem, reading: null, caution: null };
}
