import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "server", "server/vitest.integration.config.ts", "infra", "tools"],
  },
});
