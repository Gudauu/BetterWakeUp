/**
 * Ending a challenge early, against real rows and through the mounted route.
 *
 * Every funded challenge here holds a real hold taken from the fake provider,
 * because the point of most of these is that ending settles exactly the way a
 * failure does, and that is only shown by running the settlement pass that
 * collects it. A hold the provider never issued would exercise the uncollected
 * path instead.
 *
 * The fixtures place three tasks on 2026-01-05, -06, and -07, each with an
 * 08:00 deadline in `America/Los_Angeles` (16:00 UTC). Holds run from
 * 2026-01-01 to 2026-01-31, so renewal is not due at any instant a test settles
 * at unless the test gives the hold a shorter life on purpose.
 */

import { IDEMPOTENCY_HEADER, RECEIPT_GRACE_SECONDS } from "@betterwakeup/contract";
import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createSessionGate } from "../../src/auth/session-gate.ts";
import { hashSessionToken, mintSessionToken } from "../../src/auth/session-token.ts";
import { acceptRecovery } from "../../src/challenges/accept-recovery.ts";
import { createChallengeHandlers } from "../../src/challenges/handlers.ts";
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
import { runRenewalPass } from "../../src/payments/renewal.ts";
import { runSettlementPass } from "../../src/payments/settlement.ts";
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
const WEBHOOK_SECRET = "a-shared-secret-with-the-provider";
const DEPOSIT = 2000;
const HOUR_MS = 60 * 60 * 1000;

const AUTHORIZED_AT = new Date("2026-01-01T00:00:00Z");
const EXPIRES_AT = new Date("2026-01-31T00:00:00Z");
/** After the fixtures activate and before any deadline, so nothing is overdue. */
const ENDED_AT = new Date("2026-01-05T00:00:00Z");
/** Just past the first task's receipt grace, when the sweep misses it. */
const MISSED_AT = new Date(taskDeadline(1).getTime() + RECEIPT_GRACE_SECONDS * 1000 + 1);

const KEY = {
  first: "ab0d0000-0000-4000-8000-000000000001",
  second: "ab0d0000-0000-4000-8000-000000000002",
};

const quiet = createLogger({ sink: () => {} });

function provider(): FakePaymentProvider {
  return new FakePaymentProvider({ webhookSecret: WEBHOOK_SECRET, now: () => AUTHORIZED_AT });
}

