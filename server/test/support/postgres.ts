/**
 * The test-facing half of the integration database harness. Runs in the test
 * worker, where `vitest` is available.
 */

import { afterEach, beforeEach, inject } from "vitest";

import {
  createTestDatabase,
  type PostgresHarness,
  type TestDatabase,
} from "./postgres-container.ts";

export type { PostgresHarness, TestDatabase } from "./postgres-container.ts";

declare module "vitest" {
  interface ProvidedContext {
    postgres: PostgresHarness;
  }
}

/**
 * Registers a fresh database around each test in the calling file and returns
 * an accessor for it.
 */
export function useTestDatabase(): () => TestDatabase {
  let current: (TestDatabase & { drop(): Promise<void> }) | undefined;

  beforeEach(async () => {
    current = await createTestDatabase(inject("postgres"));
  });

  afterEach(async () => {
    await current?.drop();
    current = undefined;
  });

  return () => {
    if (current === undefined) {
      throw new Error("useTestDatabase() was read outside a test.");
    }
    return current;
  };
}
