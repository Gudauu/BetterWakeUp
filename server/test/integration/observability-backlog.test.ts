/**
 * Issue 38's two backlog levels, against real rows.
 *
 * Both are alarms about a state nothing is currently doing anything about, so
 * the only way to know they measure what the alarm claims is to build the state
 * and count it. Each section builds one row that should count and several that
 * look similar and should not: a deposit unsecured for an hour rather than a
 * day, a settlement command written moments ago, a command that already
 * settled. Those neighbours are the whole test, because a count that is too
 * eager pages somebody nightly until they mute it.
 */

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Database } from "../../src/db/index.ts";
import { challengeAuthorizations } from "../../src/db/schema/authorizations.ts";
import { paymentCommands } from "../../src/db/schema/payments.ts";
import { challenges } from "../../src/db/schema.ts";
import type { ScheduledEvent } from "../../src/lambda/events.ts";
import {
  measureBacklog,
  SETTLEMENT_LATENESS_TOLERANCE_MINUTES,
  UNSECURED_DEPOSIT_TOLERANCE_HOURS,
} from "../../src/observability/backlog.ts";
import { createLogger } from "../../src/observability/logger.ts";
import { createRecordingEmitter } from "../../src/observability/metrics.ts";
import { createSweep } from "../../src/sweep/run-sweep.ts";
import { insertChallenge } from "../support/challenge-fixtures.ts";
import { scheduledEvent } from "../support/lambda-events.ts";
import { useTestDatabase } from "../support/postgres.ts";

const testDatabase = useTestDatabase();

const NOW = new Date("2026-02-01T12:00:00.000Z");
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** A funded challenge whose deposit stopped being secured `hoursAgo`. */
async function unsecuredChallenge(
  db: Database,
  hoursAgo: number,
  overrides: { readonly depositMinorUnits?: number; readonly secured?: boolean } = {},
): Promise<string> {
  const { challengeId } = await insertChallenge(db, {
    depositMinorUnits: overrides.depositMinorUnits ?? 2000,
  });
  const endedAt = new Date(NOW.getTime() - hoursAgo * HOUR_MS);
  await db
    .update(challenges)
    .set({ depositSecured: overrides.secured ?? false })
    .where(eq(challenges.id, challengeId));
  await db.insert(challengeAuthorizations).values({
    challengeId,
    provider: "fake",
    providerAuthorizationId: `auth-${challengeId}`,
    amountMinorUnits: 2000,
    status: "released",
    authorizedAt: new Date(endedAt.getTime() - 7 * 24 * HOUR_MS),
    expiresAt: endedAt,
    endedAt,
    updatedAt: endedAt,
  });
  return challengeId;
}

async function pendingCommand(db: Database, minutesAgo: number, dedupeKey: string): Promise<void> {
  // A challenge that has already failed: the state a capture is written for,
  // and one the sweep will not write a second command for while this one is
  // still pending.
  const { challengeId } = await insertChallenge(db, { status: "failed" });
  await db.insert(paymentCommands).values({
    challengeId,
    kind: "capture",
    status: "pending",
    dedupeKey,
    executeAfter: new Date(NOW.getTime() - minutesAgo * MINUTE_MS),
  });
}

