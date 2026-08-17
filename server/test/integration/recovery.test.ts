/**
 * Issue 24 against real rows and through the mounted route.
 *
 * The state the command acts on is built by running the real sweep rather than
 * by inserting a `recovery_pending` challenge: the offer, the missed instant it
 * is measured from, and the capture command it cancels are all the sweep's
 * output, and a fixture that invented them would let this suite pass against a
 * shape issue 23 does not produce.
 *
 * The fixtures place three tasks on 2026-01-05, -06, and -07, each with an
 * 08:00 deadline in `America/Los_Angeles` (16:00 UTC). The sweep is run one
 * millisecond past the first task's receipt grace, so the miss, the offer, and
 * the settlement instant are all written against that one moment and the
 * window boundary can be tested to the millisecond.
 */

import {
  IDEMPOTENCY_HEADER,
  RECEIPT_GRACE_SECONDS,
  RECOVERY_WINDOW_HOURS,
} from "@betterwakeup/contract";
import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createSessionGate } from "../../src/auth/session-gate.ts";
import { hashSessionToken, mintSessionToken } from "../../src/auth/session-token.ts";
import { createChallengeHandlers } from "../../src/challenges/handlers.ts";
import type { Database } from "../../src/db/index.ts";
import { paymentCommands } from "../../src/db/schema/payments.ts";
import { accounts, challenges, scheduledTasks, sessions } from "../../src/db/schema.ts";
import { createApp } from "../../src/http/app.ts";
import type { ScheduledEvent } from "../../src/lambda/events.ts";
import { createLogger } from "../../src/observability/logger.ts";
import { createSweep } from "../../src/sweep/run-sweep.ts";
import {
  insertAccount,
  insertChallengeForAccount,
  taskDeadline,
} from "../support/challenge-fixtures.ts";
import { fakeRateLimiter } from "../support/fake-rate-limiter.ts";
import { scheduledEvent } from "../support/lambda-events.ts";
import { useTestDatabase } from "../support/postgres.ts";

const testDatabase = useTestDatabase();

const SESSION_SECRET = "0123456789abcdef0123456789abcdef";
const HOUR_MS = 60 * 60 * 1000;

/** The instant the sweep runs at, one millisecond past task 1's receipt grace. */
const MISSED_AT = new Date(taskDeadline(1).getTime() + RECEIPT_GRACE_SECONDS * 1000 + 1);
/** The last instant the offer stands, which is also the settlement instant. */
const OFFER_EXPIRES = new Date(MISSED_AT.getTime() + RECOVERY_WINDOW_HOURS * HOUR_MS);

const KEY = {
  first: "b1c20000-0000-4000-8000-000000000001",
  second: "b1c20000-0000-4000-8000-000000000002",
  third: "b1c20000-0000-4000-8000-000000000003",
};

function app(db: Database, at: Date) {
  return createApp({
    logger: createLogger({ sink: () => {} }),
    sessionGate: createSessionGate({ db, sessionSecret: SESSION_SECRET }),
    rateLimiter: fakeRateLimiter(),
    handlers: createChallengeHandlers({ db, now: () => at }),
  });
}

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

function recoveryRequest(
  token: string,
  challengeId: string,
  taskId: string,
  key: string,
): [string, RequestInit] {
  return [
    `http://api.test/challenges/${challengeId}/recovery`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        [IDEMPOTENCY_HEADER]: key,
      },
      body: JSON.stringify({ taskId }),
    },
  ];
}

interface Offer {
  readonly accountId: string;
  readonly token: string;
  readonly challengeId: string;
  /** The missed task the sweep opened the offer for. */
  readonly taskId: string;
}

/**
 * An account with a funded challenge the sweep has moved to `recovery_pending`,
 * which is the only state the command has anything to act on.
 */
async function arrangeOffer(db: Database, depositMinorUnits = 2000): Promise<Offer> {
  const { accountId, token } = await signIn(db);
  const challengeId = await insertChallengeForAccount(db, accountId, { depositMinorUnits });

  const run = createSweep({ db, now: () => MISSED_AT });
  await run(scheduledEvent() as ScheduledEvent, createLogger({ sink: () => {} }));

  const tasks = await tasksOf(db, challengeId);
  const missed = tasks.find((task) => task.status === "missed");
  return { accountId, token, challengeId, taskId: missed?.id ?? "no task was missed" };
}

async function tasksOf(db: Database, challengeId: string) {
  return await db
    .select({
      id: scheduledTasks.id,
      sequence: scheduledTasks.sequence,
      taskDate: scheduledTasks.taskDate,
      status: scheduledTasks.status,
      missedAt: scheduledTasks.missedAt,
      forgivenAt: scheduledTasks.forgivenAt,
    })
    .from(scheduledTasks)
    .where(eq(scheduledTasks.challengeId, challengeId))
    .orderBy(asc(scheduledTasks.sequence));
}

async function challengeRow(db: Database, challengeId: string) {
  const [row] = await db
    .select({
      status: challenges.status,
      terminalAt: challenges.terminalAt,
      projectedEndDate: challenges.projectedEndDate,
    })
    .from(challenges)
    .where(eq(challenges.id, challengeId));
  if (row === undefined) throw new Error("the challenge disappeared");
  return row;
}

