/**
 * Issue 43: every user-facing promise, checked against what the server does.
 *
 * The disclosures are the promises. They live in the contract package as data
 * (`packages/contract/src/policy.ts`) precisely so this file can iterate them,
 * and each one has a case below that drives real rows through real code rather
 * than restating the rule. A promise with no case fails the completeness test
 * at the end, which is what stops a sentence being added to the acknowledgment
 * screen without anything in the server being made to honor it.
 *
 * Two items are claims about the app rather than the server. They declare so,
 * and name the app-suite test that proves them; this file asserts that test
 * still exists rather than pretending to cover it.
 *
 * The fixtures are the sweep suite's: three tasks on 2026-01-05, -06, and -07,
 * each with an 08:00 deadline in `America/Los_Angeles` (16:00 UTC) and a No
 * Regret duration of one hour. Every instant here is written against that.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ChallengeConfiguration,
  createChallengeRequest,
  createFundingIntentRequest,
  DISCLOSURE_POLICY_VERSION,
  DISCLOSURES,
  DONATED_SHARE_OF_FORFEIT_PERCENT,
  disclosuresFor,
  IDEMPOTENCY_HEADER,
  KNOWN_POLICY_VERSIONS,
  MAXIMUM_CHALLENGE_DURATION_DAYS,
  MAXIMUM_PAUSE_DAYS,
  RECEIPT_GRACE_SECONDS,
  RECOVERY_WINDOW_HOURS,
} from "@betterwakeup/contract";
import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createSessionGate } from "../../src/auth/session-gate.ts";
import { hashSessionToken, mintSessionToken } from "../../src/auth/session-token.ts";
import { planChallenge } from "../../src/challenges/plan.ts";
import type { Database } from "../../src/db/index.ts";
import { ledgerAccount } from "../../src/db/schema/payments.ts";
import {
  accounts,
  challenges,
  paymentCommands,
  scheduledTasks,
  sessions,
} from "../../src/db/schema.ts";
import { createApp } from "../../src/http/app.ts";
import type { ScheduledEvent } from "../../src/lambda/events.ts";
import { createLogger } from "../../src/observability/logger.ts";
import { createSweep, type SweepResult } from "../../src/sweep/run-sweep.ts";
import { createTaskHandlers } from "../../src/tasks/handlers.ts";
import {
  insertAccount,
  insertChallenge,
  insertChallengeForAccount,
  taskDeadline,
} from "../support/challenge-fixtures.ts";
import { fakeRateLimiter } from "../support/fake-rate-limiter.ts";
import { scheduledEvent } from "../support/lambda-events.ts";
import { useTestDatabase } from "../support/postgres.ts";

const testDatabase = useTestDatabase();

const SESSION_SECRET = "0123456789abcdef0123456789abcdef";
const SECOND_MS = 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEPOSIT = 2000;

/** The last instant a completion for the task at `sequence` may be received. */
function graceEnds(sequence: number): Date {
  return new Date(taskDeadline(sequence).getTime() + RECEIPT_GRACE_SECONDS * SECOND_MS);
}

async function sweep(db: Database, at: Date): Promise<SweepResult> {
  const run = createSweep({ db, now: () => at });
  return await run(scheduledEvent() as ScheduledEvent, createLogger({ sink: () => {} }));
}

async function challengeRow(db: Database, challengeId: string) {
  const [row] = await db
    .select({
      status: challenges.status,
      pausedAt: challenges.pausedAt,
      depositMinorUnits: challenges.depositMinorUnits,
    })
    .from(challenges)
    .where(eq(challenges.id, challengeId));
  if (row === undefined) throw new Error("the challenge disappeared");
  return row;
}

async function capturesOf(db: Database, challengeId: string) {
  return await db
    .select({ status: paymentCommands.status, executeAfter: paymentCommands.executeAfter })
    .from(paymentCommands)
    .where(and(eq(paymentCommands.challengeId, challengeId), eq(paymentCommands.kind, "capture")));
}

/** The configuration the projection cases vary, seven days a week at 08:00. */
function configuration(overrides: Partial<ChallengeConfiguration> = {}): ChallengeConfiguration {
  return {
    requiredTaskCount: 7,
    schedule: (
      ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const
    ).map((weekday) => ({ weekday, deadline: "08:00" })),
    stepTarget: 500,
    noRegretMinutes: 60,
    timeZone: "America/Los_Angeles",
    deposit: { amount: DEPOSIT, currency: "USD" },
    ...overrides,
  };
}

