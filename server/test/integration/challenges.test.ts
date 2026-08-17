/**
 * Issue 18 against real rows and through the mounted routes.
 *
 * The acceptance boundary is the first section: the schedule a projection
 * describes is the schedule the challenge is later materialized with, and a
 * projection leaves the database exactly as it found it. The rest covers the
 * two doors this endpoint is not, the one-challenge rule, and what `current`
 * means.
 */

import {
  type ChallengeConfiguration,
  IDEMPOTENCY_HEADER,
  type Weekday,
} from "@betterwakeup/contract";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createSessionGate } from "../../src/auth/session-gate.ts";
import { hashSessionToken, mintSessionToken } from "../../src/auth/session-token.ts";
import { createChallengeHandlers } from "../../src/challenges/handlers.ts";
import type { Database } from "../../src/db/index.ts";
import {
  challengeScheduleDays,
  challenges,
  idempotencyKeys,
  scheduledTasks,
  sessions,
} from "../../src/db/schema.ts";
import { createApp } from "../../src/http/app.ts";
import { createLogger } from "../../src/observability/logger.ts";
import { insertAccount, insertChallengeForAccount } from "../support/challenge-fixtures.ts";
import { fakeRateLimiter } from "../support/fake-rate-limiter.ts";
import { useTestDatabase } from "../support/postgres.ts";

const testDatabase = useTestDatabase();

const SESSION_SECRET = "0123456789abcdef0123456789abcdef";
/** Midnight UTC on Monday 5 January 2026, so every date in this file is fixed. */
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

function configuration(overrides: Partial<ChallengeConfiguration> = {}): ChallengeConfiguration {
  return {
    requiredTaskCount: 4,
    schedule: EVERY_DAY.map((weekday) => ({ weekday, deadline: "08:00" })),
    stepTarget: 500,
    noRegretMinutes: 60,
    timeZone: "America/Los_Angeles",
    deposit: { amount: 0, currency: "USD" },
    ...overrides,
  };
}

function app(db: Database) {
  return createApp({
    logger: createLogger({ sink: () => {} }),
    sessionGate: createSessionGate({ db, sessionSecret: SESSION_SECRET }),
    rateLimiter: fakeRateLimiter(),
    handlers: createChallengeHandlers({ db, now: () => STARTING_AT }),
  });
}

/** An account with a live session, the way sign-in leaves one. */
async function signIn(db: Database): Promise<{ accountId: string; token: string }> {
  const accountId = await insertAccount(db);
  const minted = await mintSessionToken({ secret: SESSION_SECRET, accountId, ttlSeconds: 3600 });
  await db.insert(sessions).values({
    id: minted.sessionId,
    accountId,
    tokenHash: hashSessionToken(minted.token),
    createdAt: minted.issuedAt,
    expiresAt: minted.expiresAt,
  });
  return { accountId, token: minted.token };
}