function app(db: Database, at: Date) {
  return createApp({
    logger: quiet,
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

interface Arranged {
  readonly accountId: string;
  readonly token: string;
  readonly challengeId: string;
  readonly authorizationId: string;
}

/**
 * A signed-in account with one challenge. A funded one carries a live hold the
 * provider really issued and the `deposit_authorized` movement the webhook would
 * have written for it, so a forfeit can be shown balancing in the ledger.
 */
async function arrange(
  db: Database,
  payments: FakePaymentProvider,
  overrides: {
    status?: "active" | "failed" | "succeeded" | "expired" | "abandoned";
    depositMinorUnits?: number;
    hold?: "live" | "released";
    holdExpiresAt?: Date;
  } = {},
): Promise<Arranged> {
  const depositMinorUnits = overrides.depositMinorUnits ?? DEPOSIT;
  const { accountId, token } = await signIn(db);
  const challengeId = await insertChallengeForAccount(db, accountId, {
    depositMinorUnits,
    ...(overrides.status === undefined ? {} : { status: overrides.status }),
  });
  if (depositMinorUnits === 0) return { accountId, token, challengeId, authorizationId: "" };

  const authorization = await payments.authorizeDeposit({
    reference: challengeId,
    customerReference: accountId,
    amount: { amountMinorUnits: depositMinorUnits, currency: "USD" },
  });
  payments.deliver(authorization.authorizationId, "succeeded");
  const instrument = await payments.getPaymentInstrument(authorization.authorizationId);

  await db.insert(challengeAuthorizations).values({
    challengeId,
    provider: payments.name,
    providerAuthorizationId: authorization.authorizationId,
    providerPaymentMethodId: instrument.paymentMethodId,
    amountMinorUnits: depositMinorUnits,
    currency: "USD",
    ...(overrides.hold === "released"
      ? { status: "released" as const, endedAt: AUTHORIZED_AT }
      : { status: "live" as const }),
    authorizedAt: AUTHORIZED_AT,
    expiresAt: overrides.holdExpiresAt ?? EXPIRES_AT,
  });
  if (overrides.hold === "released") {
    await db
      .update(challenges)
      .set({ depositSecured: false })
      .where(eq(challenges.id, challengeId));
  }

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

  return { accountId, token, challengeId, authorizationId: authorization.authorizationId };
}

function endRequest(token: string, challengeId: string, key: string): [string, RequestInit] {
  return [
    `http://api.test/challenges/${challengeId}/abandonment`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        [IDEMPOTENCY_HEADER]: key,
      },
      body: JSON.stringify({}),
    },
  ];
}

async function end(db: Database, arranged: Arranged, at: Date, key = KEY.first) {
  const response = await app(db, at).request(
    ...endRequest(arranged.token, arranged.challengeId, key),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function missFirstTask(db: Database, payments: FakePaymentProvider): Promise<string> {
  await createSweep({ db, provider: payments, now: () => MISSED_AT })(
    scheduledEvent() as ScheduledEvent,
    quiet,
  );
  const [missed] = await db
    .select({ id: scheduledTasks.id, challengeId: scheduledTasks.challengeId })
    .from(scheduledTasks)
    .where(eq(scheduledTasks.status, "missed"));
  if (missed === undefined) throw new Error("the sweep missed no task");
  return missed.id;
}

async function settle(db: Database, payments: FakePaymentProvider, at: Date) {
  return await runSettlementPass({ db, provider: payments, now: at, batchSize: 10, logger: quiet });
}

async function challengeRow(db: Database, challengeId: string) {
  const [row] = await db.select().from(challenges).where(eq(challenges.id, challengeId));
  if (row === undefined) throw new Error("the challenge disappeared");
  return row;
}

async function capturesOf(db: Database, challengeId: string) {
  return await db
    .select({
      status: paymentCommands.status,
      dedupeKey: paymentCommands.dedupeKey,
      executeAfter: paymentCommands.executeAfter,
    })
    .from(paymentCommands)
    .where(and(eq(paymentCommands.challengeId, challengeId), eq(paymentCommands.kind, "capture")))
    .orderBy(asc(paymentCommands.createdAt));
}

async function allowanceOf(db: Database, accountId: string): Promise<Date | null> {
  const [row] = await db
    .select({ consumedAt: accounts.emergencyRecoveryConsumedAt })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  return row?.consumedAt ?? null;
}

async function revenueOf(db: Database, challengeId: string): Promise<number> {
  const rows = await db
    .select({ ledgerAccount: ledgerEntries.ledgerAccount, amount: ledgerEntries.amountMinorUnits })
    .from(ledgerTransactions)
    .innerJoin(ledgerEntries, eq(ledgerEntries.transactionId, ledgerTransactions.id))
    .where(eq(ledgerTransactions.challengeId, challengeId));
  return rows
    .filter((row) => row.ledgerAccount === "platform_revenue")
    .reduce((sum, row) => sum + row.amount, 0);
}

describe("ending a running challenge", () => {
  it("ends it as abandoned, charges the whole deposit now, and keeps the allowance", async () => {
    const { db } = testDatabase();
    const payments = provider();
    const arranged = await arrange(db, payments);

    const { status, body } = await end(db, arranged, ENDED_AT);

    expect(status).toBe(200);
    expect(body).toEqual({
      ended: {
        id: arranged.challengeId,
        status: "abandoned",
        endedAt: ENDED_AT.toISOString(),
        requiredTaskCount: 3,
        completedTaskCount: 0,
        deposit: { amount: DEPOSIT, currency: "USD" },
        depositOutcome: "charged",
      },
    });
    expect(await challengeRow(db, arranged.challengeId)).toMatchObject({
      status: "abandoned",
      terminalAt: ENDED_AT,
    });
    expect(await capturesOf(db, arranged.challengeId)).toEqual([
      {
        status: "pending",
        dedupeKey: `capture:abandon:${arranged.challengeId}`,
        executeAfter: ENDED_AT,
      },
    ]);
    expect(await allowanceOf(db, arranged.accountId)).toBeNull();

    // The settlement pass collects it the way it collects a failure.
    const settled = await settle(db, payments, ENDED_AT);
    expect(settled.forfeitsCollected).toBe(1);
    expect((await capturesOf(db, arranged.challengeId))[0]?.status).toBe("confirmed");
    expect(await revenueOf(db, arranged.challengeId)).toBe(DEPOSIT);
    expect(await payments.getTransactionStatus(arranged.authorizationId)).toMatchObject({
      state: "captured",
    });
  });

  it("ends a paused challenge exactly the same way", async () => {
    const { db } = testDatabase();
    const payments = provider();
    const arranged = await arrange(db, payments);
    const pausedAt = new Date("2026-01-02T00:00:00Z");
    await db.update(challenges).set({ pausedAt }).where(eq(challenges.id, arranged.challengeId));

    const { status, body } = await end(db, arranged, ENDED_AT);

    expect(status).toBe(200);
    expect(body.ended).toMatchObject({ status: "abandoned", depositOutcome: "charged" });
    // The pause is left on the row: it records that the challenge was paused
    // when it ended, which a view of past challenges can say.
    expect(await challengeRow(db, arranged.challengeId)).toMatchObject({
      status: "abandoned",
      pausedAt,
    });
    expect(await capturesOf(db, arranged.challengeId)).toHaveLength(1);
  });

  it("charges nothing for a challenge with no deposit", async () => {
    const { db } = testDatabase();
    const arranged = await arrange(db, provider(), { depositMinorUnits: 0 });

    const { status, body } = await end(db, arranged, ENDED_AT);

    expect(status).toBe(200);
    expect(body.ended).toMatchObject({ status: "abandoned", depositOutcome: "none" });
    const commands = await db
      .select()
      .from(paymentCommands)
      .where(eq(paymentCommands.challengeId, arranged.challengeId));
    expect(commands).toEqual([]);
  });

  it("charges the saved card when the hold renewal had failed", async () => {
    const { db } = testDatabase();
    const payments = provider();
    const arranged = await arrange(db, payments, { hold: "released" });

    await end(db, arranged, ENDED_AT);
    const settled = await settle(db, payments, ENDED_AT);

    expect(settled.forfeitsCollected).toBe(1);
    const kinds = await db
      .select({ kind: ledgerTransactions.kind })
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.challengeId, arranged.challengeId));
    expect(kinds.map((row) => row.kind)).toContain("forfeit_charged");
    expect(await revenueOf(db, arranged.challengeId)).toBe(DEPOSIT);
  });

  it("stops the hold being renewed from the moment it ends", async () => {
    const { db } = testDatabase();
    const payments = provider();
    // Half of this hold's life is spent by the ending instant, so a running
    // challenge's hold would be renewed now.
    const arranged = await arrange(db, payments, {
      holdExpiresAt: new Date("2026-01-06T00:00:00Z"),
    });

    await end(db, arranged, ENDED_AT);
    const renewal = await runRenewalPass({
      db,
      provider: payments,
      now: ENDED_AT,
      batchSize: 10,
      logger: quiet,
    });

    expect(renewal.authorizationsRenewed).toBe(0);
    const holds = await db
      .select({ status: challengeAuthorizations.status })
      .from(challengeAuthorizations)
      .where(eq(challengeAuthorizations.challengeId, arranged.challengeId));
    expect(holds).toEqual([{ status: "live" }]);
  });

  it("gives the account its slot back for a new challenge", async () => {
    const { db } = testDatabase();
    const arranged = await arrange(db, provider(), { depositMinorUnits: 0 });

    await end(db, arranged, ENDED_AT);

    // The one-open-challenge index would refuse this if the ended one still
    // held the slot.
    await expect(
      insertChallengeForAccount(db, arranged.accountId, { depositMinorUnits: 0 }),
    ).resolves.toEqual(expect.any(String));
  });
});

describe("ending during a recovery offer", () => {
  it("brings the offer's capture forward instead of adding one, and keeps the allowance", async () => {
    const { db } = testDatabase();
    const payments = provider();
    const arranged = await arrange(db, payments);
    const missedTaskId = await missFirstTask(db, payments);
    expect((await challengeRow(db, arranged.challengeId)).status).toBe("recovery_pending");
    const at = new Date(MISSED_AT.getTime() + HOUR_MS);

    const { status, body } = await end(db, arranged, at);

    expect(status).toBe(200);
    expect(body.ended).toMatchObject({ status: "abandoned", depositOutcome: "charged" });
    expect(await capturesOf(db, arranged.challengeId)).toEqual([
      { status: "pending", dedupeKey: `capture:miss:${missedTaskId}`, executeAfter: at },
    ]);
    expect(await allowanceOf(db, arranged.accountId)).toBeNull();
    const [missed] = await db
      .select({ status: scheduledTasks.status })
      .from(scheduledTasks)
      .where(eq(scheduledTasks.id, missedTaskId));
    expect(missed?.status).toBe("missed");

    const settled = await settle(db, payments, at);
    expect(settled.forfeitsCollected).toBe(1);
    // Settlement closes an offer by failing the challenge. This one was already
    // ended, and stays recorded as ended by its owner.
    expect((await challengeRow(db, arranged.challengeId)).status).toBe("abandoned");
    expect(await revenueOf(db, arranged.challengeId)).toBe(DEPOSIT);
  });

  it("refuses the recovery once the challenge has been ended", async () => {
    const { db } = testDatabase();
    const payments = provider();
    const arranged = await arrange(db, payments);
    const missedTaskId = await missFirstTask(db, payments);
    const at = new Date(MISSED_AT.getTime() + HOUR_MS);
    await end(db, arranged, at);

    await expect(
      acceptRecovery(
        { db, now: () => at },
        {
          accountId: arranged.accountId,
          challengeId: arranged.challengeId,
          idempotencyKey: KEY.second,
          taskId: missedTaskId,
        },
      ),
    ).rejects.toMatchObject({ code: "recovery_not_offered" });
    expect(await allowanceOf(db, arranged.accountId)).toBeNull();
  });
});

describe("ending after an accepted recovery", () => {
  it("creates a new capture the cancelled one does not swallow, and collects it", async () => {
    const { db } = testDatabase();
    const payments = provider();
    const arranged = await arrange(db, payments);
    const missedTaskId = await missFirstTask(db, payments);
    const recoveredAt = new Date(MISSED_AT.getTime() + HOUR_MS);
    await acceptRecovery(
      { db, now: () => recoveredAt },
      {
        accountId: arranged.accountId,
        challengeId: arranged.challengeId,
        idempotencyKey: KEY.second,
        taskId: missedTaskId,
      },
    );
    const at = new Date(recoveredAt.getTime() + HOUR_MS);

    const { status } = await end(db, arranged, at);
    const settled = await settle(db, payments, at);

    expect(status).toBe(200);
    expect(settled.forfeitsCollected).toBe(1);
    expect(await capturesOf(db, arranged.challengeId)).toEqual([
      expect.objectContaining({ status: "cancelled", dedupeKey: `capture:miss:${missedTaskId}` }),
      {
        status: "confirmed",
        dedupeKey: `capture:abandon:${arranged.challengeId}`,
        executeAfter: at,
      },
    ]);
    expect(await revenueOf(db, arranged.challengeId)).toBe(DEPOSIT);
  });
});

describe("what ending refuses", () => {
  it("refuses a challenge that has already ended, and changes nothing", async () => {
    const { db } = testDatabase();
    for (const status of ["failed", "succeeded", "expired", "abandoned"] as const) {
      const arranged = await arrange(db, provider(), { status, depositMinorUnits: 0 });
      const before = await challengeRow(db, arranged.challengeId);

      const response = await end(db, arranged, ENDED_AT);

      expect(response).toMatchObject({ status: 409, body: { code: "challenge_not_active" } });
      expect(await challengeRow(db, arranged.challengeId)).toEqual(before);
    }
  });

  it("answers another account's challenge with not found", async () => {
    const { db } = testDatabase();
    const owner = await arrange(db, provider(), { depositMinorUnits: 0 });
    const stranger = await signIn(db);

    const response = await end(db, { ...owner, token: stranger.token }, ENDED_AT);

    expect(response).toMatchObject({ status: 404, body: { code: "not_found" } });
    expect((await challengeRow(db, owner.challengeId)).status).toBe("active");
  });
});

describe("ending twice", () => {
  it("replays the first answer under the same key and creates one capture", async () => {
    const { db } = testDatabase();
    const arranged = await arrange(db, provider());

    const first = await end(db, arranged, ENDED_AT);
    const again = await end(db, arranged, new Date(ENDED_AT.getTime() + HOUR_MS));

    expect(again).toEqual(first);
    expect(await capturesOf(db, arranged.challengeId)).toHaveLength(1);
  });

  it("refuses a second ending under a fresh key", async () => {
    const { db } = testDatabase();
    const arranged = await arrange(db, provider());
    await end(db, arranged, ENDED_AT);

    const again = await end(db, arranged, ENDED_AT, KEY.second);

    expect(again).toMatchObject({ status: 409, body: { code: "challenge_not_active" } });
    expect(await capturesOf(db, arranged.challengeId)).toHaveLength(1);
  });
});
