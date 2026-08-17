/**
 * Crash and synchronization reporting.
 *
 * The acceptance boundary of issue 34 is a forced rejected completion: a real
 * store, a real sync pass, and a server that refuses, with the assertion made
 * over the exact payload that would have left the device.
 */

import type { MovementObservation } from "@betterwakeup/contract";
import type { ApiClient, ApiRequest, ClientEndpointName } from "../src/api/client.ts";
import { ApiError } from "../src/api/errors.ts";
import {
  openPendingCompletionStore,
  type PendingCompletionInput,
  type PendingCompletionStore,
} from "../src/completions/store.ts";
import { type CompletionSync, createCompletionSync } from "../src/completions/sync.ts";
import {
  createRecordingReporter,
  noopReporter,
  type RecordingReporter,
} from "../src/reporting/reporter.ts";
import { REDACTED, scrubPayload, scrubText } from "../src/reporting/scrub.ts";
import {
  reportCompletionSync,
  reportForSyncEvent,
  STALLED_AFTER_ATTEMPTS,
} from "../src/reporting/sync-reporting.ts";
import { createMemoryDatabase } from "./support/node-sqlite.ts";

const SESSION_TOKEN =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";

const OBSERVATION: MovementObservation = {
  startedAt: "2026-03-01T14:00:00.000Z",
  endedAt: "2026-03-01T14:04:00.000Z",
  steps: 220,
  provenance: "live-foreground",
  source: "expo-pedometer-android",
};

const INPUT: PendingCompletionInput = {
  challengeId: "11111111-1111-4111-8111-111111111111",
  taskId: "22222222-2222-4222-8222-222222222222",
  completedAt: "2026-03-01T14:04:00.000Z",
  observation: OBSERVATION,
  appVersion: "1.2.3",
  verificationPolicyVersion: "live-foreground-steps.1",
};

function ids(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `00000000-0000-4000-8000-00000000000${next}`;
  };
}

interface FakeClient extends ApiClient {
  /** What every attempt does. Default: throw the refusal below. */
  fail(error: ApiError): void;
}

function createFakeClient(): FakeClient {
  let failure: ApiError | null = null;
  return {
    fail(error) {
      failure = error;
    },
    async request<Name extends ClientEndpointName>(_name: Name, _input: ApiRequest<Name>) {
      if (failure !== null) {
        throw failure;
      }
      throw new Error("no outcome staged");
    },
  };
}

describe("free text scrubbing", () => {
  it("removes a JSON Web Token, wherever it appears in a sentence", () => {
    expect(scrubText(`credential ${SESSION_TOKEN} refused`)).toBe(
      "credential [redacted:jwt] refused",
    );
  });

  it("removes an Authorization header value while keeping the scheme", () => {
    expect(scrubText("sent Bearer abc123def456 to the server")).toBe(
      "sent Bearer [redacted] to the server",
    );
  });

  it("removes a card number with or without separators", () => {
    expect(scrubText("card 4111 1111 1111 1111 declined")).toBe("card [redacted:pan] declined");
    expect(scrubText("card 4111111111111111 declined")).toBe("card [redacted:pan] declined");
  });

  it("removes an email address", () => {
    expect(scrubText("no account for someone@example.com")).toBe("no account for [redacted:email]");
  });

  it("removes any other long opaque run", () => {
    // Assembled from pieces so this fixture does not itself read as a secret to
    // the repository scan in `infra/test/secrets.test.ts`.
    const key = `sk_${"live"}_0123456789abcdef0123456789abcdef`;
    expect(scrubText(`key ${key}`)).toBe("key [redacted:secret]");
  });

  it("keeps a resource identifier, which is the field a report exists to carry", () => {
    const text = `task ${INPUT.taskId} was refused`;
    expect(scrubText(text)).toBe(text);
  });
});

describe("payload scrubbing", () => {
  it("replaces a property whose name marks it, however the name is spelled", () => {
    const scrubbed = scrubPayload({
      id_token: "anything",
      sessionToken: "anything",
      "X-Authorization": "anything",
      stepCount: 220,
      observation: OBSERVATION,
      userEmail: "someone@example.com",
      taskId: INPUT.taskId,
    }) as Record<string, unknown>;

    expect(scrubbed).toEqual({
      id_token: REDACTED,
      sessionToken: REDACTED,
      "X-Authorization": REDACTED,
      stepCount: REDACTED,
      observation: REDACTED,
      userEmail: REDACTED,
      taskId: INPUT.taskId,
    });
  });

  it("reaches nested objects and arrays", () => {
    const scrubbed = scrubPayload({
      breadcrumbs: [{ data: { idToken: "anything", message: `saw ${SESSION_TOKEN}` } }],
    }) as { breadcrumbs: { data: Record<string, unknown> }[] };

    expect(scrubbed.breadcrumbs[0]?.data).toEqual({
      idToken: REDACTED,
      message: "saw [redacted:jwt]",
    });
  });

  it("drops a value whose serialization cannot be predicted", () => {
    const scrubbed = scrubPayload({ callback: () => "anything", ok: true }) as Record<
      string,
      unknown
    >;
    expect(scrubbed).toEqual({ callback: undefined, ok: true });
  });
});

