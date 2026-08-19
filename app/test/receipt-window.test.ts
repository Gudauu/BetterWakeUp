/**
 * The clock on a walk that is walked but unsent.
 *
 * The server takes a completion until the task's deadline plus a sixty second
 * receipt grace and refuses it after that, so a record sitting in the store has
 * a deadline of its own. Both screens used to draw the morning's countdown over
 * it - "left to walk", to a walker who had already walked - and neither of them
 * had the grace in the number.
 */

import {
  RECEIPT_CLOSING_MINUTES,
  receiptGoneText,
  receiptWindow,
} from "../src/completions/receipt-window.ts";

const ZONE = "America/Los_Angeles";
/** 7:00 AM in Los Angeles, the deadline every other test in the app uses. */
const DEADLINE = "2026-09-01T14:00:00.000Z";

describe("how long a saved walk still has", () => {
  it("counts to the deadline plus the server's receipt grace, not to the deadline", () => {
    // 14:00:30 is past the deadline and still inside the grace, so there is a
    // window left rather than none: the countdown a screen draws here has to
    // be the record's, which the morning's countdown had already given up on.
    const window = receiptWindow(DEADLINE, ZONE, new Date("2026-09-01T14:00:30.000Z"));

    expect(window?.urgency).toBe("closing");
    expect(window?.minutes).toBe(0);
    expect(window?.closesAt).toBe("7:01 AM");
  });

  it("names the closing time in the challenge's own zone", () => {
    const window = receiptWindow(DEADLINE, "Europe/London", new Date("2026-09-01T12:00:00.000Z"));

    expect(window?.closesAt).toBe("3:01 PM");
  });

  it("reads quietly while there is a morning left to send it in", () => {
    const window = receiptWindow(DEADLINE, ZONE, new Date("2026-09-01T12:00:00.000Z"));

    expect(window?.urgency).toBe("ample");
    expect(window?.minutes).toBe(121);
    expect(window?.sentence).toBe(
      "2 hours 1 minute left for this walk to reach BetterWakeUp - it stops counting at 7:01 AM.",
    );
  });

  it("turns urgent at the last call's own lead time and not before", () => {
    const atBoundary = new Date(Date.parse(DEADLINE) + 60_000 - RECEIPT_CLOSING_MINUTES * 60_000);
    const justBefore = new Date(atBoundary.getTime() - 60_000);

    expect(receiptWindow(DEADLINE, ZONE, atBoundary)?.urgency).toBe("closing");
    expect(receiptWindow(DEADLINE, ZONE, justBefore)?.urgency).toBe("ample");
  });

  it("says less than a minute rather than counting to zero", () => {
    const window = receiptWindow(DEADLINE, ZONE, new Date("2026-09-01T14:00:59.000Z"));

    expect(window?.sentence).toBe(
      "Less than a minute left for this walk to reach BetterWakeUp - it stops counting at 7:01 AM.",
    );
  });

  it("reports the window as gone once the grace has passed", () => {
    const window = receiptWindow(DEADLINE, ZONE, new Date("2026-09-01T14:01:01.000Z"));

    expect(window?.urgency).toBe("gone");
    expect(window?.minutes).toBe(0);
    expect(window?.sentence).toBe(
      "The time for this walk to reach BetterWakeUp ran out at 7:01 AM.",
    );
  });

  it("answers nothing for a deadline it cannot read", () => {
    expect(receiptWindow("not an instant", ZONE, new Date("2026-09-01T12:00:00.000Z"))).toBeNull();
  });
});

describe("what is said once the window has closed", () => {
  it("names the moment, stops short of calling the day lost, and promises no offer", () => {
    const text = receiptGoneText("7:01 AM");

    expect(text).toContain("did not reach BetterWakeUp by 7:01 AM");
    expect(text).toContain("no longer count for today");
    // The record only leaves the store when the server answers, so it is still
    // being sent even though it can no longer buy the morning.
    expect(text).toContain("still being sent");
    // The allowance is spent once per challenge and the server decides, so the
    // offer is a condition rather than a promise.
    expect(text).toContain("if your Emergency Recovery is unspent");
  });
});
