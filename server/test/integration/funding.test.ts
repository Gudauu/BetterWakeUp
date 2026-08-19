/**
 * Issue 19 against real rows and through the mounted routes.
 *
 * The acceptance boundary is the first section, and it is one rule stated four
 * ways: money never activates a challenge from the client. A funding intent
 * creates nothing, the client's own report of a successful payment creates
 * nothing, the provider's verified delivery creates everything, and what it
 * creates is complete the instant it exists.
 *
 * The last section is the one this issue exists to make checkable: no capture
 * occurs anywhere in the flow, on either the provider's records or the ledger.
 */

import {
  type ChallengeConfiguration,
  DISCLOSURE_POLICY_VERSION,
  IDEMPOTENCY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  type Weekday,
} from "@betterwakeup/contract";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createSessionGate } from "../../src/auth/session-gate.ts";
import { hashSessionToken, mintSessionToken } from "../../src/auth/session-token.ts";
import { createChallengeHandlers } from "../../src/challenges/handlers.ts";
import type { Database } from "../../src/db/index.ts";
import {
  challengeAuthorizations,
  challenges,
  fundingIntents,
  ledgerEntries,
  ledgerTransactions,
  paymentProviderEvents,
  scheduledTasks,
  sessions,
} from "../../src/db/schema.ts";
import { createApp } from "../../src/http/app.ts";
import { createLogger } from "../../src/observability/logger.ts";
import { FakePaymentProvider } from "../../src/payments/fake-provider.ts";
import {
  createPaymentHandlers,
  createWebhookSignatureVerifier,
} from "../../src/payments/handlers.ts";
import { insertAccount, insertChallengeForAccount } from "../support/challenge-fixtures.ts";
import { fakeRateLimiter } from "../support/fake-rate-limiter.ts";
import { useTestDatabase } from "../support/postgres.ts";

const testDatabase = useTestDatabase();

const SESSION_SECRET = "0123456789abcdef0123456789abcdef";
const WEBHOOK_SECRET = "a-shared-secret-with-the-provider";
/** Midnight UTC on Monday 5 January 2026, so every date in this file is fixed. */
const STARTING_AT = new Date("2026-01-05T00:00:00Z");
const DEPOSIT = { amount: 5000, currency: "USD" as const };

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
    deposit: DEPOSIT,
    ...overrides,
  };
}