describe("deposits left unsecured", () => {
  it("counts a funded challenge unsecured for longer than a day", async () => {
    const { db } = testDatabase();
    await unsecuredChallenge(db, UNSECURED_DEPOSIT_TOLERANCE_HOURS + 1);

    const backlog = await measureBacklog({ db, now: NOW });

    expect(backlog.depositsUnsecuredOverADay).toBe(1);
  });

  it("does not count one that has only just become unsecured", async () => {
    const { db } = testDatabase();
    await unsecuredChallenge(db, 1);

    const backlog = await measureBacklog({ db, now: NOW });

    expect(backlog.depositsUnsecuredOverADay).toBe(0);
  });

  it("does not count a secured deposit, a zero deposit, or a finished challenge", async () => {
    const { db } = testDatabase();
    await unsecuredChallenge(db, 48, { secured: true });
    await unsecuredChallenge(db, 48, { depositMinorUnits: 0 });
    const finished = await unsecuredChallenge(db, 48);
    await db
      .update(challenges)
      .set({ status: "failed", terminalAt: NOW })
      .where(eq(challenges.id, finished));

    const backlog = await measureBacklog({ db, now: NOW });

    expect(backlog.depositsUnsecuredOverADay).toBe(0);
  });

  it("falls back to when the challenge was activated when it never had a hold", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);
    // Activated well before the fixture's own dates, and never authorized: a
    // funded challenge that was marked unsecured with no hold to date it from.
    await db
      .update(challenges)
      .set({ depositSecured: false })
      .where(eq(challenges.id, challengeId));

    const backlog = await measureBacklog({ db, now: NOW });

    expect(backlog.depositsUnsecuredOverADay).toBe(1);
  });
});

describe("settlement commands past their instant", () => {
  it("counts a pending command well past its eligibility instant", async () => {
    const { db } = testDatabase();
    await pendingCommand(db, SETTLEMENT_LATENESS_TOLERANCE_MINUTES + 30, "overdue-1");

    const backlog = await measureBacklog({ db, now: NOW });

    expect(backlog.overdueSettlementCommands).toBe(1);
  });

  it("does not count one the running sweep could still be executing", async () => {
    const { db } = testDatabase();
    await pendingCommand(db, 5, "recent-1");

    const backlog = await measureBacklog({ db, now: NOW });

    expect(backlog.overdueSettlementCommands).toBe(0);
  });

  it("does not count a command that already settled", async () => {
    const { db } = testDatabase();
    const { challengeId } = await insertChallenge(db);
    await db.insert(paymentCommands).values({
      challengeId,
      kind: "capture",
      status: "confirmed",
      dedupeKey: "settled-1",
      providerReference: "provider-1",
      executeAfter: new Date(NOW.getTime() - 5 * HOUR_MS),
      settledAt: new Date(NOW.getTime() - 4 * HOUR_MS),
    });

    const backlog = await measureBacklog({ db, now: NOW });

    expect(backlog.overdueSettlementCommands).toBe(0);
  });
});

describe("what a sweep publishes", () => {
  it("publishes both backlog levels on every run, including when they are zero", async () => {
    const { db } = testDatabase();
    const metrics = createRecordingEmitter();
    const run = createSweep({ db, now: () => NOW, metrics });

    await run(scheduledEvent() as ScheduledEvent, createLogger({ sink: () => {} }));

    expect(metrics.observations).toEqual([
      { name: "DepositsUnsecuredOverADay", value: 0 },
      { name: "OverdueSettlementCommands", value: 0 },
    ]);
  });

  it("publishes the backlog it found", async () => {
    const { db } = testDatabase();
    await unsecuredChallenge(db, 48);
    await pendingCommand(db, 5 * 60, "overdue-2");
    const metrics = createRecordingEmitter();
    const run = createSweep({ db, now: () => NOW, metrics });

    await run(scheduledEvent() as ScheduledEvent, createLogger({ sink: () => {} }));

    expect(metrics.total("DepositsUnsecuredOverADay")).toBe(1);
    expect(metrics.total("OverdueSettlementCommands")).toBe(1);
  });

  it("counts a sweep that failed and rethrows rather than reporting a drained backlog", async () => {
    const { db } = testDatabase();
    const metrics = createRecordingEmitter();
    const run = createSweep({
      db,
      metrics,
      now: () => {
        throw new Error("clock exploded");
      },
    });

    await expect(
      run(scheduledEvent() as ScheduledEvent, createLogger({ sink: () => {} })),
    ).rejects.toThrow("clock exploded");
    expect(metrics.total("SweepFailures")).toBe(1);
  });
});
