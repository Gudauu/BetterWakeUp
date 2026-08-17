/**
 * Resolving a wall-clock time in an IANA zone to an absolute instant.
 *
 * This is the one place the system converts "9:00 AM on 2026-03-08 in
 * America/Los_Angeles" into a UTC instant, and it exists as its own module
 * because the two days a year when that conversion is not a function are the
 * days a scheduling bug is worth the most money.
 *
 * A local time on a DST day is one of three things:
 *
 * - Unambiguous, the ordinary case, with exactly one instant behind it.
 * - Ambiguous, on a backward transition, where the wall clock reads the same
 *   time twice. Both instants are real. We take the later one, so a user whose
 *   deadline sits inside the repeated hour gets the whole of it rather than
 *   losing an hour they can see on their own clock.
 * - Nonexistent, on a forward transition, where the wall clock never reads the
 *   time at all. We move forward by the length of the gap, which is Luxon's own
 *   behavior, so a 02:30 deadline on a day with no 02:30 becomes 03:30 rather
 *   than an error the user cannot act on.
 *
 * Both choices move the deadline later, never earlier. That is deliberate: a
 * DST rule the user never agreed to must not shorten the window they are being
 * judged against.
 */

import { DateTime } from "luxon";

import { AppError } from "../errors/app-error.ts";

/** Offsets in the IANA database run from -12:00 to +14:00. */
const MINIMUM_ZONE_OFFSET_MINUTES = -12 * 60;
const MAXIMUM_ZONE_OFFSET_MINUTES = 14 * 60;

/**
 * The instant at which `time` on `date` occurs in `zone`.
 *
 * `date` is `YYYY-MM-DD` and `time` is `HH:MM`, which are the shapes the
 * contract's `localDate` and `localTime` already guarantee.
 */
export function resolveLocalTime(date: string, time: string, zone: string): Date {
  const local = `${date}T${time}`;
  const candidates = candidateInstants(local, zone);
  if (candidates.length > 0) {
    // Ambiguous: the later occurrence. Unambiguous: the only one.
    return new Date(Math.max(...candidates));
  }
  // Nonexistent. Luxon resolves a skipped local time forward across the gap.
  const shifted = DateTime.fromISO(local, { zone });
  if (!shifted.isValid) {
    throw new AppError("internal_error", `cannot resolve ${local} in ${zone}`);
  }
  return shifted.toJSDate();
}

/** The instant the calendar day `date` begins in `zone`. */
export function startOfLocalDay(date: string, zone: string): Date {
  return resolveLocalTime(date, "00:00", zone);
}

/** The calendar date `instant` falls on in `zone`, as `YYYY-MM-DD`. */
export function localDateOf(instant: Date, zone: string): string {
  const zoned = DateTime.fromJSDate(instant, { zone });
  if (!zoned.isValid) {
    throw new AppError("internal_error", `cannot read an instant in ${zone}`);
  }
  return zoned.toFormat("yyyy-MM-dd");
}

/**
 * Every instant that reads as `local` in `zone`, in milliseconds.
 *
 * Rather than asking Luxon what it thinks the answer is and trusting it, this
 * enumerates the offsets in effect anywhere near the local time, inverts each
 * one, and keeps the instants that actually read back as the local time asked
 * for. A nonexistent local time yields nothing, and an ambiguous one yields
 * two, which is the distinction the caller needs and which no single
 * conversion can report.
 */
function candidateInstants(local: string, zone: string): number[] {
  const asIfUtc = DateTime.fromISO(local, { zone: "utc" });
  if (!asIfUtc.isValid) {
    throw new AppError("internal_error", `not a local date and time: ${local}`);
  }
  const localMillis = asIfUtc.toMillis();

  const instants = new Set<number>();
  for (
    let probeMinutes = MINIMUM_ZONE_OFFSET_MINUTES;
    probeMinutes <= MAXIMUM_ZONE_OFFSET_MINUTES;
    probeMinutes += 30
  ) {
    const probe = DateTime.fromMillis(localMillis - probeMinutes * 60_000, { zone });
    if (!probe.isValid) {
      throw new AppError("internal_error", `not a time zone the runtime knows: ${zone}`);
    }
    const instant = localMillis - probe.offset * 60_000;
    if (readsAs(instant, zone, local)) {
      instants.add(instant);
    }
  }
  return [...instants];
}

function readsAs(instant: number, zone: string, local: string): boolean {
  return DateTime.fromMillis(instant, { zone }).toFormat("yyyy-MM-dd'T'HH:mm") === local;
}
