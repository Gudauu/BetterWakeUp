/**
 * The request hash is the half of idempotency that decides whether two
 * requests are "the same". If it were sensitive to key order, a client build
 * that serialized its fields differently would be told its own retry was a
 * key reuse; if it ignored ordering inside arrays, two genuinely different
 * requests would collide. Both are tested here.
 */

import { describe, expect, it } from "vitest";

import { canonicalize, hashRequest } from "../src/idempotency/request-hash.ts";

describe("canonicalize", () => {
  it("orders object keys, at every level of nesting", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("leaves array order alone, because order is meaning in an array", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it("drops undefined members the way JSON.stringify does", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("renders a value with a toJSON by what it serializes to", () => {
    const instant = new Date("2026-01-01T00:00:00.000Z");
    expect(canonicalize({ at: instant })).toBe('{"at":"2026-01-01T00:00:00.000Z"}');
  });
});

describe("hashRequest", () => {
  it("is stable across key order", () => {
    expect(hashRequest({ steps: 120, taskId: "a" })).toBe(hashRequest({ taskId: "a", steps: 120 }));
  });

  it("changes when any value changes", () => {
    expect(hashRequest({ steps: 120 })).not.toBe(hashRequest({ steps: 121 }));
  });

  it("distinguishes a missing field from a null one", () => {
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 1, b: null }));
  });

  it("produces a hex SHA-256 digest, never the request itself", () => {
    const hash = hashRequest({ token: "secret-value" });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("secret");
  });
});
