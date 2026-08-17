/**
 * Issue 26: the three races the architecture leaves open, run for real.
 *
 * Every other suite states an outcome and asserts it. This one cannot: the
 * point of a race is that either side may win, so an assertion naming a winner
 * would either be testing which connection warmed up first or would have to
 * serialize the very thing under test. What is asserted instead is that exactly
 * one side won, that the loser was told so rather than silently ignored, and
 * that the database satisfies every invariant the architecture lists once the
 * dust settles. `assertInvariantsHold` is the assertion that does the work, and
 * `invariant-checker.test.ts` is what establishes it fires.
 *
 * The load is real rather than notional: each caller gets its own connection,
 * because a test database handle holds a pool of one, so N callers sharing a
 * handle would queue rather than race.
 *
 * The three races:
 *
 * - A completion arriving at the last instant of its receipt grace, against a
 *   sweep judging the same task one millisecond later. Both are entitled to act
 *   and the task's row lock is what orders them.
 * - Emergency Recovery arriving at the last instant of its window, against the
 *   settlement whose `execute_after` is that same instant. Money moves on one
 *   side and is forgiven on the other, so this is the race that must never
 *   both.
 * - One idempotency key fired by many callers at once, which is the case
 *   issue 12's key insert exists for.
 */

import {
  IDEMPOTENCY_HEADER,
  type MovementObservation,
  RECEIPT_GRACE_SECONDS,
  RECOVERY_WINDOW_HOURS,
} from "@betterwakeup/contract";
import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createSessionGate } from "../../src/auth/session-gate.ts";
import { hashSessionToken, mintSessionToken } from "../../src/auth/session-token.ts";
import { createChallengeHandlers } from "../../src/challenges/handlers.ts";
import type { Database, DatabaseHandle } from "../../src/db/index.ts";
import { challengeAuthorizations } from "../../src/db/schema/authorizations.ts";
import {
  challenges,
  ledgerEntries,
  ledgerTransactions,
  paymentCommands,
  scheduledTasks,
  sessions,
  taskCompletions,
} from "../../src/db/schema.ts";
import { createApp } from "../../src/http/app.ts";
import type { ScheduledEvent } from "../../src/lambda/events.ts";
import { createLogger } from "../../src/observability/logger.ts";
import { FakePaymentProvider } from "../../src/payments/fake-provider.ts";
import { runSettlementPass } from "../../src/payments/settlement.ts";
import { createSweep } from "../../src/sweep/run-sweep.ts";
import { createTaskHandlers } from "../../src/tasks/handlers.ts";
import {
  insertAccount,
  insertChallengeForAccount,
  taskDeadline,
} from "../support/challenge-fixtures.ts";
import { fakeRateLimiter } from "../support/fake-rate-limiter.ts";
import { assertInvariantsHold } from "../support/invariants.ts";
import { scheduledEvent } from "../support/lambda-events.ts";
import { useTestDatabase } from "../support/postgres.ts";

const testDatabase = useTestDatabase();

const SESSION_SECRET = "0123456789abcdef0123456789abcdef";
const WEBHOOK_SECRET = "a-shared-secret-with-the-provider";
const DEPOSIT = 2000;
const HOUR_MS = 60 * 60 * 1000;

/** The first task's deadline, and the two instants either side of its grace. */
const DEADLINE = taskDeadline(1);
/** The last instant a completion is accepted at. */
const RECEIVED_AT = new Date(DEADLINE.getTime() + RECEIPT_GRACE_SECONDS * 1000);
/** The first instant the sweep judges the same task overdue. */
const SWEEP_AT = new Date(RECEIVED_AT.getTime() + 1);
/** The last instant Emergency Recovery is accepted at, which is also when its capture is due. */
const OFFER_EXPIRES = new Date(SWEEP_AT.getTime() + RECOVERY_WINDOW_HOURS * HOUR_MS);

/** The window every hold in this file runs over. Its midpoint is past every instant here. */
const AUTHORIZED_AT = new Date(Date.UTC(2026, 0, 1));
const EXPIRES_AT = new Date(Date.UTC(2026, 0, 31));

const quietLogger = () => createLogger({ sink: () => {} });

function taskApp(db: Database, at: Date) {
  return createApp({
    logger: quietLogger(),
    sessionGate: createSessionGate({ db, sessionSecret: SESSION_SECRET }),
    rateLimiter: fakeRateLimiter(),
    handlers: createTaskHandlers({ db, now: () => at }),
  });
}