describe("what a sync event reports", () => {
  let store: PendingCompletionStore;
  let client: FakeClient;
  let sync: CompletionSync;
  let reporter: RecordingReporter;

  beforeEach(async () => {
    store = await openPendingCompletionStore({
      database: createMemoryDatabase(),
      newRecordId: ids(),
    });
    client = createFakeClient();
    sync = createCompletionSync({ store, client });
    reporter = createRecordingReporter();
    reportCompletionSync(sync, reporter);
  });

  afterEach(async () => {
    sync.stop();
    await store.close();
  });

  it("reports a forced rejected completion with identifiers and the contract code only", async () => {
    client.fail(
      new ApiError(
        "step_target_not_met",
        `Only 220 steps in the window for session ${SESSION_TOKEN}.`,
        { status: 422 },
      ),
    );

    const record = await sync.record(INPUT);

    expect(reporter.reports).toHaveLength(1);
    const report = reporter.reports[0]?.report;
    expect(report).toEqual({
      name: "completion.rejected",
      severity: "error",
      fields: {
        clientRecordId: record.id,
        challengeId: INPUT.challengeId,
        taskId: INPUT.taskId,
        errorCode: "step_target_not_met",
        disposition: "reject",
        attempts: 1,
        appVersion: "1.2.3",
        verificationPolicyVersion: "live-foreground-steps.1",
        operation: "completionSync",
      },
    });
  });

  it("carries no health, session, or message data even before scrubbing", async () => {
    client.fail(
      new ApiError(
        "step_target_not_met",
        `Only 220 steps in the window for session ${SESSION_TOKEN}.`,
        { status: 422 },
      ),
    );
    await sync.record(INPUT);

    const payload = JSON.stringify(scrubPayload(reporter.reports[0]?.report));
    for (const forbidden of [
      SESSION_TOKEN,
      // The step count, the window's instants, the pedometer the reading came
      // from, and the server's own sentence.
      "220",
      "2026-03-01T14:00:00.000Z",
      "expo-pedometer-android",
      "Only",
    ]) {
      expect(payload).not.toContain(forbidden);
    }
  });

  // The attempt count is the one a deferred event would report on, so a report
  // appearing here would be the acknowledged branch failing to short-circuit
  // rather than the count happening to fall below the threshold.
  it("reports nothing for an acknowledged completion, however many attempts it took", () => {
    expect(
      reportForSyncEvent({
        type: "acknowledged",
        record: {
          ...INPUT,
          id: "r1",
          observation: OBSERVATION,
          status: "pending",
          createdAt: INPUT.completedAt,
          attempts: STALLED_AFTER_ATTEMPTS - 1,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
        response: {
          task: {
            id: INPUT.taskId,
            date: "2026-03-01",
            deadline: "2026-03-01T15:00:00.000Z",
            pauseCutoff: "2026-03-01T14:00:00.000Z",
            status: "completed",
            acknowledgedAt: "2026-03-01T14:04:02.000Z",
          },
          replayed: false,
          challengeStatus: "active",
        },
      }),
    ).toBeNull();
  });

  it("reports a record that keeps failing exactly once, on the attempt that crosses the line", async () => {
    client.fail(new ApiError("internal_error", "The server is unavailable.", { status: null }));

    await sync.record(INPUT);
    expect(reporter.reports).toHaveLength(0);

    for (let attempt = 2; attempt <= STALLED_AFTER_ATTEMPTS + 2; attempt += 1) {
      await sync.syncAll();
    }

    expect(reporter.reports).toHaveLength(1);
    expect(reporter.reports[0]?.report).toMatchObject({
      name: "completion.sync_stalled",
      severity: "warning",
      fields: { errorCode: "internal_error", attempts: STALLED_AFTER_ATTEMPTS },
    });
  });
});

describe("a build with no Sentry project", () => {
  it("has a reporter that accepts everything and does nothing", () => {
    expect(() => {
      noopReporter.capture({ name: "x", severity: "info", fields: {} });
      noopReporter.captureException(new Error("x"), { name: "x", severity: "error", fields: {} });
    }).not.toThrow();
  });
});