/** The server, the provider behind it, and the provider's own half. */
function harness(db: Database) {
  const provider = new FakePaymentProvider({
    webhookSecret: WEBHOOK_SECRET,
    now: () => STARTING_AT,
  });
  const deps = { db, provider, now: () => STARTING_AT };
  const server = createApp({
    logger: createLogger({ sink: () => {} }),
    sessionGate: createSessionGate({ db, sessionSecret: SESSION_SECRET }),
    signatureVerifier: createWebhookSignatureVerifier(provider),
    rateLimiter: fakeRateLimiter(),
    handlers: { ...createChallengeHandlers(deps), ...createPaymentHandlers(deps) },
  });
  return { provider, server };
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

/** A delivery as the provider sends it: raw bytes plus the signature over them. */
function deliver(body: string, signature: string): [string, RequestInit] {
  return [
    "http://api.test/payments/webhooks/fake",
    {
      method: "POST",
      headers: { "content-type": "application/json", [WEBHOOK_SIGNATURE_HEADER]: signature },
      body,
    },
  ];
}

type Harness = ReturnType<typeof harness>;

/** Ask for a hold, returning the intent the app got and the provider's handle. */
async function fund(
  { server }: Harness,
  token: string,
  key: string,
  overrides: Partial<ChallengeConfiguration> = {},
): Promise<{ status: number; body: Record<string, unknown>; authorizationId: string | undefined }> {
  const response = await server.request(
    ...post(
      token,
      "/challenges/funding-intents",
      { configuration: configuration(overrides), policyVersion: DISCLOSURE_POLICY_VERSION },
      key,
    ),
  );
  const body = (await response.json()) as Record<string, unknown>;
  const secret = body.providerClientSecret;
  return {
    status: response.status,
    body,
    // The client secret is minted from the authorization, which is the only
    // place a test can learn the provider's handle without reading its state.
    authorizationId: typeof secret === "string" ? secret.split("_secret_")[0] : undefined,
  };
}

async function challengeCount(db: Database, accountId: string): Promise<number> {
  return (
    await db
      .select({ id: challenges.id })
      .from(challenges)
      .where(eq(challenges.accountId, accountId))
  ).length;
}

describe("issue 19's acceptance boundary", () => {
  it("authorizes without creating a challenge, and activates only on the provider's delivery", async () => {
    const { db } = testDatabase();
    const { accountId, token } = await signIn(db);
    const app = harness(db);

    const intent = await fund(app, token, "6b4bcd10-0000-4000-8000-000000000001");
    expect(intent.status).toBe(200);
    expect(intent.body).toMatchObject({ pollAfterAuthorization: true });
    expect(typeof intent.body.providerClientSecret).toBe("string");

    // Nothing exists yet, and the app is told exactly that by the read it is
    // instructed to poll.
    expect(await challengeCount(db, accountId)).toBe(0);
    const beforeDelivery = await app.server.request("http://api.test/challenges/current", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await beforeDelivery.json()).toEqual({ challenge: null, lastEnded: null });

    const delivery = app.provider.deliver(intent.authorizationId ?? "", "succeeded");
    const webhook = await app.server.request(...deliver(delivery.body, delivery.signature));

    expect(webhook.status).toBe(200);
    expect(await webhook.json()).toEqual({ duplicate: false });
    expect(await challengeCount(db, accountId)).toBe(1);
  });

  it("materializes the full schedule in the same transaction that activates the challenge", async () => {
    const { db } = testDatabase();
    const { accountId, token } = await signIn(db);
    const app = harness(db);

    const intent = await fund(app, token, "6b4bcd10-0000-4000-8000-000000000002", {
      requiredTaskCount: 6,
    });
    const delivery = app.provider.deliver(intent.authorizationId ?? "", "succeeded");
    await app.server.request(...deliver(delivery.body, delivery.signature));

    const [challenge] = await db
      .select()
      .from(challenges)
      .where(eq(challenges.accountId, accountId));
    const tasks = await db
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.challengeId, challenge?.id ?? ""))
      .orderBy(asc(scheduledTasks.sequence));

    // The task count invariant is a deferred trigger, so a challenge that
    // committed at all committed with its required tasks under it.
    expect(challenge?.status).toBe("active");
    expect(challenge?.requiredTaskCount).toBe(6);
    expect(tasks).toHaveLength(6);
    expect(challenge?.activatedAt?.toISOString()).toBe(STARTING_AT.toISOString());
    // The terms are the stored ones, taken from the intent and not from the
    // delivery, which describes no challenge at all.
    expect(challenge?.depositMinorUnits).toBe(DEPOSIT.amount);
    expect(challenge?.policyVersion).toBe(DISCLOSURE_POLICY_VERSION);
  });

  it("refuses a delivery whose signature does not verify, and applies nothing", async () => {
    const { db } = testDatabase();
    const { accountId, token } = await signIn(db);
    const app = harness(db);

    const intent = await fund(app, token, "6b4bcd10-0000-4000-8000-000000000003");
    const delivery = app.provider.deliver(intent.authorizationId ?? "", "succeeded");

    const forged = await app.server.request(...deliver(delivery.body, "0".repeat(64)));
    const unsigned = await app.server.request("http://api.test/payments/webhooks/fake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: delivery.body,
    });

    expect(forged.status).toBe(401);
    expect(await forged.json()).toMatchObject({ code: "webhook_signature_invalid" });
    expect(unsigned.status).toBe(401);
    expect(await challengeCount(db, accountId)).toBe(0);
    // The delivery never reached the recorder either, so a later genuine
    // delivery of the same event still applies.
    expect(await db.select().from(paymentProviderEvents)).toHaveLength(0);
  });

  it("applies a redelivered event once", async () => {
    const { db } = testDatabase();
    const { accountId, token } = await signIn(db);
    const app = harness(db);

    const intent = await fund(app, token, "6b4bcd10-0000-4000-8000-000000000004");
    const delivery = app.provider.deliver(intent.authorizationId ?? "", "succeeded");

    const first = await app.server.request(...deliver(delivery.body, delivery.signature));
    const second = await app.server.request(...deliver(delivery.body, delivery.signature));

    expect(await first.json()).toEqual({ duplicate: false });
    // Answered 200: a provider told a delivery failed retries it forever.
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ duplicate: true });
    expect(await challengeCount(db, accountId)).toBe(1);
  });
});