function post(token: string, path: string, body: unknown, key?: string): [string, RequestInit] {
  return [
    `http://api.test${path}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(key === undefined ? {} : { [IDEMPOTENCY_HEADER]: key }),
      },
      body: JSON.stringify(body),
    },
  ];
}

function get(token: string, path: string): [string, RequestInit] {
  return [`http://api.test${path}`, { headers: { authorization: `Bearer ${token}` } }];
}

/** Everything a projection must not touch. */
async function storedRowCounts(db: Database): Promise<Record<string, number>> {
  return {
    challenges: (await db.select({ id: challenges.id }).from(challenges)).length,
    scheduleDays: (
      await db.select({ id: challengeScheduleDays.challengeId }).from(challengeScheduleDays)
    ).length,
    tasks: (await db.select({ id: scheduledTasks.id }).from(scheduledTasks)).length,
    idempotencyKeys: (await db.select({ key: idempotencyKeys.key }).from(idempotencyKeys)).length,
  };
}

describe("issue 18's acceptance boundary", () => {
  it("projects the schedule the challenge is later materialized with", async () => {
    const { db } = testDatabase();
    const { token } = await signIn(db);
    const server = app(db);
    const config = configuration({ requiredTaskCount: 6 });

    const projected = await server.request(
      ...post(token, "/challenges/projections", { configuration: config }),
    );
    expect(projected.status).toBe(200);
    const projection = (await projected.json()) as {
      firstTaskDate: string;
      firstTaskDeadline: string;
      projectedEndDate: string;
      withinMaximumDuration: boolean;
    };

    const created = await server.request(
      ...post(
        token,
        "/challenges",
        { configuration: config, policyVersion: "2026-01-01" },
        "5a4bcd10-0000-4000-8000-000000000001",
      ),
    );
    expect(created.status).toBe(200);
    const { challenge } = (await created.json()) as { challenge: { id: string } };

    const materialized = await db
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.challengeId, challenge.id))
      .orderBy(asc(scheduledTasks.sequence));

    // The projection described these rows before they existed.
    expect(materialized).toHaveLength(6);
    expect(materialized[0]?.taskDate).toBe(projection.firstTaskDate);
    expect(materialized[0]?.deadline.toISOString()).toBe(projection.firstTaskDeadline);
    expect(materialized[5]?.taskDate).toBe(projection.projectedEndDate);

    const [stored] = await db
      .select({ projectedEndDate: challenges.projectedEndDate })
      .from(challenges)
      .where(eq(challenges.id, challenge.id));
    expect(stored?.projectedEndDate).toBe(projection.projectedEndDate);
  });

  it("writes nothing at all when projecting", async () => {
    const { db } = testDatabase();
    const { token } = await signIn(db);
    const server = app(db);

    const before = await storedRowCounts(db);
    const response = await server.request(
      ...post(token, "/challenges/projections", { configuration: configuration() }),
    );

    expect(response.status).toBe(200);
    expect(await storedRowCounts(db)).toEqual(before);
    // No idempotency key was required and none was spent: the projection is a
    // question, not a command.
    expect(before.idempotencyKeys).toBe(0);
  });

  it("rejects a funded configuration that runs past the maximum duration and accepts the unfunded one", async () => {
    const { db } = testDatabase();
    const { token } = await signIn(db);
    const server = app(db);
    const tooLong = { requiredTaskCount: 400 };

    const funded = await server.request(
      ...post(token, "/challenges/projections", {
        configuration: configuration({ ...tooLong, deposit: { amount: 5000, currency: "USD" } }),
      }),
    );
    const unfunded = await server.request(
      ...post(token, "/challenges/projections", { configuration: configuration(tooLong) }),
    );

    expect(await funded.json()).toMatchObject({ withinMaximumDuration: false });
    expect(await unfunded.json()).toMatchObject({ withinMaximumDuration: true });
  });

  it("rejects a deposit between nothing and a dollar", async () => {
    const { db } = testDatabase();
    const { token } = await signIn(db);
    const server = app(db);
    const between = configuration({ deposit: { amount: 50, currency: "USD" } });

    const projected = await server.request(
      ...post(token, "/challenges/projections", { configuration: between }),
    );
    const created = await server.request(
      ...post(
        token,
        "/challenges",
        { configuration: between, policyVersion: "2026-01-01" },
        "5a4bcd10-0000-4000-8000-000000000002",
      ),
    );

    // The rule is stated in the contract, so both are refused at the
    // validation boundary before any handler sees them.
    expect(projected.status).toBe(400);
    expect(await projected.json()).toMatchObject({ code: "validation_failed" });
    expect(created.status).toBe(400);
    expect(await storedRowCounts(db)).toMatchObject({ challenges: 0 });
  });
});

