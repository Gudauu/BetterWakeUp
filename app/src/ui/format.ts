/**
 * How instants and dates are read out loud.
 *
 * The server speaks ISO: tasks carry a plain `2026-09-01` and deadlines carry a
 * full `2026-09-01T14:00:00.000Z`. Neither is a thing to show a person who has
 * just woken up, and a deadline is only true in the challenge's own time zone,
 * so every screen that prints one comes through here rather than reaching for
 * `toISOString`.
 *
 * A runtime whose Intl has no time zone data - a stripped Hermes build is the
 * one that bites - would otherwise throw or, worse, silently print a time in
 * the device's zone. Each function falls back to the raw ISO text instead: ugly
 * is recoverable, a wrong wake-up time is not.
 */

/** A deadline in full: the day it falls on and the time it expires, zoned. */
export function formatDeadline(instant: string, timeZone: string): string {
  return format(instant, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Just the clock time of an instant, for when the day is already on screen. */
export function formatTimeOfDay(instant: string, timeZone: string): string {
  return format(instant, { timeZone, hour: "numeric", minute: "2-digit" });
}

/**
 * A task's plain calendar date. It carries no time, so it is read in UTC on
 * purpose: parsed as midnight UTC and then shifted into a western zone it would
 * name the previous day, which is the one date the user would notice as wrong.
 */
export function formatDay(date: string): string {
  return format(`${date}T00:00:00.000Z`, {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function format(instant: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat("en-US", options).format(new Date(instant));
  } catch {
    return instant;
  }
}
