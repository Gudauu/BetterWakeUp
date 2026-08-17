/**
 * Writes the checked-in JSON Schema artifact.
 *
 * Run with `pnpm --filter @betterwakeup/contract run generate` after changing
 * any schema. The test suite fails while the artifact is stale.
 */

import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATED_SCHEMA_PATH, renderContractJsonSchema } from "../src/json-schema.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(packageRoot, GENERATED_SCHEMA_PATH);

await writeFile(target, renderContractJsonSchema(), "utf8");

process.stdout.write(`wrote ${GENERATED_SCHEMA_PATH}\n`);
