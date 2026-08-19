/**
 * The four-state progression.
 *
 * The acceptance boundary of issue 32 lives here: no arrangement of local
 * records produces `acknowledged`, because only the server's own task view can
 * say the second check passed.
 */

import type { TaskView } from "@betterwakeup/contract";
import { DEADLINE_WARNING_MINUTES, dailyCompletionState } from "../src/completions/daily-state.ts";
import type { PendingCompletionRecord } from "../src/completions/store.ts";

const TASK_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-09-01T13:00:00.000Z");

function task(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: TASK_ID,
    date: "2026-09-01",
    deadline: "2026-09-01T14:00:00.000Z",
    pauseCutoff: "2026-09-01T06:00:00.000Z",
    status: "scheduled",
    acknowledgedAt: null,
    ...overrides,
  };
}

function record(overrides: Partial<PendingCompletionRecord> = {}): PendingCompletionRecord {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    challengeId: "33333333-3333-4333-8333-333333333333",
    taskId: TASK_ID,
    completedAt: "2026-09-01T12:50:00.000Z",
    observation: {
      startedAt: "2026-09-01T12:40:00.000Z",
      endedAt: "2026-09-01T12:50:00.000Z",
      steps: 300,
      provenance: "live-foreground",
      source: "expo-pedometer-ios",
    },
    appVersion: "1.0.0",
    verificationPolicyVersion: "live-foreground-steps.1",
    status: "pending",
    createdAt: "2026-09-01T12:50:00.000Z",
    attempts: 1,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastErrorReachedServer: null,
    ...overrides,
  };
}

describe("the progression", () => {
  it("starts incomplete with both checks waiting", () => {
    const state = dailyCompletionState({ task: task(), records: [], now: NOW });

    expect(state.status).toBe("incomplete");
    expect(state.localCheck).toBe("waiting");
    expect(state.serverCheck).toBe("waiting");
  });

  it("never reports acknowledged from a local record alone", () => {
    const state = dailyCompletionState({ task: task(), records: [record()], now: NOW });

    expect(state.status).toBe("syncPending");
    expect(state.localCheck).toBe("passed");
    expect(state.serverCheck).toBe("waiting");
  });

  it("reports acknowledged only from the server's own task view", () => {
    const state = dailyCompletionState({
      task: task({ status: "completed", acknowledgedAt: "2026-09-01T12:51:00.000Z" }),
      records: [],
      now: NOW,
    });

    expect(state.status).toBe("acknowledged");
    expect(state.serverCheck).toBe("passed");
  });

  it("does not report acknowledged for a completed task with no acknowledgment instant", () => {
    const state = dailyCompletionState({
      task: task({ status: "completed", acknowledgedAt: null }),
      records: [record()],
      now: NOW,
    });

    expect(state.status).toBe("syncPending");
  });

  it("reports rejected with the refused record", () => {
    const rejected = record({
      status: "rejected",
      lastErrorCode: "task_already_resolved",
      lastErrorMessage: "This task is already resolved.",
    });

    const state = dailyCompletionState({ task: task(), records: [rejected], now: NOW });

    expect(state.status).toBe("rejected");
    expect(state.localCheck).toBe("passed");
    expect(state.serverCheck).toBe("failed");
    expect(state.rejectedRecord?.lastErrorCode).toBe("task_already_resolved");
  });

  it("prefers a refusal over a record still waiting", () => {
    const state = dailyCompletionState({
      task: task(),
      records: [record(), record({ id: "other", status: "rejected" })],
      now: NOW,
    });

    expect(state.status).toBe("rejected");
  });

  it("ignores records belonging to another task", () => {
    const state = dailyCompletionState({
      task: task(),
      records: [record({ taskId: "66666666-6666-4666-8666-666666666666" })],
      now: NOW,
    });

    expect(state.status).toBe("incomplete");
  });

  it("has nothing to say when no task is open", () => {
    const state = dailyCompletionState({ task: null, records: [record()], now: NOW });

    expect(state.status).toBe("incomplete");
    expect(state.minutesToDeadline).toBeNull();
    expect(state.deadlineWarning).toBe(false);
  });
});

describe("the deadline warning", () => {
  it("stays quiet while the deadline is far off", () => {
    const state = dailyCompletionState({ task: task(), records: [record()], now: NOW });

    expect(state.minutesToDeadline).toBe(60);
    expect(state.deadlineWarning).toBe(false);
  });

  it("fires at the threshold, to the minute", () => {
    const deadline = new Date(NOW.getTime() + DEADLINE_WARNING_MINUTES * 60_000);
    const atThreshold = dailyCompletionState({
      task: task({ deadline: deadline.toISOString() }),
      records: [record()],
      now: NOW,
    });
    const justOutside = dailyCompletionState({
      task: task({ deadline: new Date(deadline.getTime() + 60_000).toISOString() }),
      records: [record()],
      now: NOW,
    });

    expect(atThreshold.deadlineWarning).toBe(true);
    expect(justOutside.deadlineWarning).toBe(false);
  });

  it("keeps warning once the deadline has passed with nothing acknowledged", () => {
    const state = dailyCompletionState({
      task: task({ deadline: "2026-09-01T12:00:00.000Z" }),
      records: [record()],
      now: NOW,
    });

    expect(state.deadlinePassed).toBe(true);
    expect(state.deadlineWarning).toBe(true);
  });

  it("says nothing once the server has acknowledged", () => {
    const state = dailyCompletionState({
      task: task({
        deadline: "2026-09-01T13:01:00.000Z",
        status: "completed",
        acknowledgedAt: "2026-09-01T12:51:00.000Z",
      }),
      records: [],
      now: NOW,
    });

    expect(state.deadlineWarning).toBe(false);
  });

  it("does not warn about a task nothing has been recorded for", () => {
    const state = dailyCompletionState({
      task: task({ deadline: "2026-09-01T13:01:00.000Z" }),
      records: [],
      now: NOW,
    });

    expect(state.status).toBe("incomplete");
    expect(state.deadlineWarning).toBe(false);
  });
});
