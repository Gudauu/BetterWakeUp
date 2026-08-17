/**
 * Issue 25 against real rows: the settlement commands the sweep created, and
 * what executing them does to the provider and to the ledger.
 *
 * Every hold in this suite is a real one taken from the fake provider and
 * confirmed by it, because the pass calls the provider for each release and each
 * capture; a row naming an authorization the provider never issued would
 * exercise the failure path instead of the one the test is named after.
 *
 * The windows are chosen so settlement and renewal never collide. The challenge
 * fixture places its first deadline on 2026-01-05, so every hold here runs from
 * 2026-01-01 to 2026-01-31 and its midpoint, 2026-01-16, is later than every
 * instant this file settles at. That is what lets a test run the whole sweep and
 * still be about settlement.
 *
 * The ledger assertions are the point of most of them. A forfeit is only
 * correct if the entries balance, and a success is only free if no
 * `platform_revenue` or `processor_fees` entry exists anywhere on its path.
 */

import { IDEMPOTENCY_HEADER, type MovementObservation } from "@betterwakeup/contract";
import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createSessionGate } from "../../src/auth/session-gate.ts";
import { hashSessionToken, mintSessionToken } from "../../src/auth/session-token.ts";
import type { Database } from "../../src/db/index.ts";
import { challengeAuthorizations } from "../../src/db/schema/authorizations.ts";
import {
  accounts,
  challenges,
  ledgerEntries,
  ledgerTransactions,
  paymentCommands,
  scheduledTasks,
  sessions,
} from "../../src/db/schema.ts";
import { createApp } from "../../src/http/app.ts";
import type { ScheduledEvent } from "../../src/lambda/events.ts";
import { createLogger } from "../../src/observability/logger.ts";
import { FakePaymentProvider } from "../../src/payments/fake-provider.ts";
import { MAX_COLLECTION_ATTEMPTS, runSettlementPass } from "../../src/payments/settlement.ts";
import { createSweep } from "../../src/sweep/run-sweep.ts";
import { createTaskHandlers } from "../../src/tasks/handlers.ts";
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
const WEBHOOK_SECRET = "a-shared-secret-with-the-provider";
const DEPOSIT = 2000;

/** When every hold in this suite was taken, and when it lapses. */
const AUTHORIZED_AT = new Date("2026-01-01T00:00:00Z");
const EXPIRES_AT = new Date("2026-01-31T00:00:00Z");
/** The deadline of the fixtures' first task: 08:00 in Los Angeles on 5 January. */
const DEADLINE = taskDeadline(1);
/** Inside the receipt grace of that deadline. */
const RECEIVED_AT = new Date(DEADLINE.getTime() + 30_000);
/** Well past the deadline and its grace, so the sweep judges the task overdue. */
const OVERDUE_AT = new Date(DEADLINE.getTime() + 4 * 60 * 60 * 1000);

const KEY = { first: "5e771e00-0000-4000-8000-000000000001" };

