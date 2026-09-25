/**
 * Migrations applied to a database that already holds rows.
 *
 * Every other integration test copies a template migrated while empty, so a
 * migration that only fails over existing data passes the whole suite and is
 * first seen by the deployed database. Migration 0011 was that migration: its
 * backfill fires the deferred task count trigger, and the `ALTER TABLE` after
 * it in the same transaction was refused for the pending trigger events.
 *
 * Each case migrates an empty database to just before the migration under
 * test, writes rows in the shape the schema had then, and applies the rest.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { executeRows } from "../../src/db/index.ts";
import { MIGRATIONS_FOLDER, runMigrations } from "../../src/db/migrate.ts";
import { useTestDatabase } from "../support/postgres.ts";

const testDatabase = useTestDatabase({ empty: true });

interface Journal {
  readonly entries: readonly { readonly tag: string }[];
}

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/**
 * A copy of the migration folder whose journal stops before `tag`, so the
 * migrator applies everything up to it and nothing after.
 */
function migrationsBefore(tag: string): string {
  const folder = mkdtempSync(join(tmpdir(), "betterwakeup-migrations-"));
  folders.push(folder);
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
  const path = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(path, "utf8")) as Journal;
  const index = journal.entries.findIndex((entry) => entry.tag === tag);
  if (index < 0) throw new Error(`no migration tagged ${tag}`);
  writeFileSync(path, JSON.stringify({ ...journal, entries: journal.entries.slice(0, index) }));
  return folder;
}

describe("0011_walk_window over existing challenges", () => {
  it("backfills the window and every task's opening instant", async () => {
    const { handle, db } = testDatabase();
    await runMigrations(handle, migrationsBefore("0011_walk_window"));

    // One active challenge whose second deadline falls five minutes after
    // the first, so the backfill has a previous deadline to respect.
    await db.transaction(async (tx) => {
      const [account] = await executeRows<{ id: string }>(
        tx,
        sql`insert into accounts default values returning id`,
      );
      const [challenge] = await executeRows<{ id: string }>(
        tx,
        sql`insert into challenges
              (account_id, status, required_task_count, step_target, no_regret_minutes,
               time_zone, deposit_minor_units, policy_version, projected_end_date, activated_at)
            values (${account?.id}, 'active', 3, 500, 0, 'America/Los_Angeles', 0,
                    'disclosures.2', '2026-01-07', '2026-01-01T00:00:00Z')
            returning id`,
      );
      await tx.execute(sql`
        insert into scheduled_tasks (challenge_id, sequence, task_date, deadline, pause_cutoff)
        values
          (${challenge?.id}, 1, '2026-01-05', '2026-01-06T07:50:00Z', '2026-01-06T07:50:00Z'),
          (${challenge?.id}, 2, '2026-01-06', '2026-01-06T07:55:00Z', '2026-01-06T07:55:00Z'),
          (${challenge?.id}, 3, '2026-01-07', '2026-01-07T16:00:00Z', '2026-01-07T16:00:00Z')
      `);
    });

    await runMigrations(handle);

    const challenges = await executeRows<{ walk_window_minutes: number }>(
      db,
      sql`select walk_window_minutes from challenges`,
    );
    expect(challenges).toEqual([{ walk_window_minutes: 10 }]);
    const tasks = await executeRows<{ opens_at: Date }>(
      db,
      sql`select opens_at from scheduled_tasks order by sequence`,
    );
    expect(tasks.map((task) => new Date(task.opens_at).toISOString())).toEqual([
      "2026-01-06T07:40:00.000Z",
      // Ten minutes before 07:55 is 07:45, before the first deadline.
      "2026-01-06T07:50:00.000Z",
      "2026-01-07T15:50:00.000Z",
    ]);
  });
});

describe("0012_abandoned_and_deleted_challenges over existing challenges", () => {
  /**
   * One challenge per status the schema had before 0012, each on its own
   * account because an account holds one open challenge at a time.
   */
  async function insertEveryStatus(db: ReturnType<typeof testDatabase>["db"]) {
    const statuses = ["active", "recovery_pending", "succeeded", "failed", "expired"] as const;
    const ids: Record<(typeof statuses)[number], string> = {
      active: "",
      recovery_pending: "",
      succeeded: "",
      failed: "",
      expired: "",
    };
    for (const status of statuses) {
      await db.transaction(async (tx) => {
        const [account] = await executeRows<{ id: string }>(
          tx,
          sql`insert into accounts default values returning id`,
        );
        const terminal = status === "succeeded" || status === "failed" || status === "expired";
        const [challenge] = await executeRows<{ id: string }>(
          tx,
          sql`insert into challenges
                (account_id, status, required_task_count, step_target, no_regret_minutes,
                 walk_window_minutes, time_zone, deposit_minor_units, policy_version,
                 projected_end_date, activated_at, terminal_at)
              values (${account?.id}, ${status}, 1, 500, 0, 10, 'America/Los_Angeles', 2000,
                      'disclosures.2', '2026-01-05', '2026-01-01T00:00:00Z',
                      ${terminal ? "2026-01-06T00:00:00Z" : null})
              returning id`,
        );
        const taskStatus =
          status === "succeeded"
            ? "completed"
            : status === "recovery_pending"
              ? "missed"
              : "scheduled";
        await tx.execute(sql`
          insert into scheduled_tasks
            (challenge_id, sequence, task_date, deadline, pause_cutoff, opens_at, status,
             acknowledged_at, missed_at)
          values (${challenge?.id}, 1, '2026-01-05', '2026-01-05T16:00:00Z',
                  '2026-01-05T16:00:00Z', '2026-01-05T15:50:00Z', ${taskStatus},
                  ${taskStatus === "completed" ? "2026-01-05T15:55:00Z" : null},
                  ${taskStatus === "missed" ? "2026-01-05T16:01:00Z" : null})
        `);
        ids[status] = challenge?.id ?? "";
      });
    }
    return ids;
  }

  it("keeps every existing challenge and lets them end and be deleted under the new rules", async () => {
    const { handle, db } = testDatabase();
    await runMigrations(handle, migrationsBefore("0012_abandoned_and_deleted_challenges"));
    const ids = await insertEveryStatus(db);

    await runMigrations(handle);

    const rows = await executeRows<{ status: string; deleted_at: Date | null }>(
      db,
      sql`select status::text as status, deleted_at from challenges order by status`,
    );
    expect(rows).toEqual([
      { status: "active", deleted_at: null },
      { status: "expired", deleted_at: null },
      { status: "failed", deleted_at: null },
      { status: "recovery_pending", deleted_at: null },
      { status: "succeeded", deleted_at: null },
    ]);

    // The value the migration added is usable once it has committed, from both
    // statuses that hold an account's slot.
    for (const id of [ids.active, ids.recovery_pending]) {
      await db.execute(
        sql`update challenges set status = 'abandoned', terminal_at = now() where id = ${id}`,
      );
    }
    await db.execute(sql`update challenges set deleted_at = now() where id = ${ids.failed}`);

    const ended = await executeRows<{ status: string }>(
      db,
      sql`select status::text as status from challenges
          where id in (${ids.active}, ${ids.recovery_pending}) order by status`,
    );
    expect(ended).toEqual([{ status: "abandoned" }, { status: "abandoned" }]);
  });
});