describe("creating a zero deposit challenge", () => {
  it("materializes the challenge, its schedule, and its tasks in one command", async () => {
    const { db } = testDatabase();
    const { accountId, token } = await signIn(db);
    const server = app(db);

    const response = await server.request(
      ...post(
        token,
        "/challenges",
        {
          configuration: configuration({
            schedule: [
              { weekday: "monday", deadline: "08:00" },
              { weekday: "thursday", deadline: "21:15" },
            ],
          }),
          policyVersion: "2026-01-01",
        },
        "5a4bcd10-0000-4000-8000-000000000003",
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      challenge: {
        status: "active",
        policyVersion: "2026-01-01",
        projectedEndDate: "2026-01-15",
        depositSecured: true,
        configuration: {
          requiredTaskCount: 4,
          deposit: { amount: 0, currency: "USD" },
          schedule: [
            { weekday: "monday", deadline: "08:00" },
            { weekday: "thursday", deadline: "21:15" },
          ],
        },
        pause: { pausedAt: null, expiresAt: null },
        progress: {
          requiredTaskCount: 4,
          completedTaskCount: 0,
          skippedTaskCount: 0,
          forgivenTaskCount: 0,
        },
        currentTask: { date: "2026-01-05", status: "scheduled" },
        recoveryOffer: null,
      },
    });

    const [row] = await db.select().from(challenges).where(eq(challenges.accountId, accountId));
    expect(row?.activatedAt?.toISOString()).toBe(STARTING_AT.toISOString());
    expect(
      await db
        .select({ weekday: challengeScheduleDays.weekday })
        .from(challengeScheduleDays)
        .where(eq(challengeScheduleDays.challengeId, row?.id ?? "")),
    ).toHaveLength(2);
  });

  it("refuses a funded configuration, which belongs to the funding intent", async () => {
    const { db } = testDatabase();
    const { token } = await signIn(db);
    const server = app(db);

    const response = await server.request(
      ...post(
        token,
        "/challenges",
        {
          configuration: configuration({ deposit: { amount: 5000, currency: "USD" } }),
          policyVersion: "2026-01-01",
        },
        "5a4bcd10-0000-4000-8000-000000000004",
      ),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "zero_deposit_required" });
    // A refused request spends nothing, so the caller can send a corrected one
    // under a fresh key with no history to explain.
    expect(await storedRowCounts(db)).toMatchObject({ challenges: 0, idempotencyKeys: 0 });
  });

  it("replays the stored result for a repeated key rather than creating a second challenge", async () => {
    const { db } = testDatabase();
    const { accountId, token } = await signIn(db);
    const server = app(db);
    const request = () =>
      server.request(
        ...post(
          token,
          "/challenges",
          { configuration: configuration(), policyVersion: "2026-01-01" },
          "5a4bcd10-0000-4000-8000-000000000005",
        ),
      );

    const first = (await (await request()).json()) as { challenge: { id: string } };
    const second = (await (await request()).json()) as { challenge: { id: string } };

    expect(second).toEqual(first);
    expect(
      await db
        .select({ id: challenges.id })
        .from(challenges)
        .where(eq(challenges.accountId, accountId)),
    ).toHaveLength(1);
  });

  it("refuses a second challenge under a new key while one is running", async () => {
    const { db } = testDatabase();
    const { accountId, token } = await signIn(db);
    await insertChallengeForAccount(db, accountId, { depositMinorUnits: 0 });
    const server = app(db);

    const response = await server.request(
      ...post(
        token,
        "/challenges",
        { configuration: configuration(), policyVersion: "2026-01-01" },
        "5a4bcd10-0000-4000-8000-000000000006",
      ),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "active_challenge_exists" });
  });

  it("lets a new challenge start once the previous one has ended", async () => {
    const { db } = testDatabase();
    const { accountId, token } = await signIn(db);
    await insertChallengeForAccount(db, accountId, { status: "failed", depositMinorUnits: 0 });
    const server = app(db);

    const response = await server.request(
      ...post(
        token,
        "/challenges",
        { configuration: configuration(), policyVersion: "2026-01-01" },
        "5a4bcd10-0000-4000-8000-000000000007",
      ),
    );

    expect(response.status).toBe(200);
    expect(
      await db
        .select({ id: challenges.id })
        .from(challenges)
        .where(eq(challenges.accountId, accountId)),
    ).toHaveLength(2);
  });

  it("serializes two simultaneous creations on the account row", async () => {
    const test = testDatabase();
    const second = test.connect();
    const { accountId, token } = await signIn(test.db);

    const responses = await Promise.all([
      app(test.db).request(
        ...post(
          token,
          "/challenges",
          { configuration: configuration(), policyVersion: "2026-01-01" },
          "5a4bcd10-0000-4000-8000-000000000008",
        ),
      ),
      app(second.db).request(
        ...post(
          token,
          "/challenges",
          { configuration: configuration(), policyVersion: "2026-01-01" },
          "5a4bcd10-0000-4000-8000-000000000009",
        ),
      ),
    ]);

    // Two different keys, so idempotency has nothing to say. The account lock
    // and the one-challenge rule are what decide this.
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(
      await test.db
        .select({ id: challenges.id })
        .from(challenges)
        .where(eq(challenges.accountId, accountId)),
    ).toHaveLength(1);
  });
});

