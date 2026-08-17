import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "server",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // The integration suite is its own project: it needs a database container,
    // which this one deliberately does not require.
    exclude: ["test/integration/**"],
    environment: "node",
  },
});
