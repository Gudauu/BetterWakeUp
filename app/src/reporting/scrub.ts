/**
 * The second net under the closed report field set.
 *
 * A report the app writes carries only the fields `ReportFields` names. A
 * payload Sentry builds carries much more than that: the exception's message,
 * breadcrumbs the SDK collected on its own, request data, and whatever a
 * dependency attached. None of that is written by us, and any of it can quote
 * the value that caused a failure.
 *
 * So every payload is walked before it is sent: a property whose name marks it
 * as credential material, health data, or a person's contact details is
 * replaced rather than sent, and every remaining string is scrubbed for things
 * that look like a token, a card number, or a long opaque secret.
 *
 * This runs as Sentry's `beforeSend`, which is the last point a payload passes
 * through inside the process.
 */

/** What a removed value is replaced with, so its absence is visible. */
export const REDACTED = "[redacted]";

/**
 * A version 1 to 8 UUID. Resource identifiers are exactly what a report is for,
 * so they are cut out of the text before any rule runs; otherwise the card
 * number rule would destroy an identifier's digit runs.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

interface Rule {
  readonly pattern: RegExp;
  readonly replace: string;
}

const RULES: readonly Rule[] = [
  // A JSON Web Token: a provider ID token and our own session token both look
  // like this. A JWT header encodes a JSON object, so its base64url always
  // begins `eyJ`, which keeps this from matching a dotted filename.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\b/g,
    replace: "[redacted:jwt]",
  },
  // Any other three-part dotted token, which needs longer segments to be
  // distinguishable from prose.
  {
    pattern: /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: "[redacted:jwt]",
  },
  // An Authorization header quoted into a message.
  { pattern: /\b(Bearer|Basic)\s+\S+/gi, replace: "$1 [redacted]" },
  // An email address, which a provider's rejection message may quote back.
  { pattern: /\b[^\s@]+@[^\s@.]+\.[^\s@]+\b/g, replace: "[redacted:email]" },
  // A primary account number, with or without the usual separators. The last
  // character is a digit, so a trailing separator stays outside the match.
  { pattern: /\b(?:\d[ -]?){12,18}\d\b/g, replace: "[redacted:pan]" },
  // Any other long opaque run: provider secrets and API keys land here.
  { pattern: /\b[A-Za-z0-9_-]{32,}\b/g, replace: "[redacted:secret]" },
];

/**
 * Property names whose value never leaves the device.
 *
 * Matching is on a normalized name (lowercased, with separators removed) and
 * by substring, so `id_token`, `idToken`, and `providerIdToken` are all the
 * same name. Substring matching is deliberately generous: a false positive
 * costs an operator one field, a false negative ships a credential.
 */
const FORBIDDEN_NAME_MARKERS: readonly string[] = [
  "token",
  "credential",
  "password",
  "secret",
  "authorization",
  "cookie",
  "apikey",
  "email",
  "health",
  "observation",
  "step",
  "sample",
  "card",
  "cvc",
  "cvv",
  "pan",
];

/** Guard against a payload that is deeper than anything real. */
const MAX_DEPTH = 12;

function isForbiddenName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return FORBIDDEN_NAME_MARKERS.some((marker) => normalized.includes(marker));
}

/** Replace anything in `text` that looks like a credential or an address. */
export function scrubText(text: string): string {
  let result = "";
  let cursor = 0;
  UUID.lastIndex = 0;
  for (const match of text.matchAll(UUID)) {
    result += scrubSegment(text.slice(cursor, match.index)) + match[0];
    cursor = match.index + match[0].length;
  }
  return result + scrubSegment(text.slice(cursor));
}

function scrubSegment(segment: string): string {
  let result = segment;
  for (const rule of RULES) {
    result = result.replace(rule.pattern, rule.replace);
  }
  return result;
}

/**
 * Walk a payload, removing forbidden properties and scrubbing every string.
 *
 * A value that is neither an object, an array, nor a primitive we can reason
 * about (a function, a symbol) is dropped, because there is no way to inspect
 * what it would serialize to.
 */
export function scrubPayload(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return REDACTED;
  }
  if (typeof value === "string") {
    return scrubText(value);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubPayload(item, depth + 1));
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = isForbiddenName(key) ? REDACTED : scrubPayload(item, depth + 1);
    }
    return result;
  }
  // undefined, a function, a symbol, a bigint: nothing worth reporting, and
  // nothing whose serialization we can predict.
  return undefined;
}
