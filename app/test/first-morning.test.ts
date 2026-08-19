/**
 * The first morning, read before anyone commits to it.
 *
 * The plan summary named a date and stopped, so "First morning: Tuesday,
 * September 1" read the same whether the deadline was fourteen hours away or
 * twenty minutes away. These pin the three things the reading has to say: the
 * time it is actually due, how soon that is, and the two cases where pressing
 * Start would not get what the summary describes.
 */

import { firstMorningReading } from "../src/challenges/first-morning.ts";
import { ALARM_LEAD_MINUTES } from "../src/reminders/reminders.ts";
import { PROJECTION } from "./support/fake-api.ts";

const ZONE = "America/Los_Angeles";

/** The fixture's first deadline is 14:00Z, which is 7:00 AM in the zone above. */
function readingAt(minutesBefore: number, noRegretMinutes = 0) {
  const deadline = new Date(PROJECTION.firstTaskDeadline).getTime();
  return firstMorningReading({
    projection: PROJECTION,
    timeZone: ZONE,
    noRegretMinutes,
    now: new Date(deadline - minutesBefore * 60_000),
  });
}

describe("the time the first morning is due", () => {
  it("names the day and the deadline read in the challenge's own zone", () => {
    const reading = readingAt(14 * 60);

    expect(reading?.due).toContain("Tuesday, September 1");
    expect(reading?.due).toContain("7:00");
    expect(reading?.due).not.toContain("2026-09-01T14:00");
  });

  it("says how long from now that is, as a person would say it", () => {
    expect(readingAt(14 * 60)?.countdown).toBe("That is 14 hours from now.");
    expect(readingAt(127)?.countdown).toBe("That is 2 hours 7 minutes from now.");
  });

  it("reads quietly, with nothing to warn about, while the morning is far off", () => {
    const reading = readingAt(14 * 60);

    expect(reading?.urgency).toBe("ample");
    expect(reading?.caution).toBeNull();
  });

  it("is nothing at all when the deadline cannot be read", () => {
    expect(
      firstMorningReading({
        projection: { ...PROJECTION, firstTaskDeadline: "not an instant" },
        timeZone: ZONE,
        noRegretMinutes: 0,
        now: new Date("2026-09-01T00:00:00.000Z"),
      }),
    ).toBeNull();
  });
});

describe("a first deadline the phone cannot wake anyone for", () => {
  it("turns closing inside the alarm's own lead and says no reminder can reach them", () => {
    const reading = readingAt(30);

    expect(reading?.urgency).toBe("closing");
    expect(reading?.countdown).toBe("That is 30 minutes from now.");
    expect(reading?.caution).toContain(`less than ${ALARM_LEAD_MINUTES} minutes away`);
    expect(reading?.caution).toContain("nothing will wake you for it");
  });

  it("takes the alarm's lead as the boundary rather than a number of its own", () => {
    expect(readingAt(ALARM_LEAD_MINUTES)?.urgency).toBe("closing");
    expect(readingAt(ALARM_LEAD_MINUTES + 1)?.urgency).toBe("ample");
  });
});

describe("a plan the server would no longer make", () => {
  it("says the morning has gone by once its deadline is behind the clock", () => {
    const reading = readingAt(-20);

    expect(reading?.urgency).toBe("stale");
    expect(reading?.countdown).toBe("That deadline passed 20 minutes ago.");
    expect(reading?.caution).toContain("already behind you");
    expect(reading?.caution).toContain("next morning your schedule holds");
    expect(reading?.caution).toContain("later than the ones shown here");
  });

  it("says the same once the deadline is inside the No Regret cutoff, which is the engine's own rule", () => {
    // Eight hours of No Regret Time with an hour to run: the schedule engine
    // takes the first morning whose cutoff is still ahead, so this one is
    // already spent even though its deadline has not passed.
    const reading = readingAt(60, 480);

    expect(reading?.urgency).toBe("stale");
    expect(reading?.countdown).toBe("That is only 1 hour from now.");
    expect(reading?.caution).toContain("inside your No Regret Time");
  });

  it("still reads as an ordinary morning while the cutoff is ahead", () => {
    expect(readingAt(481, 480)?.urgency).toBe("ample");
  });
});
