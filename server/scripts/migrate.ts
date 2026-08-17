/**
 * Applies every pending migration to the database named by `DATABASE_URL`.
 *
 * Run with plain `node`, which strips the types. Issue 39 calls this before the
 * function deploys.
 */

import { createDatabase, runMigrations } from "../src/db/index.ts";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const handle = createDatabase({ connectionString });
try {
  await runMigrations(handle);
  console.log(`Migrations applied via ${handle.driver}.`);
} finally {
  await handle.close();
}
