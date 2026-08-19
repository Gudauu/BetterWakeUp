/**
 * When a challenge ended, and what ended it.
 *
 * `lastEnded` carries `endedAt` and a terminal status, and the card home draws
 * from it named neither: a user opening the app to a charged deposit was told
 * how many mornings they had done and nothing about which morning cost them the
 * rest. These pin both sentences, including that the instant is read in the
 * zone it is given rather than the machine's.
 */

import { MAXIMUM_PAUSE_DAYS } from "@betterwakeup/contract";
import { endedCauseText, endedReading, endedWhenText } from "../src/challenges/ended-challenge.ts";
import { endedChallenge } from "./support/fake-api.ts";

describe("when the challenge ended", () => {
  it("names the day and the time, read in the zone it is given", () => {
    const ended = endedChallenge({ endedAt: "2026-10-12T14:00:00.000Z" });

    expect(endedWhenText(ended, "America/Los_Angeles")).toBe("Ended Mon, Oct 12, 7:00 AM.");
  });

  it("reads the same instant as a different morning in a different zone", () => {
    // The summary carries no zone of its own, so the phone's is the only clock
    // the reader is holding - and it is a different day either side of a date
    // line, which is why the zone is a parameter rather than a default.
    const ended = endedChallenge({ endedAt: "2026-10-12T14:00:00.000Z" });

    expect(endedWhenText(ended, "Asia/Tokyo")).toBe("Ended Mon, Oct 12, 11:00 PM.");
  });

  it("falls back to the raw instant rather than the wrong time when the zone is unreadable", () => {
    const ended = endedChallenge({ endedAt: "2026-10-12T14:00:00.000Z" });

    expect(endedWhenText(ended, "Not/AZone")).toContain("2026-10-12T14:00:00.000Z");
  });
});

describe("what ended the challenge", () => {
  it("says a missed morning ends it, which no other line on the card does", () => {
    expect(endedCauseText(endedChallenge({ status: "failed" }))).toBe(
      "A morning went by with no walk saved in time, and one missed morning ends a challenge.",
    );
  });

  it("names the pause limit an expired challenge reached, and that it is not a failure", () => {
    const cause = endedCauseText(endedChallenge({ status: "expired" }));

    expect(cause).toContain(`${MAXIMUM_PAUSE_DAYS} days`);
    expect(cause).toContain("neither a success nor a failure");
  });

  it("says a success was every morning, saved in time", () => {
    expect(endedCauseText(endedChallenge({ status: "succeeded" }))).toBe(
      "Every morning it asked for was walked and saved before its deadline.",
    );
  });
});

describe("the ending as a whole", () => {
  it("answers both questions at once, so a caller cannot draw one and forget the other", () => {
    const ended = endedChallenge({ status: "failed", endedAt: "2026-10-12T14:00:00.000Z" });

    expect(endedReading(ended, "UTC")).toEqual({
      when: endedWhenText(ended, "UTC"),
      cause: endedCauseText(ended),
    });
  });
});
