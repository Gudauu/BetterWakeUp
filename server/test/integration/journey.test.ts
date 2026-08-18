/**
 * One account's whole life, through the handler set the deployment mounts.
 *
 * Every other suite here proves one endpoint against rows it inserted itself.
 * This one inserts nothing: it signs in with a provider token, creates a
 * challenge, reads it back, completes its tasks, pauses and resumes in the
 * middle, and deletes the account, using only routes the app can call and only
 * identifiers earlier responses gave it. That is the check no per-endpoint
 * suite can make, because a surface where each door works and the corridor
 * between two of them does not still passes all of them.
 *
 * `createHandlerSet` is the same composition the Lambda serves, so a command
 * the deployment does not mount fails here rather than on a device.
 */

import {
  DISCLOSURE_POLICY_VERSION,
  type GetCurrentChallengeResponse,
  IDEMPOTENCY_HEADER,
  type TaskView,
  type Weekday,
} from "@betterwakeup/contract";
import { beforeAll, describe, expect, it } from "vitest";

import { SESSION_TTL_SECONDS } from "../../src/auth/config.ts";
import { createProviderTokenVerifier } from "../../src/auth/provider-tokens.ts";
import { createSessionGate } from "../../src/auth/session-gate.ts";
import type { Database } from "../../src/db/index.ts";
import { createApp } from "../../src/http/app.ts";
import { createHandlerSet } from "../../src/lambda/handler-set.ts";
import { createLogger } from "../../src/observability/logger.ts";
import { fakeRateLimiter } from "../support/fake-rate-limiter.ts";
import { useTestDatabase } from "../support/postgres.ts";
import { createProviderKeys, type ProviderKeys } from "../support/provider-tokens.ts";

const testDatabase = useTestDatabase();

/** Monday 5 January 2026, before the day's deadline in Los Angeles. */
const STARTING_AT = new Date("2026-01-05T00:00:00Z");
const EVERY_DAY: Weekday[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];
const CONFIGURATION = {
  requiredTaskCount: 2,
  schedule: EVERY_DAY.map((weekday) => ({ weekday, deadline: "08:00" })),
  stepTarget: 500,
  noRegretMinutes: 60,
  timeZone: "America/Los_Angeles",
  deposit: { amount: 0, currency: "USD" },
} as const;

let keys: ProviderKeys;

beforeAll(async () => {
  keys = await createProviderKeys();
});

/**
 * The app as the deployment composes it, plus a clock the journey moves.
 *
 * Time advances the way it does for a user: the challenge is created on one
 * day and its tasks are completed on the days they fall, each read from the
 * task the server itself returned rather than computed here.
 */
function journeyApp(db: Database) {
  let clock = STARTING_AT;
  const app = createApp({
    logger: createLogger({ sink: () => {} }),
    // The gate reads the same clock as the commands. A session minted in
    // January and checked against the wall clock would be expired before the
    // journey's second call.
    sessionGate: createSessionGate({
      db,
      sessionSecret: keys.config.sessionSecret,
      now: () => clock,
    }),
    rateLimiter: fakeRateLimiter(),
    handlers: createHandlerSet({
      db,
      verifier: createProviderTokenVerifier({
        providers: keys.config.providers,
        keyResolvers: keys.keyResolvers,
      }),
      sessionSecret: keys.config.sessionSecret,
      // The deployment's own session lifetime rather than the fixture's hour:
      // this journey covers two task days, which a user crosses without
      // signing in again and which an hour-long session would not survive.
      sessionTtlSeconds: SESSION_TTL_SECONDS,
      now: () => clock,
    }),
  });
  return {
    app,
    travelTo(instant: string) {
      clock = new Date(instant);
    },
  };
}

let keyCounter = 0;

/** A fresh idempotency key, in the UUID shape the contract requires. */
function nextKey(): string {
  keyCounter += 1;
  return `5a4bcd10-0000-4000-8000-${String(keyCounter).padStart(12, "0")}`;
}

type Server = ReturnType<typeof journeyApp>["app"];

interface CallOptions {
  readonly token?: string;
  readonly body?: unknown;
  readonly key?: string;
}