describe("the current challenge", () => {
  it("is null before there is one", async () => {
    const { db } = testDatabase();
    const { token } = await signIn(db);

    const response = await app(db).request(...get(token, "/challenges/current"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: null });
  });

  it("is the challenge the account just created", async () => {
    const { db } = testDatabase();
    const { token } = await signIn(db);
    const server = app(db);
    const created = await server.request(
      ...post(
        token,
        "/challenges",
        { configuration: configuration(), policyVersion: "2026-01-01" },
        "5a4bcd10-0000-4000-8000-00000000000a",
      ),
    );
    const { challenge } = (await created.json()) as { challenge: unknown };

    const response = await server.request(...get(token, "/challenges/current"));

    expect(await response.json()).toEqual({ challenge });
  });

  it("is null again once the challenge has ended", async () => {
    const { db } = testDatabase();
    const { accountId, token } = await signIn(db);
    await insertChallengeForAccount(db, accountId, { status: "succeeded", depositMinorUnits: 0 });

    const response = await app(db).request(...get(token, "/challenges/current"));

    expect(await response.json()).toEqual({ challenge: null });
  });

  it("is another account's challenge to nobody", async () => {
    const { db } = testDatabase();
    const { token } = await signIn(db);
    const stranger = await insertAccount(db);
    await insertChallengeForAccount(db, stranger, { depositMinorUnits: 0 });

    const response = await app(db).request(...get(token, "/challenges/current"));

    expect(await response.json()).toEqual({ challenge: null });
  });

  it("carries the standing Emergency Recovery offer while one is open", async () => {
    const { db } = testDatabase();
    const { accountId, token } = await signIn(db);
    const challengeId = await insertChallengeForAccount(db, accountId, {
      status: "recovery_pending",
      depositMinorUnits: 2000,
      taskStatus: "missed",
    });
    const missedTasks = await db
      .select({ id: scheduledTasks.id, missedAt: scheduledTasks.missedAt })
      .from(scheduledTasks)
      .where(eq(scheduledTasks.challengeId, challengeId))
      .orderBy(asc(scheduledTasks.sequence));
    // The offer belongs to the miss that opened it, which is the latest one:
    // an earlier miss would already have ended the challenge.
    const missed = missedTasks[missedTasks.length - 1];

    const response = await app(db).request(...get(token, "/challenges/current"));

    const body = (await response.json()) as {
      challenge: { status: string; recoveryOffer: { taskId: string; expiresAt: string } | null };
    };
    expect(body.challenge.status).toBe("recovery_pending");
    // The offer belongs to the miss that opened it and stands for the recovery
    // window, which the fixtures' last missed task fixes exactly.
    expect(body.challenge.recoveryOffer?.taskId).toBe(missed?.id);
    expect(body.challenge.recoveryOffer?.expiresAt).toBe(
      new Date((missed?.missedAt?.getTime() ?? 0) + 24 * 60 * 60 * 1000).toISOString(),
    );
  });
});
