/**
 * Issue 24a against real rows: renewal, and the payment method that recovers
 * from a renewal that failed.
 *
 * Every hold in this suite is a real one taken from the fake provider and
 * confirmed by it, because the pass calls the provider for each renewal and a
 * row naming an authorization the provider never issued would exercise the
 * failure path instead of the success one.
 *
 * The windows are chosen so that renewal and the rest of the sweep do not
 * collide. The challenge fixture places its first deadline on 2026-01-05, so
 * every hold here runs from 2026-01-01 to 2026-01-05 and its midpoint,
 * 2026-01-03, is a moment at which nothing is overdue. That is what lets one
 * test run the whole sweep and still be about renewal.
 */

import { IDEMPOTENCY_HEADER } from "@betterwakeup/contract";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createSessionGate } from "../../src/auth/session-gate.ts";
import { hashSessionToken, mintSessionToken } from "../../src/auth/session-token.ts";
import { createChallengeHandlers } from "../../src/challenges/handlers.ts";
import type { Database } from "../../src/db/index.ts";
import { challengeAuthorizations } from "../../src/db/schema/authorizations.ts";
import { challenges, ledgerTransactions, scheduledTasks, sessions } from "../../src/db/schema.ts";
import { createApp } from "../../src/http/app.ts";
import type { ScheduledEvent } from "../../src/lambda/events.ts";
import { createLogger } from "../../src/observability/logger.ts";
import { FakePaymentProvider } from "../../src/payments/fake-provider.ts";
import { runRenewalPass } from "../../src/payments/renewal.ts";
import { createSweep } from "../../src/sweep/run-sweep.ts";
import { insertAccount, insertChallengeForAccount } from "../support/challenge-fixtures.ts";
import { fakeRateLimiter } from "../support/fake-rate-limiter.ts";
import { scheduledEvent } from "../support/lambda-events.ts";
import { useTestDatabase } from "../support/postgres.ts";

const testDatabase = useTestDatabase();

const SESSION_SECRET = "0123456789abcdef0123456789abcdef";
const WEBHOOK_SECRET = "a-shared-secret-with-the-provider";
const DEPOSIT = 2000;

/** When the first hold was taken. */
const AUTHORIZED_AT = new Date("2026-01-01T00:00:00Z");
/** When it lapses. A four day window, chosen to end before the first deadline. */
const EXPIRES_AT = new Date("2026-01-05T00:00:00Z");
/** Exactly half the window: the first instant at which the hold is due. */
const HALFWAY = new Date("2026-01-03T00:00:00Z");
/** One millisecond before that. */
const JUST_BEFORE_HALFWAY = new Date(HALFWAY.getTime() - 1);

const KEY = {
  first: "aa110000-0000-4000-8000-000000000001",
  second: "aa110000-0000-4000-8000-000000000002",
  third: "aa110000-0000-4000-8000-000000000003",
};

interface Arranged {
  readonly accountId: string;
  readonly token: string;
  readonly challengeId: string;
  /** The provider's handle for the hold the fixture recorded as live. */
  readonly authorizationId: string;
  readonly paymentMethodId: string;
}

