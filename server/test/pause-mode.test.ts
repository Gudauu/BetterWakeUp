/**
 * The one part of issue 21 no request can demonstrate: nothing resumes a
 * challenge except a user asking for it.
 *
 * A pause has no limit and no expiry, so the failure this guards against is not
 * a wrong answer to a request. It is a second writer somewhere in the server
 * clearing `paused_at` on the user's behalf, which no test that sends requests
 * would ever see, because the user never sent one. What can be established is
 * that exactly one module writes that clearing at all, and which one it is.
 *
 * A source scan is a blunt instrument and it is the right shape here: the claim
 * is about the whole server rather than about a code path, and the alternative
 * (a column-level database trigger allowing the clear only from one caller) has
 * no way to name a caller.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = join(import.meta.dirname, "..", "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("leaving pause mode", () => {
  it("is written by the resume command and by nothing else", async () => {
    const clearing = sourceFiles(SOURCE_ROOT).filter((path) =>
      /pausedAt:\s*null/.test(readFileSync(path, "utf8")),
    );

    expect(clearing.map((path) => path.slice(SOURCE_ROOT.length + 1))).toEqual([
      join("challenges", "pause.ts"),
    ]);
  });

  it("is written by a command the contract mounts, rather than by the sweep", async () => {
    // The scan above says one file clears the mode. This says which door that
    // file is behind: a request the user sends, not a pass the server runs on
    // its own. The sweep's one pause-related power is expiring a challenge that
    // has been paused for a year, and expiring is not resuming.
    const source = readFileSync(join(SOURCE_ROOT, "challenges", "pause.ts"), "utf8");

    expect(source).toMatch(/commandType: "resumeChallenge"/);
  });
});