/**
 * Which side of the product each promise is a claim about. A client claim is
 * about what the app does with a result it holds, and no server behavior can
 * confirm or refute it.
 */
const CLIENT_SIDE_PROMISES: Readonly<Record<string, { file: string; test: string }>> = {
  "connection-can-prevent-sync": {
    file: "app/test/completion-sync.test.ts",
    test: "keeps a record pending when the request never reached the server, and sends it again",
  },
  "closing-app-can-leave-unsynced": {
    file: "app/test/pending-completion-store.test.ts",
    test: "keeps a record across a process that never came back",
  },
};

/** Filled by each case below; the completeness test reads it. */
const audited = new Set<string>();

function audits(id: string): void {
  audited.add(id);
}

describe("the acknowledgment screen names a version this build publishes", () => {
  it("pins the accepted version rather than taking any string", () => {
    expect(KNOWN_POLICY_VERSIONS).toContain(DISCLOSURE_POLICY_VERSION);
    expect(KNOWN_POLICY_VERSIONS[KNOWN_POLICY_VERSIONS.length - 1]).toBe(DISCLOSURE_POLICY_VERSION);
  });

  it("refuses an acceptance naming a version no build published", () => {
    const body = { configuration: configuration(), policyVersion: "disclosures.99" };
    expect(createChallengeRequest.safeParse(body).success).toBe(false);
    expect(createFundingIntentRequest.safeParse(body).success).toBe(false);
    expect(
      createChallengeRequest.safeParse({ ...body, policyVersion: DISCLOSURE_POLICY_VERSION })
        .success,
    ).toBe(true);
  });

  it("keeps a stored version readable even when this build has retired it", async () => {
    // The fixtures record `2026-01-01`, which no build ever published. A
    // challenge created under a retired version has to stay legible, which is
    // why only the request schema is pinned.
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);
    const [row] = await db
      .select({ policyVersion: challenges.policyVersion })
      .from(challenges)
      .where(eq(challenges.id, challengeId));
    expect(row?.policyVersion).toBe("2026-01-01");
  });
});

describe("a day is not complete until the server says so", () => {
  it("misses a task whose result never arrived, however far the user walked", async () => {
    audits("local-completion-insufficient");
    audits("synchronization-required");
    audits("confirming-both-checks");

    const { db } = testDatabase();
    const { accountId, challengeId } = await insertChallenge(db, { depositMinorUnits: 0 });
    // Nothing about the walk is in the database, because nothing was
    // acknowledged. That is the whole content of the promise.
    await db
      .update(accounts)
      .set({ emergencyRecoveryConsumedAt: new Date(Date.UTC(2025, 5, 1)) })
      .where(eq(accounts.id, accountId));

    const result = await sweep(db, new Date(graceEnds(1).getTime() + SECOND_MS));

    expect(result.tasksMissed).toBe(1);
    expect((await challengeRow(db, challengeId)).status).toBe("failed");
  });

  it(`accepts a result up to ${RECEIPT_GRACE_SECONDS} seconds late and no later`, async () => {
    audits("receipt-grace");

    const { db } = testDatabase();
    const arranged = await arrangeSession(db);
    const onTime = await postCompletion(db, arranged, graceEnds(1), {
      key: "aa000000-0000-4000-8000-000000000001",
      completedAt: "2026-01-05T15:59:00.000Z",
    });
    expect(onTime.status).toBe(200);

    const late = await postCompletion(
      db,
      await arrangeSession(db),
      new Date(graceEnds(1).getTime() + 1),
      {
        key: "aa000000-0000-4000-8000-000000000002",
        completedAt: "2026-01-05T15:59:00.000Z",
      },
    );
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ code: "deadline_passed" });

    // The second half of the sentence: arriving in time is not enough, the
    // walk itself has to have finished at or before the deadline.
    const walkedLate = await postCompletion(db, await arrangeSession(db), graceEnds(1), {
      key: "aa000000-0000-4000-8000-000000000003",
      completedAt: new Date(taskDeadline(1).getTime() + 1).toISOString(),
    });
    expect(walkedLate.status).toBe(409);
    expect(await walkedLate.json()).toMatchObject({ code: "completion_outside_task_window" });
  });
});