function harness() {
  const lines: Record<string, unknown>[] = [];
  const provider = new FakePaymentProvider({
    webhookSecret: WEBHOOK_SECRET,
    now: () => AUTHORIZED_AT,
  });
  const logger = createLogger({
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { provider, logger, lines };
}

type Harness = ReturnType<typeof harness>;

interface Arranged {
  readonly accountId: string;
  readonly token: string;
  readonly challengeId: string;
  readonly authorizationId: string;
  readonly paymentMethodId: string;
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

/**
 * A funded challenge with a live hold, and the `deposit_authorized` movement the
 * webhook would have written for it.
 *
 * The ledger row is part of the fixture rather than an afterthought: every
 * settlement here is asserted as the second half of a pair, and a suite that
 * omitted the first half could show a forfeit balancing while the account it
 * discharges was never opened.
 */
async function arrange(
  db: Database,
  { provider }: Harness,
  overrides: {
    status?: "active" | "recovery_pending" | "failed" | "succeeded";
    requiredTaskCount?: number;
    depositMinorUnits?: number;
    recoveryConsumed?: boolean;
    hold?: "live" | "none";
  } = {},
): Promise<Arranged> {
  const depositMinorUnits = overrides.depositMinorUnits ?? DEPOSIT;
  const { accountId, token } = await signIn(db);
  if (overrides.recoveryConsumed === true) {
    await db
      .update(accounts)
      .set({ emergencyRecoveryConsumedAt: AUTHORIZED_AT })
      .where(eq(accounts.id, accountId));
  }
  const challengeId = await insertChallengeForAccount(db, accountId, {
    depositMinorUnits,
    ...(overrides.status === undefined ? {} : { status: overrides.status }),
    ...(overrides.requiredTaskCount === undefined
      ? {}
      : { requiredTaskCount: overrides.requiredTaskCount }),
  });

  if (depositMinorUnits === 0) {
    return { accountId, token, challengeId, authorizationId: "", paymentMethodId: "" };
  }

  const authorization = await provider.authorizeDeposit({
    reference: challengeId,
    customerReference: accountId,
    amount: { amountMinorUnits: depositMinorUnits, currency: "USD" },
  });
  provider.deliver(authorization.authorizationId, "succeeded");
  const instrument = await provider.getPaymentInstrument(authorization.authorizationId);

  await db.insert(challengeAuthorizations).values({
    challengeId,
    provider: provider.name,
    providerAuthorizationId: authorization.authorizationId,
    providerPaymentMethodId: instrument.paymentMethodId,
    amountMinorUnits: depositMinorUnits,
    currency: "USD",
    ...(overrides.hold === "none"
      ? { status: "released" as const, endedAt: AUTHORIZED_AT }
      : { status: "live" as const }),
    authorizedAt: AUTHORIZED_AT,
    expiresAt: EXPIRES_AT,
  });

  // One transaction, because the balance rule is a deferred constraint trigger:
  // a ledger transaction committed without its entries is itself a violation.
  await db.transaction(async (tx) => {
    const [transaction] = await tx
      .insert(ledgerTransactions)
      .values({
        challengeId,
        accountId,
        kind: "deposit_authorized",
        occurredAt: AUTHORIZED_AT,
        providerReference: authorization.authorizationId,
      })
      .returning({ id: ledgerTransactions.id });
    if (transaction === undefined) throw new Error("the fixture wrote no ledger transaction");
    await tx.insert(ledgerEntries).values([
      {
        transactionId: transaction.id,
        ledgerAccount: "user_commitment",
        amountMinorUnits: depositMinorUnits,
      },
      {
        transactionId: transaction.id,
        ledgerAccount: "payment_processor",
        amountMinorUnits: -depositMinorUnits,
      },
    ]);
  });

  return {
    accountId,
    token,
    challengeId,
    authorizationId: authorization.authorizationId,
    paymentMethodId: instrument.paymentMethodId,
  };
}

async function createCommand(
  db: Database,
  challengeId: string,
  kind: "capture" | "release_authorization",
  executeAfter: Date,
): Promise<string> {
  const [row] = await db
    .insert(paymentCommands)
    .values({ challengeId, kind, dedupeKey: `${kind}:${challengeId}`, executeAfter })
    .returning({ id: paymentCommands.id });
  if (row === undefined) throw new Error("the fixture created no payment command");
  return row.id;
}

async function settleAt(db: Database, app: Harness, at: Date, batchSize = 10) {
  return await runSettlementPass({
    db,
    provider: app.provider,
    now: at,
    batchSize,
    logger: app.logger,
  });
}

async function commandRow(db: Database, challengeId: string, kind: string) {
  const [row] = await db
    .select()
    .from(paymentCommands)
    .where(
      and(
        eq(paymentCommands.challengeId, challengeId),
        eq(paymentCommands.kind, kind as "capture"),
      ),
    );
  return row;
}

async function challengeRow(db: Database, challengeId: string) {
  const [row] = await db.select().from(challenges).where(eq(challenges.id, challengeId));
  return row;
}

/** Every ledger movement against a challenge, with the entries under each. */
async function ledger(db: Database, challengeId: string) {
  const rows = await db
    .select({
      kind: ledgerTransactions.kind,
      providerReference: ledgerTransactions.providerReference,
      ledgerAccount: ledgerEntries.ledgerAccount,
      amountMinorUnits: ledgerEntries.amountMinorUnits,
      transactionId: ledgerTransactions.id,
    })
    .from(ledgerTransactions)
    .innerJoin(ledgerEntries, eq(ledgerEntries.transactionId, ledgerTransactions.id))
    .where(eq(ledgerTransactions.challengeId, challengeId))
    .orderBy(asc(ledgerTransactions.occurredAt));
  return rows;
}

/** The running sum of one ledger account over a challenge. */
function balanceOf(rows: Awaited<ReturnType<typeof ledger>>, ledgerAccount: string): number {
  return rows
    .filter((row) => row.ledgerAccount === ledgerAccount)
    .reduce((sum, row) => sum + row.amountMinorUnits, 0);
}

/** Whether every transaction in the set balances to zero on its own. */
function everyTransactionBalances(rows: Awaited<ReturnType<typeof ledger>>): boolean {
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.transactionId, (totals.get(row.transactionId) ?? 0) + row.amountMinorUnits);
  }
  return [...totals.values()].every((total) => total === 0);
}

describe("issue 25's acceptance boundary", () => {
  it("costs a successful challenge nothing at all: the hold is released and no money moves", async () => {
    const { db } = testDatabase();
    const app = harness();
    const arranged = await arrange(db, app, { requiredTaskCount: 1 });

    // The success comes from the real completion command, so the release
    // command under test is the one the product creates rather than one the
    // fixture invented.
    const [task] = await db
      .select({ id: scheduledTasks.id })
      .from(scheduledTasks)
      .where(eq(scheduledTasks.challengeId, arranged.challengeId));
    const server = createApp({
      logger: createLogger({ sink: () => {} }),
      sessionGate: createSessionGate({ db, sessionSecret: SESSION_SECRET }),
      rateLimiter: fakeRateLimiter(),
      handlers: createTaskHandlers({ db, now: () => RECEIVED_AT }),
    });
    const response = await server.request(
      `http://api.test/tasks/${task?.id}/completions`,
      completionRequest(arranged.token, KEY.first),
    );
    expect(response.status).toBe(200);
    expect((await challengeRow(db, arranged.challengeId))?.status).toBe("succeeded");

    const result = await settleAt(db, app, RECEIVED_AT);
    expect(result.authorizationsReleased).toBe(1);
    expect(result.forfeitsCollected).toBe(0);

    // Nothing was captured at the provider, which is where a processing fee
    // would have attached.
    expect(await app.provider.getTransactionStatus(arranged.authorizationId)).toMatchObject({
      state: "released",
    });
    const rows = await ledger(db, arranged.challengeId);
    expect(rows.map((row) => row.kind)).toEqual([
      "deposit_authorized",
      "deposit_authorized",
      "authorization_released",
      "authorization_released",
    ]);
    expect(everyTransactionBalances(rows)).toBe(true);
    // Every account is back where it started, and neither revenue nor fees were
    // ever touched.
    expect(balanceOf(rows, "user_commitment")).toBe(0);
    expect(balanceOf(rows, "payment_processor")).toBe(0);
    expect(balanceOf(rows, "platform_revenue")).toBe(0);
    expect(balanceOf(rows, "processor_fees")).toBe(0);
    expect((await commandRow(db, arranged.challengeId, "release_authorization"))?.status).toBe(
      "confirmed",
    );
  });

  it("balances the ledger on a forfeit, with the deposit becoming revenue in full", async () => {
    const { db } = testDatabase();
    const app = harness();
    const arranged = await arrange(db, app, { status: "failed" });
    await createCommand(db, arranged.challengeId, "capture", OVERDUE_AT);

    const result = await settleAt(db, app, OVERDUE_AT);
    expect(result.forfeitsCollected).toBe(1);

    const rows = await ledger(db, arranged.challengeId);
    expect(everyTransactionBalances(rows)).toBe(true);
    expect(rows.some((row) => row.kind === "forfeit_captured")).toBe(true);
    expect(balanceOf(rows, "user_commitment")).toBe(0);
    expect(balanceOf(rows, "platform_revenue")).toBe(DEPOSIT);

    expect(await app.provider.getTransactionStatus(arranged.authorizationId)).toMatchObject({
      state: "captured",
    });
    const [hold] = await db
      .select()
      .from(challengeAuthorizations)
      .where(eq(challengeAuthorizations.challengeId, arranged.challengeId));
    expect(hold?.status).toBe("captured");
    expect(hold?.endedAt?.toISOString()).toBe(OVERDUE_AT.toISOString());
  });

  it("records an uncollectable forfeit as uncollected rather than losing it", async () => {
    const { db } = testDatabase();
    const app = harness();
    // No live hold, and the saved card declines: the only two ways to collect
    // are both closed.
    const arranged = await arrange(db, app, { status: "failed", hold: "none" });
    app.provider.declineInstrument(arranged.paymentMethodId);
    await createCommand(db, arranged.challengeId, "capture", OVERDUE_AT);

    for (let attempt = 1; attempt < MAX_COLLECTION_ATTEMPTS; attempt += 1) {
      const result = await settleAt(db, app, OVERDUE_AT);
      expect(result.collectionsRetrying).toBe(1);
      const command = await commandRow(db, arranged.challengeId, "capture");
      expect(command?.status).toBe("pending");
      expect(command?.attempts).toBe(attempt);
    }

    const final = await settleAt(db, app, OVERDUE_AT);
    expect(final.forfeitsUncollected).toBe(1);

    const command = await commandRow(db, arranged.challengeId, "capture");
    expect(command?.status).toBe("failed");
    expect(command?.settledAt).not.toBeNull();

    const rows = await ledger(db, arranged.challengeId);
    expect(everyTransactionBalances(rows)).toBe(true);
    expect(balanceOf(rows, "uncollected_forfeit")).toBe(DEPOSIT);
    expect(balanceOf(rows, "platform_revenue")).toBe(0);
    expect(balanceOf(rows, "user_commitment")).toBe(0);

    // The terminal state alarms: nothing downstream retries this, so the line
    // is an error rather than a warning.
    expect(
      app.lines.filter((line) => line.level === "error" && line.result === "uncollected"),
    ).toHaveLength(1);
  });
});

describe("what a settlement acts on", () => {
  it("charges the saved card off-session when the hold is no longer live", async () => {
    const { db } = testDatabase();
    const app = harness();
    const arranged = await arrange(db, app, { status: "failed", hold: "none" });
    await createCommand(db, arranged.challengeId, "capture", OVERDUE_AT);

    expect((await settleAt(db, app, OVERDUE_AT)).forfeitsCollected).toBe(1);

    const rows = await ledger(db, arranged.challengeId);
    expect(rows.some((row) => row.kind === "forfeit_charged")).toBe(true);
    expect(balanceOf(rows, "platform_revenue")).toBe(DEPOSIT);
    // The lapsed hold was never captured: it expires at the provider having
    // charged nothing, and the money came from the stored agreement instead.
    expect(await app.provider.getTransactionStatus(arranged.authorizationId)).toMatchObject({
      state: "authorized",
    });
  });

  it("cancels a release whose challenge has no live hold, charging nothing", async () => {
    const { db } = testDatabase();
    const app = harness();
    const arranged = await arrange(db, app, { status: "succeeded", hold: "none" });
    await createCommand(db, arranged.challengeId, "release_authorization", RECEIVED_AT);

    const result = await settleAt(db, app, RECEIVED_AT);
    expect(result.settlementsCancelled).toBe(1);
    expect(result.authorizationsReleased).toBe(0);

    const command = await commandRow(db, arranged.challengeId, "release_authorization");
    expect(command?.status).toBe("cancelled");
    expect(command?.attempts).toBe(0);
    const rows = await ledger(db, arranged.challengeId);
    expect(rows.every((row) => row.kind === "deposit_authorized")).toBe(true);
  });

  it("cancels a capture whose challenge is no longer failing", async () => {
    const { db } = testDatabase();
    const app = harness();
    // Emergency Recovery cancels the command itself, so this is the residual
    // case: a capture row that outlived the failure it was created for.
    const arranged = await arrange(db, app, { status: "active" });
    await createCommand(db, arranged.challengeId, "capture", OVERDUE_AT);

    expect((await settleAt(db, app, OVERDUE_AT)).settlementsCancelled).toBe(1);
    expect((await commandRow(db, arranged.challengeId, "capture"))?.status).toBe("cancelled");
    expect(await app.provider.getTransactionStatus(arranged.authorizationId)).toMatchObject({
      state: "authorized",
    });
  });

  it("leaves a command whose execute_after has not passed alone", async () => {
    const { db } = testDatabase();
    const app = harness();
    const arranged = await arrange(db, app, { status: "recovery_pending" });
    const dueLater = new Date(OVERDUE_AT.getTime() + 24 * 60 * 60 * 1000);
    await createCommand(db, arranged.challengeId, "capture", dueLater);

    // One millisecond before the window closes, which is the instant Emergency
    // Recovery is still allowed to act at.
    const result = await settleAt(db, app, new Date(dueLater.getTime() - 1));
    expect(result.forfeitsCollected).toBe(0);
    expect((await commandRow(db, arranged.challengeId, "capture"))?.status).toBe("pending");
    expect((await challengeRow(db, arranged.challengeId))?.status).toBe("recovery_pending");
  });

  it("never executes a command Emergency Recovery cancelled", async () => {
    const { db } = testDatabase();
    const app = harness();
    const arranged = await arrange(db, app, { status: "active" });
    const commandId = await createCommand(db, arranged.challengeId, "capture", OVERDUE_AT);
    await db
      .update(paymentCommands)
      .set({ status: "cancelled", settledAt: OVERDUE_AT })
      .where(eq(paymentCommands.id, commandId));

    const result = await settleAt(db, app, OVERDUE_AT);
    expect(result).toMatchObject({ forfeitsCollected: 0, settlementsCancelled: 0 });
    expect(await app.provider.getTransactionStatus(arranged.authorizationId)).toMatchObject({
      state: "authorized",
    });
  });
});

describe("the recovery window, closed by the settlement that ends it", () => {
  it("fails a recovery_pending challenge when its capture executes", async () => {
    const { db } = testDatabase();
    const app = harness();
    const arranged = await arrange(db, app, { status: "recovery_pending" });
    await createCommand(db, arranged.challengeId, "capture", OVERDUE_AT);

    expect((await settleAt(db, app, OVERDUE_AT)).forfeitsCollected).toBe(1);

    const challenge = await challengeRow(db, arranged.challengeId);
    expect(challenge?.status).toBe("failed");
    expect(challenge?.terminalAt?.toISOString()).toBe(OVERDUE_AT.toISOString());
  });
});

describe("executing twice", () => {
  it("settles once however many times the pass runs", async () => {
    const { db } = testDatabase();
    const app = harness();
    const arranged = await arrange(db, app, { status: "failed" });
    await createCommand(db, arranged.challengeId, "capture", OVERDUE_AT);

    const first = await settleAt(db, app, OVERDUE_AT);
    const second = await settleAt(db, app, OVERDUE_AT);
    expect(first.forfeitsCollected).toBe(1);
    expect(second).toMatchObject({ forfeitsCollected: 0, moreWorkPending: false });

    const rows = await ledger(db, arranged.challengeId);
    expect(rows.filter((row) => row.kind === "forfeit_captured")).toHaveLength(2);
    expect(balanceOf(rows, "platform_revenue")).toBe(DEPOSIT);
  });

  it("records a capture the provider already performed rather than charging twice", async () => {
    const { db } = testDatabase();
    const app = harness();
    const arranged = await arrange(db, app, { status: "failed" });
    await createCommand(db, arranged.challengeId, "capture", OVERDUE_AT);

    // The previous attempt captured and crashed before its commit: the money
    // moved and the command is still pending.
    await app.provider.captureAuthorization(arranged.authorizationId, {
      amountMinorUnits: DEPOSIT,
      currency: "USD",
    });

    expect((await settleAt(db, app, OVERDUE_AT)).forfeitsCollected).toBe(1);
    const rows = await ledger(db, arranged.challengeId);
    expect(rows.filter((row) => row.kind === "forfeit_captured")).toHaveLength(2);
    expect(balanceOf(rows, "platform_revenue")).toBe(DEPOSIT);
    expect((await commandRow(db, arranged.challengeId, "capture"))?.status).toBe("confirmed");
  });
});

describe("the sweep's own pass", () => {
  it("fails a challenge and collects its forfeit in one invocation", async () => {
    const { db } = testDatabase();
    const app = harness();
    // The account has already spent its Emergency Recovery, so the miss fails
    // the challenge outright and the capture it creates is due immediately.
    const arranged = await arrange(db, app, { recoveryConsumed: true });

    const sweep = createSweep({
      db: db,
      provider: app.provider,
      now: () => OVERDUE_AT,
    });
    const result = await sweep(scheduledEvent() as ScheduledEvent, app.logger);

    expect(result).toMatchObject({
      tasksMissed: 1,
      challengesFailed: 1,
      settlementsCreated: 1,
      forfeitsCollected: 1,
    });
    expect((await commandRow(db, arranged.challengeId, "capture"))?.status).toBe("confirmed");
    expect(balanceOf(await ledger(db, arranged.challengeId), "platform_revenue")).toBe(DEPOSIT);
    // Renewal is not due until the middle of the hold's window, so the pass
    // that captured it did not also renew it.
    expect(result.authorizationsRenewed).toBe(0);
  });

  it("leaves a challenge that entered recovery uncaptured for the length of its window", async () => {
    const { db } = testDatabase();
    const app = harness();
    const arranged = await arrange(db, app);

    const sweep = createSweep({ db, provider: app.provider, now: () => OVERDUE_AT });
    const result = await sweep(scheduledEvent() as ScheduledEvent, app.logger);

    expect(result).toMatchObject({
      challengesInRecovery: 1,
      settlementsCreated: 1,
      forfeitsCollected: 0,
    });
    expect((await commandRow(db, arranged.challengeId, "capture"))?.status).toBe("pending");
    expect(await app.provider.getTransactionStatus(arranged.authorizationId)).toMatchObject({
      state: "authorized",
    });
  });

  it("executes nothing when no provider is configured", async () => {
    const { db } = testDatabase();
    const app = harness();
    const arranged = await arrange(db, app, { status: "failed" });
    await createCommand(db, arranged.challengeId, "capture", OVERDUE_AT);

    const sweep = createSweep({ db, now: () => OVERDUE_AT });
    const result = await sweep(scheduledEvent() as ScheduledEvent, app.logger);

    expect(result.forfeitsCollected).toBe(0);
    expect((await commandRow(db, arranged.challengeId, "capture"))?.status).toBe("pending");
  });
});

describe("concurrency", () => {
  it("passes over a command another writer holds rather than waiting for it", async () => {
    const { db } = testDatabase();
    const app = harness();
    const arranged = await arrange(db, app, { status: "failed" });
    const commandId = await createCommand(db, arranged.challengeId, "capture", OVERDUE_AT);

    // The two sides hand off through promises rather than through sleeps, and
    // the holding transaction is awaited rather than signalled from inside, so
    // the lock is provably gone before anything is asserted.
    const other = testDatabase().connect();
    let held: () => void = () => {};
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    let release: () => void = () => {};
    const releasing = new Promise<void>((resolve) => {
      release = resolve;
    });

    const holder = other.db.transaction(async (tx) => {
      await tx
        .select()
        .from(paymentCommands)
        .where(eq(paymentCommands.id, commandId))
        .for("update");
      held();
      await releasing;
    });

    await holding;
    const result = await settleAt(db, app, OVERDUE_AT);
    release();
    await holder;

    expect(result).toMatchObject({ forfeitsCollected: 0, moreWorkPending: false });
    expect((await commandRow(db, arranged.challengeId, "capture"))?.status).toBe("pending");
    expect(await app.provider.getTransactionStatus(arranged.authorizationId)).toMatchObject({
      state: "authorized",
    });
  });

  it("does not charge a card off-session because the live hold was locked", async () => {
    const { db } = testDatabase();
    const app = harness();
    const arranged = await arrange(db, app, { status: "failed" });
    await createCommand(db, arranged.challengeId, "capture", OVERDUE_AT);

    // The renewal pass holds this challenge's authorization. A hold somebody
    // else is holding is a hold that exists, and reading it as absent would
    // charge the saved card while a capturable authorization sat there.
    const other = testDatabase().connect();
    let held: () => void = () => {};
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    let release: () => void = () => {};
    const releasing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = other.db.transaction(async (tx) => {
      await tx
        .select()
        .from(challengeAuthorizations)
        .where(eq(challengeAuthorizations.challengeId, arranged.challengeId))
        .for("update");
      held();
      await releasing;
    });

    await holding;
    const result = await settleAt(db, app, OVERDUE_AT);
    release();
    await holder;

    expect(result).toMatchObject({ forfeitsCollected: 0, settlementsCancelled: 0 });
    expect((await commandRow(db, arranged.challengeId, "capture"))?.status).toBe("pending");
    expect(await ledger(db, arranged.challengeId)).toHaveLength(2);
    expect(await app.provider.getTransactionStatus(arranged.authorizationId)).toMatchObject({
      state: "authorized",
    });

    // And the next invocation, with the lock gone, collects what was left.
    expect((await settleAt(db, app, OVERDUE_AT)).forfeitsCollected).toBe(1);
  });

  /**
   * The rows a settlement reaches through its own writes, rather than through a
   * lock it asks for by name: it fails the challenge and it names both the
   * challenge and the account in a ledger movement, which takes a lock on each
   * through the foreign keys.
   *
   * Waiting for either is what put this pass on one side of a deadlock with
   * Emergency Recovery, which takes them in the opposite order. So both are
   * claimed without waiting before the provider is called, and a settlement
   * that cannot have them takes nothing at all.
   */
  it.each([
    { name: "challenge", table: challenges, column: challenges.id },
    { name: "account", table: accounts, column: accounts.id },
  ])("passes over a command whose $name another writer holds", async ({ table, column }) => {
    const { db } = testDatabase();
    const app = harness();
    const arranged = await arrange(db, app, { status: "failed" });
    await createCommand(db, arranged.challengeId, "capture", OVERDUE_AT);
    const rowId = table === accounts ? arranged.accountId : arranged.challengeId;

    const other = testDatabase().connect();
    let held: () => void = () => {};
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    let release: () => void = () => {};
    const releasing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = other.db.transaction(async (tx) => {
      await tx.select().from(table).where(eq(column, rowId)).for("update");
      held();
      await releasing;
    });

    await holding;
    const result = await settleAt(db, app, OVERDUE_AT);
    release();
    await holder;

    expect(result).toMatchObject({ forfeitsCollected: 0, settlementsCancelled: 0 });
    expect((await commandRow(db, arranged.challengeId, "capture"))?.status).toBe("pending");
    // Nothing was charged while the other writer held the row, and nothing was
    // written: the deposit movement is still the only one.
    expect(await app.provider.getTransactionStatus(arranged.authorizationId)).toMatchObject({
      state: "authorized",
    });
    expect(await ledger(db, arranged.challengeId)).toHaveLength(2);

    expect((await settleAt(db, app, OVERDUE_AT)).forfeitsCollected).toBe(1);
  });
});

function observation(): MovementObservation {
  return {
    startedAt: "2026-01-05T15:50:00.000Z",
    endedAt: "2026-01-05T15:59:00.000Z",
    steps: 640,
    provenance: "live-foreground",
    source: "expo-pedometer-ios",
  };
}

function completionRequest(token: string, key: string): RequestInit {
  return {
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
  };
}
