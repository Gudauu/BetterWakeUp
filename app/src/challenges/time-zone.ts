/**
 * The challenge that travelled with its user, and the one that did not.
 *
 * A challenge's deadlines are a wall-clock promise - "250 steps by 7:00 AM" -
 * and that promise only names an instant once a time zone is chosen. The zone
 * is chosen once, when the challenge is created, from the device the user
 * happened to be holding. Fly three zones east and the server still judges the
 * day in the zone left behind: the 7:00 AM alarm now falls at 10:00 AM local,
 * and a user who walks at 7:00 where they are has already missed it.
 *
 * The server has always been able to move a running challenge -
 * `POST /challenges/:challengeId/time-zone` re-materializes every task whose
 * pause cutoff is still ahead - so what is here is the app's half: noticing
 * that the device and the challenge disagree, and asking for the move.
 *
 * Nothing here decides which tasks move. That is the server's rule, and the
 * command reports what it did rather than predicting it.
 */

import type {
  ChallengeStatus,
  ChallengeView,
  ChangeTimeZoneResponse,
} from "@betterwakeup/contract";
import type { ApiClient } from "../api/client.ts";
import { ApiError } from "../api/errors.ts";
import type { CommandOutcome } from "./lifecycle-commands.ts";

/** A disagreement between the device's zone and the challenge's, worth offering. */
export interface TimeZoneMove {
  /** The zone the challenge's deadlines are currently read in. */
  readonly from: string;
  /** The zone the device is in now. */
  readonly to: string;
}

/**
 * The statuses whose zone the server will move. A paused challenge is included
 * - the user who travels is exactly the user who is likely to be paused - and
 * `recovery_pending` is not, because that challenge is waiting on one decision
 * measured from a missed task and the server refuses to move instants under it.
 */
const MOVABLE_STATUSES: readonly ChallengeStatus[] = ["active"];

/**
 * The move to offer, or null when there is nothing to offer.
 *
 * A challenge with no deposit and one with a deposit are treated alike: what is
 * wrong is the time the user is being woken at, which is the same wrong either
 * way.
 */
export function timeZoneMoveFor(
  challenge: ChallengeView,
  deviceTimeZone: string,
): TimeZoneMove | null {
  const from = challenge.configuration.timeZone;
  if (deviceTimeZone.length === 0 || deviceTimeZone === from) {
    return null;
  }
  if (!MOVABLE_STATUSES.includes(challenge.status)) {
    return null;
  }
  return { from, to: deviceTimeZone };
}

/**
 * A zone as a place rather than as an identifier: `America/New_York` is read
 * out as "New York", which is what the user would call it. An identifier the
 * shape does not fit is left alone rather than mangled.
 */
export function timeZoneLabel(zone: string): string {
  const last = zone.split("/").at(-1);
  if (last === undefined || last.length === 0) {
    return zone;
  }
  return last.replace(/_/g, " ");
}

/**
 * Whether moving to `to` pulls the wall clock earlier in real time - the user
 * travelled east. It matters because a deadline that moves earlier can land in
 * the past, and the server applies the rule as written rather than refusing, so
 * the user has to be told before they press.
 *
 * Null when the runtime cannot answer, which is the same runtime-without-zone-
 * data case the formatters fall back for; the screen then says nothing rather
 * than guessing a direction.
 */
export function movesDeadlinesEarlier(move: TimeZoneMove, at: Date): boolean | null {
  const from = zoneOffsetMinutes(move.from, at);
  const to = zoneOffsetMinutes(move.to, at);
  if (from === null || to === null) {
    return null;
  }
  return to > from;
}

/**
 * A zone's offset from UTC at an instant, in minutes east of UTC.
 *
 * Read by formatting the instant in the zone and rebuilding it as if those
 * wall-clock fields were UTC: the difference is the offset. There is no Intl
 * call that answers this directly, and the alternative - parsing a
 * `timeZoneName` string - varies by runtime.
 */
function zoneOffsetMinutes(zone: string, at: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(at);
    const field = (type: Intl.DateTimeFormatPartTypes): number => {
      const value = parts.find((part) => part.type === type)?.value;
      return value === undefined ? Number.NaN : Number(value);
    };
    const asUtc = Date.UTC(
      field("year"),
      field("month") - 1,
      field("day"),
      // Some runtimes render midnight as hour 24 under hour12: false.
      field("hour") % 24,
      field("minute"),
      field("second"),
    );
    if (Number.isNaN(asUtc)) {
      return null;
    }
    return Math.round((asUtc - at.getTime()) / 60_000);
  } catch {
    return null;
  }
}

const NETWORK_MESSAGE = "No connection to BetterWakeUp. Check your network and try again.";
const GENERIC_MESSAGE = "Your time zone could not be changed. Try again in a moment.";

const MESSAGES: Partial<Record<string, string>> = {
  challenge_not_active:
    "This challenge is no longer running, so its deadlines cannot be moved. A new challenge starts in the zone you are in.",
  validation_failed: "This device reports a time zone the server does not recognise.",
  session_expired: "Your session expired. Sign in again to change your time zone.",
  unauthenticated: "Sign in again to change your time zone.",
  rate_limited: "Too many attempts. Wait a moment and try again.",
};

export interface ChangeTimeZoneInput {
  readonly api: ApiClient;
  readonly challenge: ChallengeView;
  readonly timeZone: string;
}

/**
 * Move the challenge's deadlines into a zone.
 *
 * Not confirmation-gated: the move gives nothing up and can be made again in
 * the other direction, and a confirmation that guards a reversible action
 * teaches the user to dismiss the ones that matter. The one refusal is a move
 * to the zone the challenge is already in, which the server would answer as a
 * change that changed nothing.
 */
export async function changeTimeZone(
  input: ChangeTimeZoneInput,
): Promise<CommandOutcome<ChangeTimeZoneResponse>> {
  if (input.timeZone === input.challenge.configuration.timeZone) {
    return {
      status: "blocked",
      reasons: ["Your deadlines are already read in this time zone."],
    };
  }
  try {
    const value = await input.api.request("changeChallengeTimeZone", {
      params: { challengeId: input.challenge.id },
      body: { timeZone: input.timeZone },
    });
    return { status: "done", value };
  } catch (cause) {
    return { status: "failed", message: messageFor(cause) };
  }
}

function messageFor(cause: unknown): string {
  if (!(cause instanceof ApiError)) {
    return GENERIC_MESSAGE;
  }
  if (cause.status === null) {
    return NETWORK_MESSAGE;
  }
  return MESSAGES[cause.code] ?? GENERIC_MESSAGE;
}