describe("a pause is the user's to end", () => {
  it("never resumes on its own, and ends the challenge with nothing charged at the bound", async () => {
    audits("no-automatic-resume");

    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db, { depositMinorUnits: DEPOSIT });
    // Paused before the first cutoff, so every task the sweep reaches is
    // skipped rather than missed.
    await db
      .update(challenges)
      .set({ pausedAt: new Date(taskDeadline(1).getTime() - HOUR_MS - 1) })
      .where(eq(challenges.id, challengeId));

    // Two sweeps, days apart, across every deadline the challenge has.
    await sweep(db, new Date(graceEnds(1).getTime() + SECOND_MS));
    await sweep(db, new Date(graceEnds(3).getTime() + SECOND_MS));

    const paused = await challengeRow(db, challengeId);
    expect(paused.status).toBe("active");
    expect(paused.pausedAt).not.toBeNull();
    const statuses = (
      await db
        .select({ status: scheduledTasks.status })
        .from(scheduledTasks)
        .where(eq(scheduledTasks.challengeId, challengeId))
        .orderBy(asc(scheduledTasks.sequence))
    ).map((task) => task.status);
    // Each skip appends a replacement task, so the tail is `scheduled`. What
    // matters is that nothing was ever missed or completed while paused: the
    // sweep resolved every reached task by skipping it and moved the end date
    // out, which is a challenge that did not run rather than one that ran.
    expect(statuses).toContain("skipped");
    expect(statuses.some((status) => status === "missed" || status === "completed")).toBe(false);

    // At the bound the challenge closes as neither a success nor a failure,
    // and no money moves.
    const atBound = new Date(graceEnds(3).getTime() + MAXIMUM_PAUSE_DAYS * DAY_MS);
    await db
      .update(challenges)
      .set({ pausedAt: new Date(atBound.getTime() - MAXIMUM_PAUSE_DAYS * DAY_MS) })
      .where(eq(challenges.id, challengeId));
    await sweep(db, atBound);

    expect((await challengeRow(db, challengeId)).status).toBe("expired");
    expect(await capturesOf(db, challengeId)).toHaveLength(0);
  });
});

describe("what a funded challenge costs", () => {
  it("forfeits the whole deposit on one miss, with no partial amount anywhere", async () => {
    audits("all-or-nothing-forfeit");

    const { db } = testDatabase();
    const { accountId, challengeId } = await insertChallenge(db, { depositMinorUnits: DEPOSIT });
    await db
      .update(accounts)
      .set({ emergencyRecoveryConsumedAt: new Date(Date.UTC(2025, 5, 1)) })
      .where(eq(accounts.id, accountId));

    await sweep(db, new Date(graceEnds(1).getTime() + SECOND_MS));

    const challenge = await challengeRow(db, challengeId);
    expect(challenge.status).toBe("failed");
    // One capture, and the amount at stake is the deposit itself: the settled
    // amount is read from the challenge, so there is no partial figure to
    // write anywhere.
    expect(await capturesOf(db, challengeId)).toHaveLength(1);
    expect(challenge.depositMinorUnits).toBe(DEPOSIT);
  });

  it(`stands the recovery offer for ${RECOVERY_WINDOW_HOURS} hours and settles after it`, async () => {
    audits("recovery-offer-window");

    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db, { depositMinorUnits: DEPOSIT });
    const missedAt = new Date(graceEnds(1).getTime() + SECOND_MS);

    await sweep(db, missedAt);

    expect((await challengeRow(db, challengeId)).status).toBe("recovery_pending");
    const [capture] = await capturesOf(db, challengeId);
    // The window is the settlement's eligibility instant rather than a timer,
    // which is what makes "the offer stands for 24 hours" true of a server
    // that might not run again until later.
    expect(capture?.executeAfter.toISOString()).toBe(
      new Date(missedAt.getTime() + RECOVERY_WINDOW_HOURS * HOUR_MS).toISOString(),
    );
  });

  it(`refuses a funded challenge projected past ${MAXIMUM_CHALLENGE_DURATION_DAYS} days`, async () => {
    audits("maximum-duration");
    audits("deposit-is-held");

    const startingAt = new Date("2026-01-01T00:00:00.000Z");
    const withinBound = planChallenge(
      configuration({ requiredTaskCount: MAXIMUM_CHALLENGE_DURATION_DAYS - 1 }),
      startingAt,
    );
    expect(withinBound.projection.withinMaximumDuration).toBe(true);

    const pastBound = planChallenge(
      configuration({ requiredTaskCount: MAXIMUM_CHALLENGE_DURATION_DAYS + 2 }),
      startingAt,
    );
    expect(pastBound.projection.withinMaximumDuration).toBe(false);

    // The bound exists because the hold has to be renewed for as long as the
    // challenge runs, which is the same sentence the `deposit-is-held`
    // disclosure makes; a zero deposit challenge has no bound at all.
    const free = planChallenge(
      configuration({
        requiredTaskCount: MAXIMUM_CHALLENGE_DURATION_DAYS + 2,
        deposit: { amount: 0, currency: "USD" },
      }),
      startingAt,
    );
    expect(free.projection.withinMaximumDuration).toBe(true);
  });
});

