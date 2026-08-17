import type { TestProject } from "vitest/node";

import { startPostgresHarness } from "./postgres-container.ts";

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const harness = await startPostgresHarness();
  project.provide("postgres", { adminConnectionString: harness.adminConnectionString });
  return async () => {
    await harness.stop();
  };
}
