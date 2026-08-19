/**
 * What the device is still holding, as home reads it.
 *
 * The rules here decide whether someone who walked in a basement is told their
 * walk exists, so each one is pinned on its own: which record belongs to the
 * task the challenge is currently asking for, which refusal outranks which
 * retry, and what counts as work left over from an earlier day.
 */

import type { PendingCompletionRecord } from "../src/completions/store.ts";
import { heldWalksText, NO_UNSENT_WORK, unsentWork } from "../src/completions/unsent-work.ts";

const TASK = "44444444-4444-4444-8444-444444444444";
const OTHER_TASK = "55555555-5555-4555-8555-555555555555";

function record(overrides: Partial<PendingCompletionRecord> = {}): PendingCompletionRecord {
  return {
    id: "record-1",
    challengeId: "33333333-3333-4333-8333-333333333333",
    taskId: TASK,
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

describe("unsent work", () => {
  it("says nothing when the device holds nothing", () => {
    expect(unsentWork([], TASK)).toEqual(NO_UNSENT_WORK);
  });

  it("reports today's walk as waiting while its record is pending", () => {
    expect(unsentWork([record()], TASK)).toEqual({
      currentTask: "waiting",
      earlierWaiting: 0,
      currentPending: record(),
    });
  });

  it("reports a refusal for today's task, which a retry would not change", () => {
    expect(unsentWork([record({ status: "rejected" })], TASK)).toEqual({
      currentTask: "refused",
      earlierWaiting: 0,
      currentPending: null,
    });
  });

  it("lets a refusal outrank a record still pending for the same task", () => {
    const records = [record(), record({ id: "record-2", status: "rejected" })];
    expect(unsentWork(records, TASK).currentTask).toBe("refused");
  });

  it("counts a pending record from an earlier task as earlier work", () => {
    const records = [record(), record({ id: "record-2", taskId: OTHER_TASK })];
    expect(unsentWork(records, TASK)).toEqual({
      currentTask: "waiting",
      earlierWaiting: 1,
      currentPending: record(),
    });
  });

  it("counts every held record as earlier work when no task is open", () => {
    const records = [record(), record({ id: "record-2", taskId: OTHER_TASK })];
    expect(unsentWork(records, null)).toEqual({
      currentTask: "none",
      earlierWaiting: 2,
      currentPending: null,
    });
  });

  it("hands back the pending record itself, so the screen can say why it is waiting", () => {
    const mine = record({ attempts: 3, lastErrorCode: "rate_limited" });
    expect(unsentWork([mine], TASK).currentPending).toBe(mine);
  });

  it("hands back no record once a refusal outranks the one still pending", () => {
    const records = [record(), record({ id: "record-2", status: "rejected" })];
    expect(unsentWork(records, TASK).currentPending).toBeNull();
  });

  it("leaves an earlier refusal out, because nothing can be pressed about it", () => {
    const records = [record({ taskId: OTHER_TASK, status: "rejected" })];
    expect(unsentWork(records, TASK)).toEqual(NO_UNSENT_WORK);
  });
});

describe("what a device holding walks is told when the challenge cannot be read", () => {
  it("says nothing when the device is holding nothing", () => {
    expect(heldWalksText(0)).toBeNull();
  });

  it("speaks of one walk in the singular", () => {
    expect(heldWalksText(1)).toMatch(/^A walk you saved is still on this phone\./);
  });

  it("counts the walks when there is more than one", () => {
    expect(heldWalksText(3)).toMatch(/^3 walks you saved are still on this phone\./);
  });

  it("rules out walking again, which the server would refuse as a duplicate", () => {
    expect(heldWalksText(1)).toMatch(/no need to walk again/);
  });
});
