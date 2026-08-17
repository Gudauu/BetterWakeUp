/**
 * Scrubbing for free text that reaches a log line.
 *
 * The logger's field set is closed, so no caller can add a field holding a
 * token or a movement sample. Free text is the remaining hole: an exception
 * message, a driver error, a provider's rejection reason. Those are written by
 * code we do not control and routinely quote the value that caused them.
 *
 * These patterns are a net under the closed field set, not a substitute for
 * it. They cost one pass over a short string and turn an accidental leak into
 * a marker an operator can see.
 */

/**
 * A version 1 to 8 UUID.
 *
 * Resource identifiers are the thing the architecture asks us to log, so they
 * are cut out of the text before any rule runs. Otherwise an all-digit
 * identifier would be destroyed by the card-number rule and an operator would
 * lose the one field that makes a log line traceable.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

interface Rule {
  readonly pattern: RegExp;
  readonly replace: string;
}

const RULES: readonly Rule[] = [
  // A JSON Web Token: provider ID tokens and session tokens both look like
  // this. A JWT header is a JSON object, so its base64url always starts `eyJ`,
  // which is what keeps this from matching a dotted filename.
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
  // A primary account number, with or without the usual separators. The last
  // character is a digit, so a trailing separator stays outside the match.
  { pattern: /\b(?:\d[ -]?){12,18}\d\b/g, replace: "[redacted:pan]" },
  // Any other long opaque run: provider secrets and API keys land here.
  { pattern: /\b[A-Za-z0-9_-]{32,}\b/g, replace: "[redacted:secret]" },
];

/** Replace anything in `text` that looks like a credential. */
export function scrub(text: string): string {
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