function challengeApp(db: Database, at: Date) {
  return createApp({
    logger: quietLogger(),
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

function observation(): MovementObservation {
  return {
    startedAt: "2026-01-05T15:50:00.000Z",
    endedAt: "2026-01-05T15:59:00.000Z",
    steps: 640,
    provenance: "live-foreground",
    source: "expo-pedometer-ios",
  };
}

function completionRequest(token: string, taskId: string, key: string): [string, RequestInit] {
  return [
    `http://api.test/tasks/${taskId}/completions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        [IDEMPOTENCY_HEADER]: key,
      },
      body: JSON.stringify({
        clientRecordId: key,
        completedAt: "2026-01-05T15:59:00.000Z",
        observation: observation(),
        appVersion: "1.0.0",
        verificationPolicyVersion: "steps-v1",
      }),
    },
  ];
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

/** A key that is a valid UUID and is unique per caller in a test. */
function key(index: number): string {
  return `c0c0c0c0-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** One account racing a completion against the sweep, from its own connection. */
interface Contender {
  readonly accountId: string;
  readonly token: string;
  readonly challengeId: string;
  readonly taskId: string;
  readonly connection: DatabaseHandle;
}

/** One funded challenge with a live hold, before the sweep has missed anything. */
interface Funded {
  readonly accountId: string;
  readonly token: string;
  readonly challengeId: string;
  readonly authorizationId: string;
  readonly connection: DatabaseHandle;
}

/** The same, once the sweep has missed a task and opened the recovery offer. */
interface Offer extends Funded {
  readonly taskId: string;
}

async function tasksOf(db: Database, challengeId: string) {
  return await db
    .select()
    .from(scheduledTasks)
    .where(eq(scheduledTasks.challengeId, challengeId))
    .orderBy(asc(scheduledTasks.sequence));
}

async function challengeRow(db: Database, challengeId: string) {
  const [row] = await db.select().from(challenges).where(eq(challenges.id, challengeId));
  if (row === undefined) throw new Error("the challenge disappeared");
  return row;
}

async function ledgerKinds(db: Database, challengeId: string): Promise<string[]> {
  const rows = await db
    .select({ kind: ledgerTransactions.kind })
    .from(ledgerTransactions)
    .where(eq(ledgerTransactions.challengeId, challengeId));
  return rows.map((row) => row.kind);
}

describe("a completion racing the sweep over the same task", () => {
  /**
   * Six accounts, each with a task whose grace ends at `RECEIVED_AT`. Every
   * completion is fired from its own connection at that instant while two sweep
   * invocations judge the same tasks overdue one millisecond later, so both
   * sides of every task are entitled to act and only the task's row lock
   * decides.
   */
  it("resolves each task exactly once, and tells the loser so", async () => {
    const test = testDatabase();
    const arrangements: Contender[] = [];
    for (let index = 0; index < 6; index += 1) {
      const { accountId, token } = await signIn(test.db);
      const challengeId = await insertChallengeForAccount(test.db, accountId, {
        depositMinorUnits: DEPOSIT,
      });
      const tasks = await tasksOf(test.db, challengeId);
      arrangements.push({
        accountId,
        token,
        challengeId,
        taskId: tasks[0]?.id ?? "",
        connection: test.connect(),
      });
    }
    const sweeps = [test.connect(), test.connect()];
    const complete = (arranged: Contender, index: number) =>
      taskApp(arranged.connection.db, RECEIVED_AT).request(
        ...completionRequest(arranged.token, arranged.taskId, key(index)),
      );

    // Half the completions are in flight before the sweeps start and half
    // after. Starting them all first would be a race only in name: the
    // completions would win every task, and the whole missed branch below would
    // be assertions nothing ever reaches.
    const early = arrangements.slice(0, 3).map(complete);
    const passes = sweeps.map(async (sweep) =>
      createSweep({ db: sweep.db, now: () => SWEEP_AT })(
        scheduledEvent() as ScheduledEvent,
        quietLogger(),
      ),
    );
    // The sweeps do their pause pass before they reach an overdue task, so a
    // completion fired at the same moment always wins. The head start is what
    // puts the other three tasks genuinely in contention; it shapes the race
    // rather than deciding it, and the assertions below still accept either
    // winner for every task.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const late = arrangements.slice(3).map((arranged, index) => complete(arranged, index + 3));
    const [responses, results] = await Promise.all([
      Promise.all([...early, ...late]),
      Promise.all(passes),
    ]);

    // Every task ended up resolved exactly once, on one side or the other.
    let acknowledged = 0;
    let missed = 0;
    for (const [index, arranged] of arrangements.entries()) {
      const response = responses[index];
      if (response === undefined) throw new Error("a completion produced no response");
      const [task] = await tasksOf(test.db, arranged.challengeId);
      const challenge = await challengeRow(test.db, arranged.challengeId);

      if (response.status === 200) {
        acknowledged += 1;
        expect(task).toMatchObject({ status: "completed", missedAt: null });
        expect(challenge.status).toBe("active");
      } else {
        missed += 1;
        // The loser is refused by name rather than being told the request was
        // malformed or that the task does not exist. Which of the two names it
        // gets is the race's to decide: the sweep's miss and the challenge's
        // move out of `active` commit together, so a completion that reads the
        // pair afterwards can be refused by either.
        expect(response.status).toBe(409);
        expect(["task_already_resolved", "challenge_not_active"]).toContain(
          (await body(response)).code,
        );
        expect(task).toMatchObject({ status: "missed", acknowledgedAt: null });
        // Funded, with the allowance unspent, so the miss opens a recovery.
        expect(challenge.status).toBe("recovery_pending");
      }
    }
    expect(acknowledged + missed).toBe(arrangements.length);
    // The two sweeps between them missed exactly the tasks no completion took,
    // and neither waited on the other: disjoint work, not duplicated work.
    expect(results.reduce((sum, result) => sum + result.tasksMissed, 0)).toBe(missed);

    await assertInvariantsHold(test.db);
  });
});

describe("Emergency Recovery racing the settlement that closes its window", () => {
  /**
   * Four accounts in `recovery_pending`, produced by the real sweep, each with
   * the capture command it created. Recovery is accepted up to and including
   * `OFFER_EXPIRES` and the capture is due from that same instant, so both
   * commands are entitled to act on every one of them.
   *
   * The forbidden outcome is the one this test exists for: a forgiven task on
   * an account whose deposit was also taken.
   */
  it("either forgives the miss or takes the money, never both", async () => {
    const test = testDatabase();
    const provider = new FakePaymentProvider({
      webhookSecret: WEBHOOK_SECRET,
      now: () => AUTHORIZED_AT,
    });
    const arrangements: Funded[] = [];
    for (let index = 0; index < 4; index += 1) {
      arrangements.push({
        ...(await arrangeFundedChallenge(test.db, provider)),
        connection: test.connect(),
      });
    }

    // The miss, the offer, and the capture command are all the sweep's output.
    const sweepConnection = test.connect();
    await createSweep({ db: sweepConnection.db, provider, now: () => SWEEP_AT })(
      scheduledEvent() as ScheduledEvent,
      quietLogger(),
    );

    const offers: Offer[] = [];
    for (const arranged of arrangements) {
      const tasks = await tasksOf(test.db, arranged.challengeId);
      const missed = tasks.find((task) => task.status === "missed");
      expect(missed).toBeDefined();
      expect((await challengeRow(test.db, arranged.challengeId)).status).toBe("recovery_pending");
      offers.push({ ...arranged, taskId: missed?.id ?? "" });
    }

    const settlementConnection = test.connect();
    const recover = (offer: Offer, index: number) =>
      challengeApp(offer.connection.db, OFFER_EXPIRES).request(
        ...recoveryRequest(offer.token, offer.challengeId, offer.taskId, key(100 + index)),
      );
    // Two recoveries in flight before the settlement pass and two behind it, so
    // both sides of the race are reached rather than whichever one this
    // machine happens to favour.
    const early = offers.slice(0, 2).map(recover);
    const settling = runSettlementPass({
      db: settlementConnection.db,
      provider,
      now: OFFER_EXPIRES,
      batchSize: 20,
      logger: quietLogger(),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const late = offers.slice(2).map((offer, index) => recover(offer, index + 2));
    const [responses] = await Promise.all([Promise.all([...early, ...late]), settling]);

    let forgiven = 0;
    let collected = 0;
    for (const [index, offer] of offers.entries()) {
      const response = responses[index];
      if (response === undefined) throw new Error("a recovery produced no response");
      const challenge = await challengeRow(test.db, offer.challengeId);
      const kinds = await ledgerKinds(test.db, offer.challengeId);
      const [capture] = await captureOf(test.db, offer.challengeId);

      if (response.status === 200) {
        forgiven += 1;
        expect(challenge.status).toBe("active");
        // The deposit was not taken: the only movement is the one that opened
        // the hold, and the capture the sweep created was cancelled.
        expect(kinds).toEqual(["deposit_authorized"]);
        expect(capture?.status).toBe("cancelled");
        expect(await provider.getTransactionStatus(offer.authorizationId)).toMatchObject({
          state: "authorized",
        });
      } else {
        collected += 1;
        expect(response.status).toBe(409);
        // Two refusals are reachable and both are true, which is a property of
        // the race rather than of the command: a recovery that reached the
        // challenge after the settlement failed it is refused by the status
        // (`recovery_not_offered`), and one that got there first but found the
        // capture already settled is refused by the window. Naming one of them
        // here would be asserting which side of a race got there first.
        expect(["recovery_window_closed", "recovery_not_offered"]).toContain(
          (await body(response)).code,
        );
        expect(challenge.status).toBe("failed");
        expect(kinds).toContain("forfeit_captured");
        expect(capture?.status).toBe("confirmed");
      }

      // Whichever side won, the account's forgiven tasks and its captured
      // deposit are mutually exclusive.
      const tasks = await tasksOf(test.db, offer.challengeId);
      const wasForgiven = tasks.some((task) => task.status === "forgiven");
      expect(wasForgiven).toBe(!kinds.includes("forfeit_captured"));
    }
    expect(forgiven + collected).toBe(offers.length);

    await assertInvariantsHold(test.db);
  });
});

describe("one idempotency key fired by many callers at once", () => {
  it("performs the command once and answers every caller", async () => {
    const test = testDatabase();
    const { accountId, token } = await signIn(test.db);
    const challengeId = await insertChallengeForAccount(test.db, accountId, {
      depositMinorUnits: DEPOSIT,
    });
    const [task] = await tasksOf(test.db, challengeId);
    const callers = Array.from({ length: 8 }, () => test.connect());
    const shared = key(200);

    const responses = await Promise.all(
      callers.map(async (caller) =>
        taskApp(caller.db, RECEIVED_AT).request(
          ...completionRequest(token, task?.id ?? "", shared),
        ),
      ),
    );

    // Exactly one completion was recorded, whatever each caller was told.
    const recorded = await test.db
      .select()
      .from(taskCompletions)
      .where(eq(taskCompletions.taskId, task?.id ?? ""));
    expect(recorded).toHaveLength(1);
    expect((await tasksOf(test.db, challengeId))[0]).toMatchObject({ status: "completed" });

    const bodies = await Promise.all(responses.map(async (response) => await body(response)));
    let performed = 0;
    for (const [index, response] of responses.entries()) {
      const answered = bodies[index];
      if (answered === undefined) throw new Error("a caller got no body");
      if (response.status === 200) {
        // Every acknowledgment describes the same completion; only the first
        // one is not a replay.
        expect(answered).toMatchObject({ task: { id: task?.id, status: "completed" } });
        if (answered.replayed === false) performed += 1;
      } else {
        // A caller that arrived while the key was still held is told to retry
        // rather than being served a second execution.
        expect(response.status).toBe(409);
        expect(answered).toMatchObject({ code: "idempotency_in_progress" });
      }
    }
    expect(performed).toBe(1);

    await assertInvariantsHold(test.db);
  });
});

/** The capture command the sweep created for a challenge, if any. */
async function captureOf(db: Database, challengeId: string) {
  return await db
    .select()
    .from(paymentCommands)
    .where(and(eq(paymentCommands.challengeId, challengeId), eq(paymentCommands.kind, "capture")));
}

/**
 * A funded challenge with a live hold from the fake provider and the
 * `deposit_authorized` movement the webhook would have written for it, which is
 * what a settlement has to act on rather than invent.
 */
async function arrangeFundedChallenge(
  db: Database,
  provider: FakePaymentProvider,
): Promise<{
  accountId: string;
  token: string;
  challengeId: string;
  authorizationId: string;
}> {
  const { accountId, token } = await signIn(db);
  const challengeId = await insertChallengeForAccount(db, accountId, {
    depositMinorUnits: DEPOSIT,
  });

  const authorization = await provider.authorizeDeposit({
    reference: challengeId,
    customerReference: accountId,
    amount: { amountMinorUnits: DEPOSIT, currency: "USD" },
  });
  provider.deliver(authorization.authorizationId, "succeeded");
  const instrument = await provider.getPaymentInstrument(authorization.authorizationId);

  await db.insert(challengeAuthorizations).values({
    challengeId,
    provider: provider.name,
    providerAuthorizationId: authorization.authorizationId,
    providerPaymentMethodId: instrument.paymentMethodId,
    amountMinorUnits: DEPOSIT,
    currency: "USD",
    status: "live",
    authorizedAt: AUTHORIZED_AT,
    expiresAt: EXPIRES_AT,
  });

  await db.transaction(async (tx) => {
    const [movement] = await tx
      .insert(ledgerTransactions)
      .values({
        challengeId,
        accountId,
        kind: "deposit_authorized",
        occurredAt: AUTHORIZED_AT,
        providerReference: authorization.authorizationId,
      })
      .returning({ id: ledgerTransactions.id });
    if (movement === undefined) throw new Error("the fixture wrote no ledger transaction");
    await tx.insert(ledgerEntries).values([
      { transactionId: movement.id, ledgerAccount: "user_commitment", amountMinorUnits: DEPOSIT },
      {
        transactionId: movement.id,
        ledgerAccount: "payment_processor",
        amountMinorUnits: -DEPOSIT,
      },
    ]);
  });

  return { accountId, token, challengeId, authorizationId: authorization.authorizationId };
}
