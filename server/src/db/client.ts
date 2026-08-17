/**
 * Database connections.
 *
 * Production runs on Neon, whose serverless driver speaks WebSocket to the Neon
 * proxy and is the only Neon driver that can express a multi-statement
 * transaction. Integration tests run against a plain PostgreSQL container, which
 * that driver cannot reach, so the harness also supports node-postgres. Both are
 * the same Drizzle PostgreSQL dialect, so callers see one `Database` type and
 * never learn which driver they hold.
 */

import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import { WebSocket } from "ws";

import * as schema from "./schema.ts";

export type Schema = typeof schema;

/** A Drizzle handle over either driver. */
export type Database = PgDatabase<PgQueryResultHKT, Schema>;

export type DatabaseDriver = "neon-serverless" | "node-postgres";

export interface DatabaseConfig {
  /** A libpq connection string. */
  readonly connectionString: string;
  /** Defaults to the driver implied by the connection string's host. */
  readonly driver?: DatabaseDriver;
  /**
   * Maximum pooled connections. One is the right default on Lambda, where a
   * container handles one request at a time and idle sockets cost money.
   */
  readonly max?: number;
}

/** A database plus the means to release its sockets. */
export interface DatabaseHandle {
  readonly db: Database;
  readonly driver: DatabaseDriver;
  readonly connectionString: string;
  close(): Promise<void>;
}

/**
 * Neon hostnames are the only ones the serverless driver can reach, so the host
 * decides the driver unless a caller says otherwise.
 */
export function inferDriver(connectionString: string): DatabaseDriver {
  const host = safeHostname(connectionString);
  return host !== undefined && /(^|\.)neon\.tech$/.test(host) ? "neon-serverless" : "node-postgres";
}

export function createDatabase(config: DatabaseConfig): DatabaseHandle {
  const driver = config.driver ?? inferDriver(config.connectionString);
  const max = config.max ?? 1;

  if (driver === "neon-serverless") {
    // Node 22 has a global WebSocket, but the Lambda runtime's version of it is
    // not something this code should depend on, so the driver is given an
    // explicit implementation.
    neonConfig.webSocketConstructor = WebSocket;
    const pool = new NeonPool({ connectionString: config.connectionString, max });
    return {
      db: drizzleNeon({ client: pool, schema }),
      driver,
      connectionString: config.connectionString,
      close: () => pool.end(),
    };
  }

  const pool = new pg.Pool({ connectionString: config.connectionString, max });
  return {
    db: drizzleNodePostgres({ client: pool, schema }),
    driver,
    connectionString: config.connectionString,
    close: () => pool.end(),
  };
}

function safeHostname(connectionString: string): string | undefined {
  try {
    return new URL(connectionString).hostname;
  } catch {
    return undefined;
  }
}