async function captureOf(db: Database, challengeId: string) {
  const [row] = await db
    .select({ status: paymentCommands.status, settledAt: paymentCommands.settledAt })
    .from(paymentCommands)
    .where(and(eq(paymentCommands.challengeId, challengeId), eq(paymentCommands.kind, "capture")));
  return row;
}

async function allowanceOf(db: Database, accountId: string): Promise<Date | null> {
  const [row] = await db
    .select({ consumedAt: accounts.emergencyRecoveryConsumedAt })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  return row?.consumedAt ?? null;
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("the recovery window boundary", () => {
  it("accepts a recovery arriving at the settlement instant", async () => {
    const db = testDatabase().db;
    const offer = await arrangeOffer(db);

    const response = await app(db, OFFER_EXPIRES).request(
      ...recoveryRequest(offer.token, offer.challengeId, offer.taskId, KEY.first),
    );

    expect(response.status).toBe(200);
    expect(await challengeRow(db, offer.challengeId)).toMatchObject({
      status: "active",
      terminalAt: null,
    });
  });

  it("refuses a recovery arriving one millisecond later, and changes nothing", async () => {
    const db = testDatabase().db;
    const offer = await arrangeOffer(db);

    const response = await app(db, new Date(OFFER_EXPIRES.getTime() + 1)).request(
      ...recoveryRequest(offer.token, offer.challengeId, offer.taskId, KEY.first),
    );

    expect(response.status).toBe(409);
    expect(await body(response)).toMatchObject({ code: "recovery_window_closed" });
    expect((await challengeRow(db, offer.challengeId)).status).toBe("recovery_pending");
    expect(await allowanceOf(db, offer.accountId)).toBeNull();
    expect(await captureOf(db, offer.challengeId)).toMatchObject({ status: "pending" });
  });

  it("refuses a recovery once the settlement has already executed", async () => {
    const db = testDatabase().db;
    const offer = await arrangeOffer(db);
    // The settlement pass issue 25 builds, having taken the capture.
    await db
      .update(paymentCommands)
      .set({ status: "confirmed", settledAt: OFFER_EXPIRES, providerReference: "ch_test" })
      .where(eq(paymentCommands.challengeId, offer.challengeId));

    const response = await app(db, MISSED_AT).request(
      ...recoveryRequest(offer.token, offer.challengeId, offer.taskId, KEY.first),
    );

    expect(response.status).toBe(409);
    expect(await body(response)).toMatchObject({ code: "recovery_window_closed" });
    expect(await allowanceOf(db, offer.accountId)).toBeNull();
  });
});

describe("what one recovery commits", () => {
  it("forgives the miss, appends a replacement, cancels the capture, and resumes", async () => {
    const db = testDatabase().db;
    const offer = await arrangeOffer(db);
    const at = new Date(MISSED_AT.getTime() + HOUR_MS);

    const response = await app(db, at).request(
      ...recoveryRequest(offer.token, offer.challengeId, offer.taskId, KEY.first),
    );
    expect(response.status).toBe(200);

    const tasks = await tasksOf(db, offer.challengeId);
    const forgiven = tasks.find((task) => task.id === offer.taskId);
    expect(forgiven).toMatchObject({ status: "forgiven", forgivenAt: at });
    // The miss it supersedes is kept: it is the reason the allowance was spent.
    expect(forgiven?.missedAt).toEqual(MISSED_AT);

    // One replacement, past the last date the challenge held, and the stored
    // projection moved onto it.
    expect(tasks).toHaveLength(4);
    expect(tasks[3]).toMatchObject({ sequence: 4, taskDate: "2026-01-08", status: "scheduled" });
    expect(await challengeRow(db, offer.challengeId)).toMatchObject({
      status: "active",
      projectedEndDate: "2026-01-08",
    });

    expect(await captureOf(db, offer.challengeId)).toMatchObject({
      status: "cancelled",
      settledAt: at,
    });
    expect(await allowanceOf(db, offer.accountId)).toEqual(at);
  });

  it("answers with the forgiven task and the appended one", async () => {
    const db = testDatabase().db;
    const offer = await arrangeOffer(db);

    const response = await app(db, MISSED_AT).request(
      ...recoveryRequest(offer.token, offer.challengeId, offer.taskId, KEY.first),
    );

    const answered = await body(response);
    expect(answered).toMatchObject({
      challenge: { status: "active", recoveryOffer: null },
      forgivenTask: { id: offer.taskId, status: "forgiven" },
      appendedTask: { date: "2026-01-08", status: "scheduled" },
    });
  });

  it("replays under the same key rather than recovering twice", async () => {
    const db = testDatabase().db;
    const offer = await arrangeOffer(db);
    const send = () =>
      app(db, MISSED_AT).request(
        ...recoveryRequest(offer.token, offer.challengeId, offer.taskId, KEY.first),
      );

    const first = await send();
    const second = await send();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await body(second)).toEqual(await body(first));
    expect(await tasksOf(db, offer.challengeId)).toHaveLength(4);
  });
});

