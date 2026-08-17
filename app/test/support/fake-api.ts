/**
 * An API client that answers from a table instead of a network, and records
 * what it was asked.
 *
 * The recording is the point in most of these tests: "the deposit action is
 * unreachable until disclosures are acknowledged" is a claim about requests
 * that were never made, which only a client that counts them can establish.
 */

import {
  type ChallengeView,
  type CreateFundingIntentResponse,
  type CreateProjectionResponse,
  DISCLOSURE_POLICY_VERSION,
  type TaskView,
} from "@betterwakeup/contract";
import type { ApiClient, ApiRequest, ClientEndpointName } from "../../src/api/client.ts";

export interface RecordedCall {
  readonly name: ClientEndpointName;
  readonly input: unknown;
}

type Responder = (input: unknown) => unknown;

export interface FakeApi extends ApiClient {
  readonly calls: readonly RecordedCall[];
  /** Names only, which is what an assertion about "no payment step" reads. */
  names(): readonly ClientEndpointName[];
}

export function fakeApi(
  responses: Partial<Record<ClientEndpointName, unknown | Responder>> = {},
): FakeApi {
  const calls: RecordedCall[] = [];
  return {
    calls,
    names: () => calls.map((call) => call.name),
    async request<Name extends ClientEndpointName>(name: Name, input: ApiRequest<Name>) {
      calls.push({ name, input });
      const configured = responses[name] ?? DEFAULTS[name];
      if (configured === undefined) {
        throw new Error(`fakeApi has no response for ${name}`);
      }
      const value =
        typeof configured === "function" ? (configured as Responder)(input) : configured;
      if (value instanceof Error) {
        throw value;
      }
      return value as never;
    },
  };
}

export const PROJECTION: CreateProjectionResponse = {
  firstTaskDate: "2026-09-01",
  projectedEndDate: "2026-10-12",
  firstTaskDeadline: "2026-09-01T14:00:00.000Z",
  withinMaximumDuration: true,
};

export const FUNDING_INTENT: CreateFundingIntentResponse = {
  fundingIntentId: "22222222-2222-4222-8222-222222222222",
  providerClientSecret: "secret_abc",
  pollAfterAuthorization: true,
};

export function challengeView(overrides: Partial<ChallengeView> = {}): ChallengeView {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    status: "active",
    configuration: {
      requiredTaskCount: 30,
      schedule: [{ weekday: "monday", deadline: "07:00" }],
      stepTarget: 250,
      noRegretMinutes: 480,
      timeZone: "America/Los_Angeles",
      deposit: { amount: 0, currency: "USD" },
    },
    policyVersion: DISCLOSURE_POLICY_VERSION,
    createdAt: "2026-08-31T00:00:00.000Z",
    activatedAt: "2026-08-31T00:00:00.000Z",
    projectedEndDate: "2026-10-12",
    pause: { pausedAt: null, expiresAt: null },
    progress: {
      requiredTaskCount: 30,
      completedTaskCount: 0,
      skippedTaskCount: 0,
      forgivenTaskCount: 0,
    },
    depositSecured: true,
    currentTask: null,
    recoveryOffer: null,
    ...overrides,
  };
}

export function taskView(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    date: "2026-09-01",
    deadline: "2026-09-01T14:00:00.000Z",
    pauseCutoff: "2026-09-01T06:00:00.000Z",
    status: "scheduled",
    acknowledgedAt: null,
    ...overrides,
  };
}

/** A pause that started well inside the year, for the running-to-paused tests. */
export const PAUSED_AT = "2026-09-02T00:00:00.000Z";
export const PAUSE_EXPIRES_AT = "2027-09-02T00:00:00.000Z";

const DEFAULTS: Partial<Record<ClientEndpointName, unknown>> = {
  createChallengeProjection: PROJECTION,
  createChallenge: { challenge: challengeView() },
  createFundingIntent: FUNDING_INTENT,
  deleteSession: {},
  deleteAccount: {},
  pauseChallenge: {
    challenge: challengeView({ pause: { pausedAt: PAUSED_AT, expiresAt: PAUSE_EXPIRES_AT } }),
    nextSkippedTask: taskView(),
  },
  resumeChallenge: { challenge: challengeView(), nextLiveTask: taskView() },
  acceptRecovery: {
    challenge: challengeView(),
    forgivenTask: taskView({ status: "forgiven" }),
    appendedTask: taskView({ id: "55555555-5555-4555-8555-555555555555", date: "2026-10-13" }),
  },
};