async function call(
  server: Server,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<{ status: number; body: unknown }> {
  const response = await server.request(`http://api.test${path}`, {
    method,
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.key === undefined ? {} : { [IDEMPOTENCY_HEADER]: options.key }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, body: await response.json() };
}

/** One minute before the deadline, which is inside the task's window. */
function justBeforeDeadline(task: TaskView): string {
  return new Date(Date.parse(task.deadline) - 60_000).toISOString();
}

describe("an account's whole life through the mounted surface", () => {
  it("signs in, runs a challenge to success, and deletes the account", async () => {
    const { db } = testDatabase();
    const { app, travelTo } = journeyApp(db);

    // Sign in. Nothing before this call names an account: the account is what
    // the provider token becomes.
    const signedIn = await call(app, "POST", "/sessions", {
      body: { provider: "apple", idToken: await keys.sign("apple", { subject: "journey-1" }) },
    });
    expect(signedIn.status).toBe(200);
    const { session } = signedIn.body as { session: { token: string } };
    const token = session.token;

    // A new account holds no challenge, which is the state home renders its
    // start-a-challenge card for.
    const empty = await call(app, "GET", "/challenges/current", { token });
    expect(empty.status).toBe(200);
    expect((empty.body as GetCurrentChallengeResponse).challenge).toBeNull();

    // The projection the create screen shows before anything is committed.
    const projected = await call(app, "POST", "/challenges/projections", {
      token,
      body: { configuration: CONFIGURATION },
    });
    expect(projected.status).toBe(200);
    expect(projected.body).toMatchObject({ firstTaskDate: "2026-01-05" });

    const created = await call(app, "POST", "/challenges", {
      token,
      key: nextKey(),
      body: { configuration: CONFIGURATION, policyVersion: DISCLOSURE_POLICY_VERSION },
    });
    expect(created.status).toBe(200);
    const challengeId = (created.body as { challenge: { id: string } }).challenge.id;

    // Read it back the way home does, and take the first task from the read
    // rather than from the creation response.
    const first = await call(app, "GET", "/challenges/current", { token });
    const firstChallenge = (first.body as GetCurrentChallengeResponse).challenge;
    expect(firstChallenge).toMatchObject({
      id: challengeId,
      status: "active",
      progress: { requiredTaskCount: 2, completedTaskCount: 0 },
    });
    const firstTask = firstChallenge?.currentTask;
    if (firstTask == null) throw new Error("the new challenge has no current task");

    // The first day's walk, acknowledged inside the task's window.
    const completedAt = justBeforeDeadline(firstTask);
    travelTo(completedAt);
    const recordId = nextKey();
    const acknowledged = await call(app, "POST", `/tasks/${firstTask.id}/completions`, {
      token,
      key: recordId,
      body: {
        clientRecordId: recordId,
        completedAt,
        observation: {
          startedAt: new Date(Date.parse(completedAt) - 600_000).toISOString(),
          endedAt: completedAt,
          steps: 640,
          provenance: "live-foreground",
          source: "expo-pedometer-ios",
        },
        appVersion: "1.0.0",
        verificationPolicyVersion: "steps.1",
      },
    });
    expect(acknowledged.status).toBe(200);
    expect(acknowledged.body).toMatchObject({
      task: { id: firstTask.id, status: "completed" },
      replayed: false,
      challengeStatus: "active",
    });

    // Pause and resume, which is the one lifecycle command a running challenge
    // offers, and take the task the resume names rather than assuming which
    // day the pause left live.
    const paused = await call(app, "POST", `/challenges/${challengeId}/pause`, {
      token,
      key: nextKey(),
      body: {},
    });
    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({ challenge: { pause: { pausedAt: expect.any(String) } } });

    const resumed = await call(app, "DELETE", `/challenges/${challengeId}/pause`, {
      token,
      key: nextKey(),
    });
    expect(resumed.status).toBe(200);
    const { nextLiveTask } = resumed.body as { nextLiveTask: TaskView | null };
    if (nextLiveTask == null) throw new Error("the resumed challenge has no live task");

    // The second walk, which is the one the challenge needed.
    const secondAt = justBeforeDeadline(nextLiveTask);
    travelTo(secondAt);
    const secondRecordId = nextKey();
    const finished = await call(app, "POST", `/tasks/${nextLiveTask.id}/completions`, {
      token,
      key: secondRecordId,
      body: {
        clientRecordId: secondRecordId,
        completedAt: secondAt,
        observation: {
          startedAt: new Date(Date.parse(secondAt) - 600_000).toISOString(),
          endedAt: secondAt,
          steps: 700,
          provenance: "live-foreground",
          source: "expo-pedometer-ios",
        },
        appVersion: "1.0.0",
        verificationPolicyVersion: "steps.1",
      },
    });
    expect(finished.status).toBe(200);
    expect(finished.body).toMatchObject({ challengeStatus: "succeeded" });

    // A succeeded challenge is terminal, so the account holds none again.
    const afterSuccess = await call(app, "GET", "/challenges/current", { token });
    expect((afterSuccess.body as GetCurrentChallengeResponse).challenge).toBeNull();

    // And the account can be deleted, which is what the delete-account screen
    // calls and what leaves the session unusable.
    const deleted = await call(app, "DELETE", "/accounts", { token, key: nextKey() });
    expect(deleted.status).toBe(200);

    const afterDeletion = await call(app, "GET", "/challenges/current", { token });
    expect(afterDeletion.status).toBe(401);
  });
});
