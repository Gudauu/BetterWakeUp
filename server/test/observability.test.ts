import { describe, expect, it } from "vitest";
import { createLogger } from "../src/observability/logger.ts";
import { scrub } from "../src/observability/redact.ts";

const AT = new Date("2026-08-17T09:00:00.000Z");

function capture() {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    logger: createLogger({ sink: (line) => lines.push(JSON.parse(line)), now: () => AT }),
  };
}

describe("the logger", () => {
  it("writes one JSON object per line with a timestamp and level", () => {
    const { logger, lines } = capture();

    logger.info("challenge started", { accountId: "a", challengeId: "b", result: "created" });

    expect(lines).toEqual([
      {
        timestamp: "2026-08-17T09:00:00.000Z",
        level: "info",
        message: "challenge started",
        accountId: "a",
        challengeId: "b",
        result: "created",
      },
    ]);
  });

  it("carries a child's fields on every line, with the call site winning", () => {
    const { logger, lines } = capture();

    const request = logger.child({ requestId: "r1", command: "createCompletion" });
    request.warn("rejected", { command: "createChallenge", result: "conflict" });

    expect(lines[0]).toMatchObject({
      requestId: "r1",
      command: "createChallenge",
      result: "conflict",
    });
  });

  it("drops undefined fields rather than writing nulls", () => {
    const { logger, lines } = capture();

    logger.info("hello", { accountId: undefined, taskId: "t" });

    expect(Object.keys(lines[0] ?? {})).toEqual(["timestamp", "level", "message", "taskId"]);
  });

  it("filters by level", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "warn", sink: (line) => lines.push(line) });

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(lines.map((line) => JSON.parse(line).level)).toEqual(["warn", "error"]);
  });

  it("scrubs both the message and every string field", () => {
    const { logger, lines } = capture();

    logger.error("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln rejected", {
      // Nothing should ever put a credential in a field, so the point of this
      // is that the second net holds if something does.
      result: "Bearer sk-live-0123456789abcdef",
    });

    expect(lines[0]?.message).toBe("token [redacted:jwt] rejected");
    expect(lines[0]?.result).toBe("Bearer [redacted]");
  });
});

describe("scrubbing", () => {
  it("removes JSON Web Tokens, including short ones", () => {
    expect(scrub("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.c2lnbmF0dXJl")).toBe("[redacted:jwt]");
    expect(scrub("eyJhIjoxfQ.eyJiIjoyfQ.c2ln")).toBe("[redacted:jwt]");
  });

  it("leaves a dotted name that is not a token alone", () => {
    expect(scrub("failed to read tsconfig.base.json")).toBe("failed to read tsconfig.base.json");
  });

  it("removes an Authorization header value but keeps the scheme", () => {
    expect(scrub("sent Authorization: Bearer abc123def")).toBe(
      "sent Authorization: Bearer [redacted]",
    );
  });

  it("removes card numbers with or without separators", () => {
    expect(scrub("card 4242424242424242 declined")).toBe("card [redacted:pan] declined");
    expect(scrub("card 4242 4242 4242 4242 declined")).toBe("card [redacted:pan] declined");
  });

  it("removes long opaque secrets", () => {
    expect(scrub("key whsec_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")).toBe("key [redacted:secret]");
  });

  it("keeps resource identifiers, which are the point of a log line", () => {
    const line = "account 0d2f6a51-6e5f-4a1e-9a63-2a6b9f1c7e40 has no challenge";
    expect(scrub(line)).toBe(line);
  });

  it("keeps an all-digit identifier the card rule would otherwise eat", () => {
    const line = "task 12345678-1234-4234-8234-123456789012 missed";
    expect(scrub(line)).toBe(line);
  });

  it("leaves ordinary prose and short values alone", () => {
    const line = "challenge 7 of 30, deposit 2500 minor units, at 2026-08-17T09:00:00.000Z";
    expect(scrub(line)).toBe(line);
  });
});
