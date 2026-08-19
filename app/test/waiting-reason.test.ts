/**
 * Why a walk saved on this phone has not landed yet.
 *
 * The distinction each test pins is the one the screens act on: an attempt
 * that did not get through is the user's problem to move for, and a walk the
 * server itself deferred is not.
 */

import type { PendingCompletionRecord } from "../src/completions/store.ts";
import { RETRY_ATTEMPT_LIMIT } from "../src/completions/sync.ts";
import { attemptsText, waitingReading } from "../src/completions/waiting-reason.ts";

function record(overrides: Partial<PendingCompletionRecord> = {}): PendingCompletionRecord {
  return {
    id: "record-1",
    challengeId: "challenge-1",
    taskId: "task-1",
    completedAt: "2026-09-01T13:40:00.000Z",
    observation: {
      startedAt: "2026-09-01T13:30:00.000Z",
      endedAt: "2026-09-01T13:40:00.000Z",
      steps: 300,
      provenance: "live-foreground",
      source: "expo-pedometer-ios",
    },
    appVersion: "1.0.0-test",
    verificationPolicyVersion: "live-foreground-steps.1",
    status: "pending",
    createdAt: "2026-09-01T13:40:00.000Z",
    attempts: 1,
    lastErrorCode: null,
    lastErrorMessage: null,
    ...overrides,
  };
}

describe("why a saved walk has not landed", () => {
  it("says nothing about a record that is no longer trying", () => {
    expect(waitingReading(record({ status: "rejected" }))).toBeNull();
  });

  it("reports no reason while the first attempt is still in the air", () => {
    const reading = waitingReading(record({ attempts: 0 }));
    expect(reading?.cause).toBe("sending");
    expect(reading?.reason).toBeNull();
  });

  it("keeps the signal advice while nothing has failed yet", () => {
    expect(waitingReading(record({ attempts: 0 }))?.advice).toMatch(/where there is signal/);
  });

  it("words a failed attempt so it is true whether the phone or the server was at fault", () => {
    const reading = waitingReading(record({ lastErrorCode: "internal_error" }));
    expect(reading?.cause).toBe("unreached");
    expect(reading?.reason).toMatch(/did not get through/);
    expect(reading?.reason).toMatch(/either this phone could not reach/);
    expect(reading?.advice).toMatch(/where there is signal/);
  });

  it("stops blaming the signal when the server is the one holding the walk back", () => {
    const reading = waitingReading(record({ lastErrorCode: "rate_limited" }));
    expect(reading?.cause).toBe("throttled");
    expect(reading?.reason).toMatch(/limiting how often this phone can send/);
    expect(reading?.advice).not.toMatch(/signal/);
    expect(reading?.advice).toMatch(/nothing to fix on this phone/);
  });

  it("says the server already has a command it is still working on", () => {
    const reading = waitingReading(record({ lastErrorCode: "idempotency_in_progress" }));
    expect(reading?.cause).toBe("in-progress");
    expect(reading?.reason).toMatch(/already has this walk/);
    expect(reading?.reason).toMatch(/rather than sending it a second time/);
  });

  it("treats an unrecognised code as an attempt that did not get through", () => {
    expect(waitingReading(record({ lastErrorCode: "something_new" }))?.cause).toBe("unreached");
  });

  it("keeps promising its own retries right up to the attempt limit", () => {
    const reading = waitingReading(
      record({ attempts: RETRY_ATTEMPT_LIMIT - 1, lastErrorCode: "internal_error" }),
    );
    expect(reading?.retryingItself).toBe(true);
    expect(reading?.advice).toMatch(/keeps trying to send it by itself/);
  });

  it("stops promising them once sync has given up its own clock", () => {
    const reading = waitingReading(
      record({ attempts: RETRY_ATTEMPT_LIMIT, lastErrorCode: "internal_error" }),
    );
    expect(reading?.retryingItself).toBe(false);
    expect(reading?.advice).toMatch(/no longer retrying on its own clock/);
    expect(reading?.advice).toMatch(/open the app again/);
  });

  it("gives the same trigger advice however the server deferred it", () => {
    const reading = waitingReading(
      record({ attempts: RETRY_ATTEMPT_LIMIT + 2, lastErrorCode: "rate_limited" }),
    );
    expect(reading?.advice).toMatch(/no longer retrying on its own clock/);
  });
});

describe("how many times it has been tried", () => {
  it("stays quiet about a single failed attempt, which is ordinary", () => {
    expect(attemptsText(record({ attempts: 1 }))).toBeNull();
  });

  it("stays quiet before anything has been tried", () => {
    expect(attemptsText(record({ attempts: 0 }))).toBeNull();
  });

  it("counts the attempts once they are a pattern", () => {
    expect(attemptsText(record({ attempts: 4 }))).toBe("Tried 4 times so far.");
  });

  it("says nothing about a record that has stopped being tried", () => {
    expect(attemptsText(record({ status: "rejected", attempts: 4 }))).toBeNull();
  });
});