/** The provider, the lines it writes, and a clock the test moves. */
function harness() {
  let at = AUTHORIZED_AT;
  const lines: Record<string, unknown>[] = [];
  const provider = new FakePaymentProvider({ webhookSecret: WEBHOOK_SECRET, now: () => at });
  const logger = createLogger({
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return {
    provider,
    logger,
    lines,
    moveTo(instant: Date) {
      at = instant;
    },
  };
}

type Harness = ReturnType<typeof harness>;

function mountServer(db: Database, provider: FakePaymentProvider, at: Date) {
  return createApp({
    logger: createLogger({ sink: () => {} }),
    sessionGate: createSessionGate({ db, sessionSecret: SESSION_SECRET }),
    rateLimiter: fakeRateLimiter(),
    handlers: createChallengeHandlers({ db, provider, now: () => at }),
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

/**
 * A funded challenge with a live hold behind it.
 *
 * The hold is confirmed through the provider's own delivery, so it is live on
 * the provider's side too and the pass has something real to renew.
 */
async function arrange(
  db: Database,
  { provider }: Harness,
  overrides: {
    status?: "active" | "recovery_pending" | "failed";
    depositMinorUnits?: number;
    expiresAt?: Date;
  } = {},
): Promise<Arranged> {
  const depositMinorUnits = overrides.depositMinorUnits ?? DEPOSIT;
  const { accountId, token } = await signIn(db);
  const challengeId = await insertChallengeForAccount(db, accountId, {
    depositMinorUnits,
    ...(overrides.status === undefined ? {} : { status: overrides.status }),
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
    status: "live",
    authorizedAt: AUTHORIZED_AT,
    expiresAt: overrides.expiresAt ?? EXPIRES_AT,
  });

  return {
    accountId,
    token,
    challengeId,
    authorizationId: authorization.authorizationId,
    paymentMethodId: instrument.paymentMethodId,
  };
}

async function renewAt(db: Database, app: Harness, at: Date, batchSize = 10) {
  app.moveTo(at);
  return await runRenewalPass({
    db,
    provider: app.provider,
    now: at,
    batchSize,
    logger: app.logger,
  });
}

async function liveHold(db: Database, challengeId: string) {
  const [row] = await db
    .select()
    .from(challengeAuthorizations)
    .where(
      and(
        eq(challengeAuthorizations.challengeId, challengeId),
        eq(challengeAuthorizations.status, "live"),
      ),
    );
  return row;
}

async function holdsOf(db: Database, challengeId: string) {
  return await db
    .select()
    .from(challengeAuthorizations)
    .where(eq(challengeAuthorizations.challengeId, challengeId));
}

async function challengeRow(db: Database, challengeId: string) {
  const [row] = await db.select().from(challenges).where(eq(challenges.id, challengeId));
  return row;
}

function replaceRequest(
  token: string,
  challengeId: string,
  paymentMethodId: string,
  key: string,
): [string, RequestInit] {
  return [
    `http://api.test/challenges/${challengeId}/payment-method`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        [IDEMPOTENCY_HEADER]: key,
      },
      body: JSON.stringify({ providerPaymentMethodId: paymentMethodId }),
    },
  ];
}

describe("issue 24a's acceptance boundary", () => {
  it("keeps a challenge outliving several renewals secured, with one live hold throughout", async () => {
    const { db } = testDatabase();
    const app = harness();
    const arranged = await arrange(db, app);

    // Three windows in a row. Each renewal's replacement runs for thirty days
    // from the instant it was taken, so the next one is due fifteen days later.
    let due = HALFWAY;
    const seen = [arranged.authorizationId];
    for (let renewal = 0; renewal < 3; renewal += 1) {
      const result = await renewAt(db, app, due);
      expect(result.authorizationsRenewed).toBe(1);

      const live = await liveHold(db, arranged.challengeId);
      expect(live).toBeDefined();
      expect(seen).not.toContain(live?.providerAuthorizationId);
      seen.push(live?.providerAuthorizationId ?? "");

      // The window the replacement carries is the provider's own, and the next
      // renewal is due at its midpoint.
      expect(live?.authorizedAt.toISOString()).toBe(due.toISOString());
      due = new Date(due.getTime() + ((live?.expiresAt.getTime() ?? 0) - due.getTime()) / 2);
      expect(await liveHoldCount(db, arranged.challengeId)).toBe(1);
      expect((await challengeRow(db, arranged.challengeId))?.depositSecured).toBe(true);
    }

    // Every superseded hold was released at the provider, and none was ever
    // captured: three renewals moved no money at all.
    for (const identifier of seen.slice(0, 3)) {
      expect(await app.provider.getTransactionStatus(identifier)).toMatchObject({
        state: "released",
      });
    }
    expect(await app.provider.getTransactionStatus(seen[3] ?? "")).toMatchObject({
      state: "authorized",
    });
  });

  it("leaves the challenge running, and says so, when the renewal is declined", async () => {
    const { db } = testDatabase();
    const app = harness();
    const arranged = await arrange(db, app);
    app.provider.declineRenewalsOf(arranged.authorizationId);

    const tasksBefore = await db
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.challengeId, arranged.challengeId));
    const result = await renewAt(db, app, HALFWAY);

    expect(result).toMatchObject({ authorizationsRenewed: 0, renewalsFailed: 1 });

    // The rule stated directly rather than derived: the challenge is untouched
    // apart from the flag that says its deposit is not secured.
    const challenge = await challengeRow(db, arranged.challengeId);
    expect(challenge?.status).toBe("active");
    expect(challenge?.terminalAt).toBeNull();
    expect(challenge?.depositSecured).toBe(false);
    expect(
      await db
        .select()
        .from(scheduledTasks)
        .where(eq(scheduledTasks.challengeId, arranged.challengeId)),
    ).toHaveLength(tasksBefore.length);

    // The user is informed: the flag the app reads is set, and the line an
    // operator alarms on was written.
    expect(app.lines).toContainEqual(
      expect.objectContaining({
        message: "authorization renewal failed",
        authorizationRenewal: "failed",
        depositSecured: false,
        challengeId: arranged.challengeId,
      }),
    );

    // The hold is still live and still due, so the next sweep tries again.
    const hold = await liveHold(db, arranged.challengeId);
    expect(hold?.renewalAttempts).toBe(1);
    expect(hold?.lastError).toBeTruthy();
    await renewAt(db, app, HALFWAY);
    expect((await liveHold(db, arranged.challengeId))?.renewalAttempts).toBe(2);
  });

  it("continues renewing through recovery_pending", async () => {
    const { db } = testDatabase();
    const app = harness();
    const arranged = await arrange(db, app, { status: "recovery_pending" });

    const result = await renewAt(db, app, HALFWAY);

    expect(result.authorizationsRenewed).toBe(1);
    expect((await challengeRow(db, arranged.challengeId))?.status).toBe("recovery_pending");
  });

  it("captures nothing on any renewal path", async () => {
    const { db } = testDatabase();
    const app = harness();
    const arranged = await arrange(db, app);

    await renewAt(db, app, HALFWAY);

    // Neither the provider's records nor the ledger show a movement of money.
    for (const hold of await holdsOf(db, arranged.challengeId)) {
      expect(hold.status).not.toBe("captured");
      expect(
        await app.provider.getTransactionStatus(hold.providerAuthorizationId),
      ).not.toMatchObject({ state: "captured" });
    }
    expect(
      await db
        .select()
        .from(ledgerTransactions)
        .where(eq(ledgerTransactions.challengeId, arranged.challengeId)),
    ).toHaveLength(0);
  });
});

describe("when a hold becomes due", () => {
  it("renews at the halfway instant and not one millisecond before it", async () => {
    const { db } = testDatabase();
    const app = harness();
    const arranged = await arrange(db, app);

    expect(await renewAt(db, app, JUST_BEFORE_HALFWAY)).toMatchObject({
      authorizationsRenewed: 0,
    });
    expect((await liveHold(db, arranged.challengeId))?.providerAuthorizationId).toBe(
      arranged.authorizationId,
    );

    expect(await renewAt(db, app, HALFWAY)).toMatchObject({ authorizationsRenewed: 1 });
  });

  it("leaves a terminal challenge's hold alone", async () => {
    const { db } = testDatabase();
    const app = harness();
    const arranged = await arrange(db, app, { status: "failed" });

    expect(await renewAt(db, app, HALFWAY)).toMatchObject({ authorizationsRenewed: 0 });
    expect((await liveHold(db, arranged.challengeId))?.providerAuthorizationId).toBe(
      arranged.authorizationId,
    );
  });

  it("tries each due hold once per invocation, so one declining card cannot fill the batch", async () => {
    const { db } = testDatabase();
    const app = harness();
    const first = await arrange(db, app);
    const second = await arrange(db, app);
    app.provider.declineRenewalsOf(first.authorizationId);

    const result = await renewAt(db, app, HALFWAY, 10);

    expect(result).toMatchObject({ authorizationsRenewed: 1, renewalsFailed: 1 });
  });

  it("is step 7 of the sweep, which reports what it renewed", async () => {
    const { db } = testDatabase();
    const app = harness();
    const arranged = await arrange(db, app);
    app.moveTo(HALFWAY);

    const run = createSweep({ db, provider: app.provider, now: () => HALFWAY });
    const result = await run(scheduledEvent() as ScheduledEvent, app.logger);

    expect(result).toMatchObject({ authorizationsRenewed: 1, renewalsFailed: 0, tasksMissed: 0 });
    expect((await liveHold(db, arranged.challengeId))?.providerAuthorizationId).not.toBe(
      arranged.authorizationId,
    );
  });

  it("renews nothing when the deployment has no provider configured", async () => {
    const { db } = testDatabase();
    const app = harness();
    const arranged = await arrange(db, app);

    const run = createSweep({ db, now: () => HALFWAY });
    const result = await run(scheduledEvent() as ScheduledEvent, app.logger);

    expect(result.authorizationsRenewed).toBe(0);
    expect((await liveHold(db, arranged.challengeId))?.providerAuthorizationId).toBe(
      arranged.authorizationId,
    );
  });
});

describe("replacing the payment method", () => {
  it("secures a challenge whose renewal failed, and releases the hold it replaces", async () => {
    const { db } = testDatabase();
    const app = harness();
    const arranged = await arrange(db, app);
    app.provider.declineRenewalsOf(arranged.authorizationId);
    await renewAt(db, app, HALFWAY);

    const replacement = await freshInstrument(app, arranged.accountId);
    const response = await mountServer(db, app.provider, HALFWAY).request(
      ...replaceRequest(arranged.token, arranged.challengeId, replacement, KEY.first),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { challenge: { depositSecured: boolean } };
    expect(body.challenge.depositSecured).toBe(true);

    const live = await liveHold(db, arranged.challengeId);
    expect(live?.providerPaymentMethodId).toBe(replacement);
    expect(live?.providerAuthorizationId).not.toBe(arranged.authorizationId);
    expect(await app.provider.getTransactionStatus(arranged.authorizationId)).toMatchObject({
      state: "released",
    });
    expect(await liveHoldCount(db, arranged.challengeId)).toBe(1);
    expect((await challengeRow(db, arranged.challengeId))?.status).toBe("active");
  });

  it("refuses a declined instrument and leaves the challenge unsecured", async () => {
    const { db } = testDatabase();
    const app = harness();
    const arranged = await arrange(db, app);
    app.provider.declineRenewalsOf(arranged.authorizationId);
    await renewAt(db, app, HALFWAY);

    const replacement = await freshInstrument(app, arranged.accountId);
    app.provider.declineInstrument(replacement);

    const response = await mountServer(db, app.provider, HALFWAY).request(
      ...replaceRequest(arranged.token, arranged.challengeId, replacement, KEY.first),
    );

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ code: "payment_declined" });
    expect((await challengeRow(db, arranged.challengeId))?.depositSecured).toBe(false);
    expect((await liveHold(db, arranged.challengeId))?.providerAuthorizationId).toBe(
      arranged.authorizationId,
    );
  });

  it("replays a repeated key rather than taking a second hold", async () => {
    const { db } = testDatabase();
    const app = harness();
    const arranged = await arrange(db, app);
    const replacement = await freshInstrument(app, arranged.accountId);
    const server = mountServer(db, app.provider, HALFWAY);

    const first = await server.request(
      ...replaceRequest(arranged.token, arranged.challengeId, replacement, KEY.first),
    );
    const second = await server.request(
      ...replaceRequest(arranged.token, arranged.challengeId, replacement, KEY.first),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await holdsOf(db, arranged.challengeId)).toHaveLength(2);
  });

  it("refuses a challenge with no deposit, and one that has ended", async () => {
    const { db } = testDatabase();
    const app = harness();
    const unfunded = await arrange(db, app, { depositMinorUnits: 0 });
    const ended = await arrange(db, app, { status: "failed" });
    const server = mountServer(db, app.provider, HALFWAY);

    const first = await server.request(
      ...replaceRequest(unfunded.token, unfunded.challengeId, "pm_anything", KEY.first),
    );
    const second = await server.request(
      ...replaceRequest(ended.token, ended.challengeId, "pm_anything", KEY.second),
    );

    expect(await first.json()).toMatchObject({ code: "deposit_required_for_funding" });
    expect(await second.json()).toMatchObject({ code: "challenge_not_active" });
  });

  it("answers not found for another account's challenge", async () => {
    const { db } = testDatabase();
    const app = harness();
    const mine = await arrange(db, app);
    const theirs = await arrange(db, app);

    const response = await mountServer(db, app.provider, HALFWAY).request(
      ...replaceRequest(mine.token, theirs.challengeId, "pm_anything", KEY.third),
    );

    expect(response.status).toBe(404);
  });
});

/** A saved instrument the provider already holds, from an unrelated hold. */
async function freshInstrument(app: Harness, accountId: string): Promise<string> {
  const authorization = await app.provider.authorizeDeposit({
    reference: `instrument-${accountId}`,
    customerReference: accountId,
    amount: { amountMinorUnits: DEPOSIT, currency: "USD" },
  });
  return (await app.provider.getPaymentInstrument(authorization.authorizationId)).paymentMethodId;
}

async function liveHoldCount(db: Database, challengeId: string): Promise<number> {
  return (await holdsOf(db, challengeId)).filter((hold) => hold.status === "live").length;
}
