/**
 * Migration application.
 *
 * The migration folder is the description of the database: `drizzle-kit
 * generate` writes it from the schema, and nothing applies SQL to a real
 * database except this function, so development, tests, and deployment all
 * arrive at the same shape.
 */

import { fileURLToPath } from "node:url";
import { migrate as migrateNeon } from "drizzle-orm/neon-serverless/migrator";
import { migrate as migrateNodePostgres } from "drizzle-orm/node-postgres/migrator";

import type { DatabaseHandle } from "./client.ts";

/** Where `drizzle-kit generate` writes, per `drizzle.config.ts`. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function runMigrations(
  handle: DatabaseHandle,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<void> {
  // The two migrators differ only in the driver they expect, and the union in
  // `Database` is not narrowable from the value, so the driver tag chooses.
  if (handle.driver === "neon-serverless") {
    // biome-ignore lint/suspicious/noExplicitAny: the migrator is typed to its own driver's database.
    await migrateNeon(handle.db as any, { migrationsFolder });
    return;
  }
  // biome-ignore lint/suspicious/noExplicitAny: the migrator is typed to its own driver's database.
  await migrateNodePostgres(handle.db as any, { migrationsFolder });
}
