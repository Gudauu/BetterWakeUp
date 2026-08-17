/**
 * The request hash stored beside an idempotency key.
 *
 * The architecture rejects a key replayed with a different request, which means
 * the server has to be able to say whether two requests are the same. JSON text
 * cannot answer that on its own: the same request re-serialized by a different
 * client build can order its keys differently and still mean exactly the same
 * thing. So the value is canonicalized first and hashed second.
 *
 * Canonical form: object keys sorted, arrays left in order (order is meaning in
 * an array), `undefined` members dropped the way `JSON.stringify` drops them,
 * and every other value rendered by `JSON.stringify`. The hash is SHA-256 in
 * hex, which is stored rather than the request itself so a key's row never
 * carries the body's contents.
 */

import { createHash } from "node:crypto";

/** The canonical JSON text of a value, with every object's keys in sort order. */
export function canonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";

  if (Array.isArray(value)) {
    return `[${value.map((member) => canonicalize(member)).join(",")}]`;
  }

  // A Date, or anything else with a toJSON, means whatever it serializes to.
  const candidate = value as { toJSON?: () => unknown };
  if (typeof candidate.toJSON === "function") return canonicalize(candidate.toJSON());

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const rendered = entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalize(member)}`);
  return `{${rendered.join(",")}}`;
}

/** The hash stored on an idempotency key row. */
export function hashRequest(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}
