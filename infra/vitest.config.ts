import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "infra",
    include: ["test/**/*.test.ts"],
    environment: "node",
    /**
     * The first `Template.fromStack` in a file pays for CDK's construct tree
     * and its JSON schema loading, which is 6 to 10 seconds on a laptop and
     * more when the rest of the workspace's suites are running beside it.
     * Every later synth in the same file is a few hundred milliseconds, so the
     * default 5 second timeout failed exactly one test per file and nothing
     * else. The number bounds a hang; it is not a performance budget.
     */
    testTimeout: 60_000,
  },
});
