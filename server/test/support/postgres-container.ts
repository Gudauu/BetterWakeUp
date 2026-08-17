/**
 * The container half of the integration database harness.
 *
 * One PostgreSQL container is started for the whole run and migrations are
 * applied once, to a template database that every test copies. This module runs
 * in the global setup context, which is a different process context from the
 * test workers, so it must not import `vitest` itself.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";

import { createDatabase, type DatabaseHandle, runMigrations } from "../../src/db/index.ts";

/** Pinned so a container image change is a reviewed change. */
export const POSTGRES_IMAGE = "postgres:17-alpine";

/** The migrated database every test database is copied from. */
export const TEMPLATE_DATABASE = "betterwakeup_template";

export interface PostgresHarness {
  /** A connection string against the container's default database. */
  readonly adminConnectionString: string;
}

export interface StartedHarness extends PostgresHarness {
  stop(): Promise<void>;
}

/**
 * Starts the container and migrates the template database. Called once per run
 * from the global setup, never from a test.
 */
export async function startPostgresHarness(): Promise<StartedHarness> {
  let container: StartedPostgreSqlContainer;
  try {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).withDatabase("betterwakeup").start();
  } catch (cause) {
    throw new Error(
      "Could not start the PostgreSQL test container. The integration suite needs a running Docker daemon.",
      { cause },
    );
  }

  const adminConnectionString = container.getConnectionUri();

  try {
    await withAdminClient(adminConnectionString, async (client) => {
      await client.query(`CREATE DATABASE ${quoteIdentifier(TEMPLATE_DATABASE)}`);
    });

    const template = createDatabase({
      connectionString: databaseUrl(adminConnectionString, TEMPLATE_DATABASE),
    });
    try {
      await runMigrations(template);
    } finally {
      await template.close();
    }
  } catch (error) {
    await container.stop();
    throw error;
  }

  return {
    adminConnectionString,
    async stop() {
      await container.stop();
    },
  };
}

export interface TestDatabase {
  /** A handle on this test's own database. */
  readonly handle: DatabaseHandle;
  readonly db: DatabaseHandle["db"];
  readonly connectionString: string;
  /**
   * Opens an additional connection to the same database, for tests that need
   * two sessions competing over the same rows. Closed with the test database.
   */
  connect(): DatabaseHandle;
}

let sequence = 0;

/** Copies the migrated template into a database nothing else touches. */
export async function createTestDatabase(
  harness: PostgresHarness,
): Promise<TestDatabase & { drop(): Promise<void> }> {
  sequence += 1;
  // The process id keeps parallel test workers from colliding on a name.
  const name = `betterwakeup_test_${process.pid}_${sequence}`;
  await withAdminClient(harness.adminConnectionString, async (client) => {
    await client.query(
      `CREATE DATABASE ${quoteIdentifier(name)} TEMPLATE ${quoteIdentifier(TEMPLATE_DATABASE)}`,
    );
  });

  const connectionString = databaseUrl(harness.adminConnectionString, name);
  const handle = createDatabase({ connectionString });
  const extra: DatabaseHandle[] = [];

  return {
    handle,
    db: handle.db,
    connectionString,
    connect() {
      const additional = createDatabase({ connectionString });
      extra.push(additional);
      return additional;
    },
    async drop() {
      await Promise.all([handle.close(), ...extra.map((each) => each.close())]);
      await withAdminClient(harness.adminConnectionString, async (client) => {
        await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`);
      });
    },
  };
}

async function withAdminClient(
  connectionString: string,
  use: (client: pg.Client) => Promise<void>,
): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await use(client);
  } finally {
    await client.end();
  }
}

function databaseUrl(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