describe("the refusals", () => {
  it("refuses a second attempt under a fresh key on the challenge it recovered", async () => {
    const db = testDatabase().db;
    const offer = await arrangeOffer(db);
    const server = app(db, MISSED_AT);

    await server.request(
      ...recoveryRequest(offer.token, offer.challengeId, offer.taskId, KEY.first),
    );
    const second = await server.request(
      ...recoveryRequest(offer.token, offer.challengeId, offer.taskId, KEY.second),
    );

    expect(second.status).toBe(409);
    // The allowance is checked before the challenge's status, so the answer
    // names the reason the user cannot do this again anywhere rather than the
    // reason this particular challenge has no offer standing.
    expect(await body(second)).toMatchObject({ code: "recovery_already_consumed" });
    expect((await challengeRow(db, offer.challengeId)).status).toBe("active");
  });

  it("refuses a later challenge once the lifetime allowance is spent", async () => {
    const db = testDatabase().db;
    const { accountId, token } = await signIn(db);
    await db
      .update(accounts)
      .set({ emergencyRecoveryConsumedAt: new Date(Date.UTC(2025, 5, 1)) })
      .where(eq(accounts.id, accountId));
    const challengeId = await insertChallengeForAccount(db, accountId, {
      status: "recovery_pending",
    });

    const response = await app(db, MISSED_AT).request(
      ...recoveryRequest(token, challengeId, KEY.third, KEY.first),
    );

    expect(response.status).toBe(409);
    expect(await body(response)).toMatchObject({ code: "recovery_already_consumed" });
  });

  it("refuses a failed zero deposit challenge, which is never offered recovery", async () => {
    const db = testDatabase().db;
    const offer = await arrangeOffer(db, 0);

    // The sweep fails a zero deposit challenge outright: a lifetime allowance
    // must not be spendable on a challenge that costs nothing to fail.
    expect((await challengeRow(db, offer.challengeId)).status).toBe("failed");
    expect(await captureOf(db, offer.challengeId)).toBeUndefined();

    const response = await app(db, MISSED_AT).request(
      ...recoveryRequest(offer.token, offer.challengeId, offer.taskId, KEY.first),
    );

    expect(response.status).toBe(409);
    expect(await body(response)).toMatchObject({ code: "recovery_not_offered" });
    expect(await allowanceOf(db, offer.accountId)).toBeNull();
  });

  it("refuses a request naming a task the offer is not for", async () => {
    const db = testDatabase().db;
    const offer = await arrangeOffer(db);
    const other = (await tasksOf(db, offer.challengeId)).find(
      (task) => task.status === "scheduled",
    );

    const response = await app(db, MISSED_AT).request(
      ...recoveryRequest(offer.token, offer.challengeId, other?.id ?? "", KEY.first),
    );

    expect(response.status).toBe(409);
    expect(await body(response)).toMatchObject({ code: "recovery_not_offered" });
    expect((await challengeRow(db, offer.challengeId)).status).toBe("recovery_pending");
  });

  it("answers another account's challenge with not found", async () => {
    const db = testDatabase().db;
    const offer = await arrangeOffer(db);
    const stranger = await signIn(db);

    const response = await app(db, MISSED_AT).request(
      ...recoveryRequest(stranger.token, offer.challengeId, offer.taskId, KEY.first),
    );

    expect(response.status).toBe(404);
    expect(await body(response)).toMatchObject({ code: "not_found" });
  });
});

describe("two writers over one account", () => {
  /**
   * The account row lock, which is what makes the lifetime allowance a real one
   * under concurrency. Racing two requests from here would test whichever
   * connection warmed up first, so the other writer signals from inside its
   * transaction that it holds the lock before the recovery starts.
   *
   * Without the lock the recovery reads an unspent allowance, decides to
   * consume it, and is stopped by the trigger on the account row, which is a
   * 500 rather than the refusal the user is owed.
   */
  it("waits for a concurrent writer rather than deciding on a stale read", async () => {
    const test = testDatabase();
    const other = test.connect();
    const offer = await arrangeOffer(test.db);

    let release = (): void => {};
    let lockTaken = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });
    const otherWriter = other.db.transaction(async (tx) => {
      await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.id, offer.accountId))
        .for("update");
      lockTaken();
      await held;
      await tx
        .update(accounts)
        .set({ emergencyRecoveryConsumedAt: MISSED_AT })
        .where(eq(accounts.id, offer.accountId));
    });

    await locked;
    const recovering = app(test.db, MISSED_AT).request(
      ...recoveryRequest(offer.token, offer.challengeId, offer.taskId, KEY.first),
    );
    // Long enough for the recovery to have reached the lock it is waiting on.
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await otherWriter;

    const response = await recovering;
    expect(response.status).toBe(409);
    expect(await body(response)).toMatchObject({ code: "recovery_already_consumed" });
    expect((await challengeRow(test.db, offer.challengeId)).status).toBe("recovery_pending");
  });
});
