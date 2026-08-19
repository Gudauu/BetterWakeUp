import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "server",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // The integration suite is its own project: it needs a database container,
    // which this one deliberately does not require.
    exclude: ["test/integration/**"],
    environment: "node",
    /**
     * Planning a year-long challenge resolves 365 local deadlines, and each
     * one probes every zone offset in the IANA range through Luxon: about 1.7
     * seconds a case on an idle laptop, and past the default 5 second timeout
     * once the rest of the workspace's suites are running beside it. The
     * number bounds a hang; it is not a performance budget.
     */
    testTimeout: 30_000,
  },
});
