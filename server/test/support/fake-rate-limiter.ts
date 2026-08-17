/**
 * A rate limiter for the tests that are about something else.
 *
 * Since issue 15 an endpoint declaring a limit cannot be mounted without one,
 * so the suites that mount sign-in, completion, pause, or payment routes
 * incidentally need a limiter to stand in. The real limiter's behaviour is
 * covered by its own unit and integration suites.
 */

import type { RateLimitPolicy } from "../../src/rate-limit/policy.ts";
import type { RateLimiter } from "../../src/rate-limit/service.ts";

export interface RecordedConsumption {
  readonly policy: RateLimitPolicy;
  readonly subject: string;
}

export interface FakeRateLimiter extends RateLimiter {
  /** Every call, in order, for the tests that assert who was counted when. */
  readonly consumed: RecordedConsumption[];
}

export function fakeRateLimiter(): FakeRateLimiter {
  const consumed: RecordedConsumption[] = [];
  return {
    consumed,
    consume: async (policy, subject) => {
      consumed.push({ policy, subject });
    },
  };
}