describe("creating a funding intent", () => {
  it("replays the stored result for a repeated key rather than authorizing twice", async () => {
    const { db } = testDatabase();
    const { token } = await signIn(db);
    const app = harness(db);
    const key = "6b4bcd10-0000-4000-8000-000000000005";

    const first = await fund(app, token, key);
    const second = await fund(app, token, key);

    expect(second.body).toEqual(first.body);
    expect(await db.select().from(fundingIntents)).toHaveLength(1);
  });

  it("refuses a zero deposit, which belongs to the unfunded door", async () => {
    const { db } = testDatabase();
    const { token } = await signIn(db);
    const app = harness(db);

    const response = await fund(app, token, "6b4bcd10-0000-4000-8000-000000000006", {
      deposit: { amount: 0, currency: "USD" },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "deposit_required_for_funding" });
    expect(await db.select().from(fundingIntents)).toHaveLength(0);
  });

  it("refuses a schedule running past the maximum duration, which the projection only reported", async () => {
    const { db } = testDatabase();
    const { token } = await signIn(db);
    const app = harness(db);

    const response = await fund(app, token, "6b4bcd10-0000-4000-8000-000000000007", {
      requiredTaskCount: 400,
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "maximum_duration_exceeded" });
    expect(await db.select().from(fundingIntents)).toHaveLength(0);
  });

  it("refuses to fund a second challenge while one is running", async () => {
    const { db } = testDatabase();
    const { accountId, token } = await signIn(db);
    await insertChallengeForAccount(db, accountId, { depositMinorUnits: 0 });
    const app = harness(db);

    const response = await fund(app, token, "6b4bcd10-0000-4000-8000-000000000008");

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "active_challenge_exists" });
    expect(await db.select().from(fundingIntents)).toHaveLength(0);
  });

  it("serializes two simultaneous funding intents on the account row", async () => {
    const test = testDatabase();
    const second = test.connect();
    const { accountId, token } = await signIn(test.db);
    const one = harness(test.db);
    const two = harness(second.db);

    const [first, other] = await Promise.all([
      fund(one, token, "6b4bcd10-0000-4000-8000-000000000009"),
      fund(two, token, "6b4bcd10-0000-4000-8000-00000000000a"),
    ]);

    // Both are allowed: neither has a challenge yet, and a user who taps twice
    // has two holds and at most one of them will ever be confirmed.
    expect([first.status, other.status]).toEqual([200, 200]);
    expect(await test.db.select().from(fundingIntents)).toHaveLength(2);
    expect(await challengeCount(test.db, accountId)).toBe(0);
  });
});