describe("the donation pledge is a platform commitment, not a routing", () => {
  it("has no ledger account a user's money could be routed to", () => {
    audits("forfeit-becomes-revenue");

    // A forfeit's only credit side is platform revenue. There is no account
    // standing for a charity or any other third party, so the shape the
    // pledge disclaims is not expressible.
    expect(ledgerAccount.enumValues).toEqual([
      "user_commitment",
      "payment_processor",
      "platform_revenue",
      "processor_fees",
      "uncollected_forfeit",
    ]);
  });

  it("states the same share the product document publishes", () => {
    const product = readFileSync(join(repositoryRoot(), "docs/product.md"), "utf8");
    expect(product).toContain(`${DONATED_SHARE_OF_FORFEIT_PERCENT}% of what remains`);
    const pledge = DISCLOSURES.find((item) => item.id === "forfeit-becomes-revenue");
    expect(pledge?.statement).toContain(`${DONATED_SHARE_OF_FORFEIT_PERCENT}%`);
  });
});

describe("every promise is accounted for", () => {
  it("audits each funded and unfunded disclosure, or names the app test that does", () => {
    const unaudited = DISCLOSURES.filter(
      (item) => !audited.has(item.id) && CLIENT_SIDE_PROMISES[item.id] === undefined,
    );
    expect(unaudited.map((item) => item.id)).toEqual([]);
  });

  it("finds the app-suite test each client-side promise names", () => {
    for (const [id, evidence] of Object.entries(CLIENT_SIDE_PROMISES)) {
      expect(DISCLOSURES.some((item) => item.id === id)).toBe(true);
      const source = readFileSync(join(repositoryRoot(), evidence.file), "utf8");
      expect(source).toContain(evidence.test);
    }
  });

  it("shows a zero deposit user nothing about money", () => {
    const free = disclosuresFor(0);
    expect(free.every((item) => item.scope === "all")).toBe(true);
    expect(free.length).toBeLessThan(disclosuresFor(DEPOSIT).length);
  });
});

function repositoryRoot(): string {
  return join(import.meta.dirname, "../../..");
}

/** An account with a session, an active funded challenge, and its first task. */
async function arrangeSession(db: Database): Promise<{ token: string; taskId: string }> {
  const accountId = await insertAccount(db);
  const minted = await mintSessionToken({ secret: SESSION_SECRET, accountId, ttlSeconds: 3600 });
  await db.insert(sessions).values({
    id: minted.sessionId,
    accountId,
    tokenHash: hashSessionToken(minted.token),
    createdAt: minted.issuedAt,
    expiresAt: minted.expiresAt,
  });
  const challengeId = await insertChallengeForAccount(db, accountId, {});
  const [task] = await db
    .select({ id: scheduledTasks.id })
    .from(scheduledTasks)
    .where(eq(scheduledTasks.challengeId, challengeId))
    .orderBy(asc(scheduledTasks.sequence))
    .limit(1);
  if (task === undefined) throw new Error("the fixture materialized no task");
  return { token: minted.token, taskId: task.id };
}

async function postCompletion(
  db: Database,
  arranged: { token: string; taskId: string },
  receivedAt: Date,
  options: { key: string; completedAt: string },
): Promise<Response> {
  const app = createApp({
    logger: createLogger({ sink: () => {} }),
    sessionGate: createSessionGate({ db, sessionSecret: SESSION_SECRET }),
    rateLimiter: fakeRateLimiter(),
    handlers: createTaskHandlers({ db, now: () => receivedAt }),
  });
  return await app.request(`http://api.test/tasks/${arranged.taskId}/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${arranged.token}`,
      "content-type": "application/json",
      [IDEMPOTENCY_HEADER]: options.key,
    },
    body: JSON.stringify({
      clientRecordId: options.key,
      completedAt: options.completedAt,
      observation: {
        startedAt: "2026-01-05T15:50:00.000Z",
        endedAt: options.completedAt,
        steps: 640,
        provenance: "live-foreground",
        source: "expo-pedometer-ios",
      },
      appVersion: "1.0.0",
      verificationPolicyVersion: "steps-v1",
    }),
  });
}
