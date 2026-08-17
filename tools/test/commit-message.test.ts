import { fileURLToPath } from "node:url";
import lint from "@commitlint/lint";
import load from "@commitlint/load";
import { beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

type Linted = { valid: boolean; ruleNames: string[] };

let check: (message: string) => Promise<Linted>;

beforeAll(async () => {
  const { rules, parserPreset } = await load({}, { cwd: repositoryRoot });

  check = async (message) => {
    const report = await lint(
      message,
      rules,
      parserPreset?.parserOpts ? { parserOpts: parserPreset.parserOpts } : {},
    );
    return { valid: report.valid, ruleNames: report.errors.map((error) => error.name) };
  };
});

describe("commit message rules", () => {
  it("accepts the example from the contributing guide", async () => {
    const message = [
      "feat(catalog): filter food items by multiple categories",
      "",
      "Selections are additive, while an empty selection means no filter.",
      "",
      "Refs #4",
    ].join("\n");

    await expect(check(message)).resolves.toMatchObject({ valid: true });
  });

  it("rejects a subject that is not a conventional commit", async () => {
    const { valid, ruleNames } = await check("filter food items by category");

    expect(valid).toBe(false);
    expect(ruleNames).toContain("subject-empty");
  });

  it("rejects a type outside the allowed list", async () => {
    const { valid, ruleNames } = await check("wip(catalog): filter food items");

    expect(valid).toBe(false);
    expect(ruleNames).toContain("type-enum");
  });

  it("rejects a trailing period in the subject", async () => {
    const { valid, ruleNames } = await check("feat(catalog): filter food items.");

    expect(valid).toBe(false);
    expect(ruleNames).toContain("subject-full-stop");
  });

  it("rejects a body line wider than 72 columns", async () => {
    const message = ["docs: describe the sweep", "", "x".repeat(73)].join("\n");
    const { valid, ruleNames } = await check(message);

    expect(valid).toBe(false);
    expect(ruleNames).toContain("body-max-line-length");
  });

  it("rejects a subject longer than 72 columns", async () => {
    const { valid, ruleNames } = await check(`feat: ${"x".repeat(70)}`);

    expect(valid).toBe(false);
    expect(ruleNames).toContain("header-max-length");
  });
});
