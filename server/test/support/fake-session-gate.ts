/**
 * A session gate for the tests that are about something else.
 *
 * The validation and application suites mount real session endpoints, and
 * since issue 14 those cannot be mounted unguarded. This stands in for the
 * real gate so those tests keep testing what they are named after; the real
 * gate's own behaviour is covered by `session-gate.test.ts` and the ownership
 * integration suite.
 */

import type { AuthenticatedSession, SessionGate } from "../../src/auth/session-gate.ts";
import { AppError } from "../../src/errors/app-error.ts";

export const TEST_ACCOUNT_ID = "b0b7a0f4-1b0e-4d3f-9f0a-7c2a1e5d8f31";

export interface FakeGateOptions {
  readonly accountId?: string;
  /** Identifiers this caller owns. Undefined means every identifier is theirs. */
  readonly owns?: readonly string[];
}

export function fakeSessionGate(options: FakeGateOptions = {}): SessionGate {
  const session: AuthenticatedSession = {
    sessionId: "3a5b2d1c-9e4f-4a7b-8c6d-2f1e0a9b8c7d",
    accountId: options.accountId ?? TEST_ACCOUNT_ID,
  };
  const owns = options.owns;

  return {
    authenticate: async () => session,
    assertOwnership: async (_session, params) => {
      if (owns === undefined || params === null || typeof params !== "object") return;
      for (const value of Object.values(params as Record<string, unknown>)) {
        if (typeof value === "string" && !owns.includes(value)) {
          throw new AppError("not_found", "No resource with this identifier.");
        }
      }
    },
  };
}
