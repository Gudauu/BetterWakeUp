import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "server-integration",
    include: ["test/integration/**/*.test.ts"],
    environment: "node",
    globalSetup: ["./test/support/global-setup.ts"],
    // Pulling and starting the container happens once, but it happens before
    // the first test can run.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
