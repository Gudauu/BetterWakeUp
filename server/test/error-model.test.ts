import { ERROR_DISPOSITIONS, type ErrorCode, errorResponse } from "@betterwakeup/contract";
import { describe, expect, it } from "vitest";
import { AppError, ERROR_PROPERTIES, toAppError } from "../src/errors/app-error.ts";

const CODES = Object.keys(ERROR_DISPOSITIONS) as ErrorCode[];

describe("the error model", () => {
  it("decides a status and a classification for every contract code", () => {
    expect(Object.keys(ERROR_PROPERTIES).sort()).toEqual([...CODES].sort());
    for (const code of CODES) {
      const properties = ERROR_PROPERTIES[code];
      expect(properties.status).toBeGreaterThanOrEqual(400);
      expect(properties.status).toBeLessThan(600);
    }
  });

  it("classifies exactly one code as internal, which is what alarms on", () => {
    const internal = CODES.filter((code) => ERROR_PROPERTIES[code].classification === "internal");
    expect(internal).toEqual(["internal_error"]);
  });

  it("gives every code a body the contract accepts", () => {
    for (const code of CODES) {
      const parsed = errorResponse.safeParse(new AppError(code, "why").toResponse());
      expect(parsed.success, `${code} produced a body outside the contract`).toBe(true);
    }
  });

  it("tells the client nothing about an internal error beyond the code", () => {
    const error = new AppError("internal_error", "connection string postgres://user:hunter2@host");

    expect(error.toResponse()).toEqual({
      code: "internal_error",
      message: "An unexpected error occurred.",
    });
    // The detail is still on the error, so the log keeps what the client is denied.
    expect(error.message).toContain("hunter2");
  });

  it("exposes the contract's retry disposition rather than restating it", () => {
    expect(new AppError("rate_limited", "slow down").disposition).toBe("retry");
    expect(new AppError("deadline_passed", "too late").disposition).toBe("reject");
  });

  it("passes an AppError through and wraps anything else as internal", () => {
    const original = new AppError("forbidden", "not yours");
    expect(toAppError(original)).toBe(original);

    const cause = new TypeError("undefined is not a function");
    const wrapped = toAppError(cause);
    expect(wrapped.code).toBe("internal_error");
    expect(wrapped.status).toBe(500);
    expect(wrapped.cause).toBe(cause);
    expect(wrapped.message).toBe("undefined is not a function");

    expect(toAppError("a string").message).toBe("a string");
  });
});