describe("what the provider's answer does", () => {
  it("records a declined authorization without creating anything", async () => {
    const { db } = testDatabase();
    const { accountId, token } = await signIn(db);
    const app = harness(db);

    const intent = await fund(app, token, "6b4bcd10-0000-4000-8000-00000000000b");
    const delivery = app.provider.deliver(intent.authorizationId ?? "", "failed");
    const response = await app.server.request(...deliver(delivery.body, delivery.signature));

    expect(response.status).toBe(200);
    const [stored] = await db.select().from(fundingIntents);
    expect(stored?.status).toBe("failed");
    expect(stored?.challengeId).toBeNull();
    expect(await challengeCount(db, accountId)).toBe(0);
  });

  it("fails a confirmation for an account that acquired a challenge in the meantime", async () => {
    const { db } = testDatabase();
    const { accountId, token } = await signIn(db);
    const app = harness(db);

    const intent = await fund(app, token, "6b4bcd10-0000-4000-8000-00000000000c");
    // The zero deposit door is still open between the hold and its
    // confirmation, and it takes the account's one slot.
    await insertChallengeForAccount(db, accountId, { depositMinorUnits: 0 });
    const delivery = app.provider.deliver(intent.authorizationId ?? "", "succeeded");
    const response = await app.server.request(...deliver(delivery.body, delivery.signature));

    // Answered 200 rather than retried: no redelivery would ever succeed.
    expect(response.status).toBe(200);
    const [stored] = await db.select().from(fundingIntents);
    expect(stored?.status).toBe("failed");
    expect(await challengeCount(db, accountId)).toBe(1);
  });

  it("records the confirmed hold as the challenge's live authorization", async () => {
    const { db } = testDatabase();
    const { token } = await signIn(db);
    const app = harness(db);

    const intent = await fund(app, token, "6b4bcd10-0000-4000-8000-00000000000e");
    const delivery = app.provider.deliver(intent.authorizationId ?? "", "succeeded");
    await app.server.request(...deliver(delivery.body, delivery.signature));

    // The window is the provider's own, which is what issue 24a's renewal is
    // driven by, and the instrument is the one the delivery named.
    const [hold] = await db.select().from(challengeAuthorizations);
    const [challenge] = await db.select().from(challenges);
    expect(hold).toMatchObject({
      challengeId: challenge?.id,
      providerAuthorizationId: intent.authorizationId,
      status: "live",
      amountMinorUnits: DEPOSIT.amount,
      renewalAttempts: 0,
    });
    expect(hold?.authorizedAt.toISOString()).toBe(STARTING_AT.toISOString());
    expect(hold?.expiresAt.getTime()).toBeGreaterThan(STARTING_AT.getTime());
    expect(hold?.providerPaymentMethodId).toBeTruthy();
  });

  it("records and ignores a delivery naming no funding intent", async () => {
    const { db } = testDatabase();
    const app = harness(db);
    // A hold taken by some other deployment against the same provider account.
    const stray = await app.provider.authorizeDeposit({
      reference: "not-ours",
      customerReference: "somebody-else",
      amount: { amountMinorUnits: 5000, currency: "USD" },
    });
    const delivery = app.provider.deliver(stray.authorizationId, "succeeded");

    const response = await app.server.request(...deliver(delivery.body, delivery.signature));

    expect(response.status).toBe(200);
    expect(await db.select().from(challenges)).toHaveLength(0);
    // Recorded, so reconciliation can see it arrived.
    expect(await db.select().from(paymentProviderEvents)).toHaveLength(1);
  });
});

describe("nothing is captured anywhere in this flow", () => {
  it("records the hold in the ledger and moves no money", async () => {
    const { db } = testDatabase();
    const { accountId, token } = await signIn(db);
    const app = harness(db);

    const intent = await fund(app, token, "6b4bcd10-0000-4000-8000-00000000000d");
    const delivery = app.provider.deliver(intent.authorizationId ?? "", "succeeded");
    await app.server.request(...deliver(delivery.body, delivery.signature));

    const transactions = await db.select().from(ledgerTransactions);
    const entries = await db.select().from(ledgerEntries);

    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      kind: "deposit_authorized",
      accountId,
      providerReference: intent.authorizationId,
    });
    // A hold is a commitment against value the processor holds. Neither
    // `platform_revenue` nor `processor_fees` appears, because a fee attaches
    // to a capture and there has been none.
    expect(entries.map((entry) => entry.ledgerAccount).sort()).toEqual([
      "payment_processor",
      "user_commitment",
    ]);
    expect(entries.reduce((sum, entry) => sum + entry.amountMinorUnits, 0)).toBe(0);
    expect(
      entries.find((entry) => entry.ledgerAccount === "user_commitment")?.amountMinorUnits,
    ).toBe(DEPOSIT.amount);
  });

  it("leaves the provider's own record showing an authorization and not a capture", async () => {
    const { db } = testDatabase();
    const { token } = await signIn(db);
    const app = harness(db);

    const intent = await fund(app, token, "6b4bcd10-0000-4000-8000-00000000000e");
    const delivery = app.provider.deliver(intent.authorizationId ?? "", "succeeded");
    await app.server.request(...deliver(delivery.body, delivery.signature));

    expect(await app.provider.getTransactionStatus(intent.authorizationId ?? "")).toMatchObject({
      state: "authorized",
    });
  });
});
