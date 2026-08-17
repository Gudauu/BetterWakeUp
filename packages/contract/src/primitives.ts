/**
 * Scalars shared by every request and response.
 *
 * These carry the product rules that are true of a value wherever it appears,
 * so a rule such as "a deposit is either nothing or at least a dollar" is
 * stated once and enforced identically by the app and the server.
 */

import { z } from "zod";

/** Header carrying the idempotency key on every state-changing client command. */
export const IDEMPOTENCY_HEADER = "idempotency-key";

/** Smallest funded deposit, in minor units. Below this the processor rejects the charge. */
export const MINIMUM_FUNDED_DEPOSIT_MINOR_UNITS = 100;

/** A funded challenge's projected end date may not fall further than this past funding. */
export const MAXIMUM_CHALLENGE_DURATION_DAYS = 365;

/** A completion is accepted this long after the deadline, to absorb network variance. */
export const RECEIPT_GRACE_SECONDS = 60;

/** How long an Emergency Recovery offer stands after the miss that opened it. */
export const RECOVERY_WINDOW_HOURS = 24;

/** A pause reaching this length closes the challenge as `expired`. */
export const MAXIMUM_PAUSE_DAYS = 365;

/**
 * The share of forfeit revenue, after processing costs, the platform commits
 * to donating.
 *
 * This is a public claim rather than a mechanism: no part of a deposit is
 * routed to a third party, and the donation happens outside this system. It
 * lives beside the protocol constants anyway, because the figure the app
 * discloses and the figure the platform publishes have to be the same one, and
 * two copies of a number are two chances for the claim to stop being true.
 */
export const DONATED_SHARE_OF_FORFEIT_PERCENT = 80;

/** An identifier the server minted. Opaque to the app, which only echoes it back. */
export const resourceId = z.uuid();

/**
 * Client-generated idempotency key. The app uses the pending completion
 * record's own ID, so the key is stable across every retry of that record.
 */
export const idempotencyKey = z.uuid();

/** An absolute instant, always serialized in UTC. */
export const instant = z.iso.datetime();

/** A calendar date in the challenge's time zone, with no offset attached. */
export const localDate = z.iso.date();

/** A wall-clock time of day in the challenge's time zone. */
export const localTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected a 24-hour HH:MM time of day");

/**
 * An IANA zone name such as `America/Los_Angeles`.
 *
 * Checked against the runtime's own zone database rather than a pattern, so a
 * well-formed name the server cannot do arithmetic in is still rejected.
 */
export const ianaTimeZone = z.string().refine(isKnownTimeZone, {
  error: "expected a time zone name the runtime recognizes",
});

function isKnownTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Version 1 prices in USD only. The column exists so a second currency is not a migration. */
export const currency = z.literal("USD");

/**
 * An amount in the currency's minor units.
 *
 * Money never appears as a decimal on the wire: `2000` is twenty dollars, and
 * no part of the system has to agree on a rounding rule.
 */
export const minorUnits = z.int().nonnegative();

/** A deposit is either nothing at all, or at least the processor's minimum. */
export const depositAmount = z
  .object({
    amount: minorUnits,
    currency,
  })
  .refine(
    (deposit) => deposit.amount === 0 || deposit.amount >= MINIMUM_FUNDED_DEPOSIT_MINOR_UNITS,
    { error: "a deposit is either zero or at least the funded minimum" },
  );

export const weekday = z.enum([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

export type ResourceId = z.infer<typeof resourceId>;
export type IdempotencyKey = z.infer<typeof idempotencyKey>;
export type Instant = z.infer<typeof instant>;
export type LocalDate = z.infer<typeof localDate>;
export type LocalTime = z.infer<typeof localTime>;
export type IanaTimeZone = z.infer<typeof ianaTimeZone>;
export type Currency = z.infer<typeof currency>;
export type MinorUnits = z.infer<typeof minorUnits>;
export type DepositAmount = z.infer<typeof depositAmount>;
export type Weekday = z.infer<typeof weekday>;
