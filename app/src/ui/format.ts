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

/**
 * A duration a person would say out loud. Minutes alone past an hour - "127
 * minutes" - is a number to be converted rather than read, and the last minute
 * is named as what it is rather than as "0 minutes", which reads as expired.
 *
 * It lives here beside the clock times because two different countdowns now
 * use it - the morning's deadline and the recovery offer's window - and the two
 * must not drift into saying the same length of time differently.
 */
export function formatDuration(minutes: number): string {
  if (minutes <= 0) {
    return "Less than a minute";
  }
  if (minutes < 60) {
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hoursText = hours === 1 ? "1 hour" : `${hours} hours`;
  if (rest === 0) {
    return hoursText;
  }
  return `${hoursText} ${rest === 1 ? "1 minute" : `${rest} minutes`}`;
}

function format(instant: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat("en-US", options).format(new Date(instant));
  } catch {
    return instant;
  }
}
