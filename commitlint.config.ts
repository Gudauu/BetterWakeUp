import type { UserConfig } from "@commitlint/types";

/**
 * Encodes the commit rules stated in CONTRIBUTING.md. Only the mechanical ones
 * live here: imperative grammar, rationale, and issue traceability are review
 * concerns, because no linter can judge them.
 */
const config: UserConfig = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "refactor", "test", "docs", "chore", "build", "ci", "perf"],
    ],
    "subject-full-stop": [2, "never", "."],
    "subject-case": [2, "never", ["pascal-case", "upper-case", "start-case"]],
    "header-max-length": [2, "always", 72],
    "body-max-line-length": [2, "always", 72],
    "footer-max-line-length": [2, "always", 72],
  },
};

export default config;
