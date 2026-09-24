/**
 * The time and schedule engine.
 *
 * The cases that matter are the ones where a calendar day is not 24 hours long
 * and where a boundary is a comparison rather than a computation, so the suite
 * is table-driven over both: inactive weekdays, DST in each direction, the
 * cutoff boundary on both sides, and the ambiguous and nonexistent local times
 * a deadline can land on twice a year.
 *
 * Every instant in this file is written as a UTC literal, because an expected
 * value written in the zone under test would be produced by the same
 * conversion the test is meant to check.
 */

import { describe, expect, it } from "vitest";

import {
  appendTask,
  daysBetween,
  materializeSchedule,
  projectEndDate,
  type ScheduleConfiguration,
  taskInstants,
} from "../src/schedule/engine.ts";
import { localDateOf, resolveLocalTime } from "../src/schedule/zoned-time.ts";

const LOS_ANGELES = "America/Los_Angeles";

/**
 * Weekdays at 09:00, weekends inactive, with eight hours of No Regret Time and
 * a ten minute walk window.
 */
function weekdayConfiguration(overrides: Partial<ScheduleConfiguration> = {}) {
  return {
    requiredTaskCount: 5,
    schedule: [
      { weekday: "monday", deadline: "09:00" },
      { weekday: "tuesday", deadline: "09:00" },
      { weekday: "wednesday", deadline: "09:00" },
      { weekday: "thursday", deadline: "09:00" },
      { weekday: "friday", deadline: "09:00" },
    ],
    noRegretMinutes: 8 * 60,
    walkWindowMinutes: 10,
    timeZone: LOS_ANGELES,
    ...overrides,
  } satisfies ScheduleConfiguration;
}

describe("resolving a wall-clock time in a zone", () => {
  const cases = [
    {
      name: "an ordinary winter morning is one instant",
      date: "2026-01-14",
      time: "09:00",
      zone: LOS_ANGELES,
      expected: "2026-01-14T17:00:00.000Z",
    },
    {
      name: "an ordinary summer morning carries the summer offset",
      date: "2026-07-15",
      time: "09:00",
      zone: LOS_ANGELES,
      expected: "2026-07-15T16:00:00.000Z",
    },
    {
      name: "a local time skipped by the forward transition moves forward by the gap",
      date: "2026-03-08",
      time: "02:30",
      zone: LOS_ANGELES,
      // There is no 02:30 that day. The hour the clocks lost is added, so the
      // deadline reads 03:30 rather than collapsing onto the transition.
      expected: "2026-03-08T10:30:00.000Z",
    },
    {
      name: "a local time repeated by the backward transition takes the later occurrence",
      date: "2026-11-01",
      time: "01:30",
      zone: LOS_ANGELES,
      // 01:30 PDT is 08:30Z and 01:30 PST is 09:30Z. The user keeps the hour.
      expected: "2026-11-01T09:30:00.000Z",
    },
    {
      name: "the instant the forward transition begins is unambiguous",
      date: "2026-03-08",
      time: "01:59",
      zone: LOS_ANGELES,
      expected: "2026-03-08T09:59:00.000Z",
    },
    {
      name: "a half-hour zone resolves against its own offset",
      date: "2026-06-10",
      time: "07:15",
      zone: "Asia/Kolkata",
      expected: "2026-06-10T01:45:00.000Z",
    },
    {
      name: "a three-quarter-hour zone resolves against its own offset",
      date: "2026-06-10",
      time: "07:15",
      zone: "Asia/Kathmandu",
      expected: "2026-06-10T01:30:00.000Z",
    },
    {
      name: "a zone with a half-hour DST shift resolves inside the shift",
      date: "2026-06-10",
      time: "07:15",
      zone: "Australia/Lord_Howe",
      expected: "2026-06-09T20:45:00.000Z",
    },
  ] as const;

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(resolveLocalTime(testCase.date, testCase.time, testCase.zone).toISOString()).toBe(
        testCase.expected,
      );
    });
  }

  it("reads an instant back as the calendar date it falls on locally", () => {
    expect(localDateOf(new Date("2026-01-01T07:59:00.000Z"), LOS_ANGELES)).toBe("2025-12-31");
    expect(localDateOf(new Date("2026-01-01T08:00:00.000Z"), LOS_ANGELES)).toBe("2026-01-01");
  });
});

describe("placing task dates", () => {
  it("skips inactive weekdays", () => {
    const tasks = materializeSchedule(
      weekdayConfiguration({ requiredTaskCount: 7 }),
      // Thursday 2026-01-15, 00:00 local.
      new Date("2026-01-15T08:00:00.000Z"),
    );

    expect(tasks.map((task) => task.date)).toEqual([
      "2026-01-15",
      "2026-01-16",
      "2026-01-19",
      "2026-01-20",
      "2026-01-21",
      "2026-01-22",
      "2026-01-23",
    ]);
  });

  it("numbers tasks from one in date order", () => {
    const tasks = materializeSchedule(weekdayConfiguration(), new Date("2026-01-15T08:00:00.000Z"));

    expect(tasks.map((task) => task.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it("places every task on a scheduled weekday when only one is active", () => {
    const tasks = materializeSchedule(
      weekdayConfiguration({
        requiredTaskCount: 3,
        schedule: [{ weekday: "sunday", deadline: "07:30" }],
      }),
      new Date("2026-01-15T08:00:00.000Z"),
    );

    expect(tasks.map((task) => task.date)).toEqual(["2026-01-18", "2026-01-25", "2026-02-01"]);
  });

  it("gives each active weekday its own deadline", () => {
    const tasks = materializeSchedule(
      weekdayConfiguration({
        requiredTaskCount: 2,
        schedule: [
          { weekday: "thursday", deadline: "06:00" },
          { weekday: "friday", deadline: "11:45" },
        ],
      }),
      new Date("2026-01-15T00:00:00.000Z"),
    );

    expect(tasks.map((task) => task.deadline.toISOString())).toEqual([
      "2026-01-15T14:00:00.000Z",
      "2026-01-16T19:45:00.000Z",
    ]);
  });
});

describe("the starting boundary", () => {
  // Thursday 2026-01-15 has a 09:00 deadline, so its cutoff is 01:00 local,
  // which is 09:00Z.
  const cases = [
    {
      name: "a challenge created a minute before the first cutoff gets that task",
      startingAt: "2026-01-15T08:59:00.000Z",
      firstDate: "2026-01-15",
    },
    {
      name: "a challenge created exactly at the cutoff does not",
      startingAt: "2026-01-15T09:00:00.000Z",
      firstDate: "2026-01-16",
    },
    {
      name: "a challenge created a minute after the cutoff does not",
      startingAt: "2026-01-15T09:01:00.000Z",
      firstDate: "2026-01-16",
    },
    {
      name: "a challenge created after Friday's cutoff waits for Monday",
      startingAt: "2026-01-16T09:00:00.000Z",
      firstDate: "2026-01-19",
    },
  ] as const;

  for (const testCase of cases) {
    it(testCase.name, () => {
      const tasks = materializeSchedule(weekdayConfiguration(), new Date(testCase.startingAt));
      expect(tasks[0]?.date).toBe(testCase.firstDate);
    });
  }

  it("gives the first task of the day to a challenge created at any hour when no notice is required", () => {
    const tasks = materializeSchedule(
      weekdayConfiguration({ noRegretMinutes: 0 }),
      // 08:59 local on Thursday, one minute before the 09:00 deadline.
      new Date("2026-01-15T16:59:00.000Z"),
    );

    expect(tasks[0]?.date).toBe("2026-01-15");
  });
});

describe("the pause cutoff", () => {
  it("is the deadline less the No Regret duration", () => {
    const [task] = materializeSchedule(
      weekdayConfiguration({ requiredTaskCount: 1 }),
      new Date("2026-01-15T00:00:00.000Z"),
    );

    expect(task?.deadline.toISOString()).toBe("2026-01-15T17:00:00.000Z");
    expect(task?.pauseCutoff.toISOString()).toBe("2026-01-15T09:00:00.000Z");
  });

  it("is the deadline when no notice is required", () => {
    const [task] = materializeSchedule(
      weekdayConfiguration({ requiredTaskCount: 1, noRegretMinutes: 0 }),
      new Date("2026-01-15T00:00:00.000Z"),
    );

    expect(task?.pauseCutoff.toISOString()).toBe(task?.deadline.toISOString());
  });

  it("holds the No Regret duration in real time across the forward transition", () => {
    // Sunday 2026-03-08 loses an hour at 02:00 local. A Sunday 09:00 deadline
    // is 16:00Z, and eight real hours before it is 08:00Z, which reads 00:00
    // local: an hour earlier on the wall clock than on an ordinary day.
    const [task] = materializeSchedule(
      weekdayConfiguration({
        requiredTaskCount: 1,
        schedule: [{ weekday: "sunday", deadline: "09:00" }],
      }),
      new Date("2026-03-07T00:00:00.000Z"),
    );

    expect(task?.date).toBe("2026-03-08");
    expect(task?.deadline.toISOString()).toBe("2026-03-08T16:00:00.000Z");
    expect(task?.pauseCutoff.toISOString()).toBe("2026-03-08T08:00:00.000Z");
  });

  it("holds the No Regret duration in real time across the backward transition", () => {
    // Sunday 2026-11-01 gains an hour at 02:00 local. A 09:00 deadline is
    // 17:00Z, and eight real hours before it is 09:00Z, which reads 01:00 PST.
    const [task] = materializeSchedule(
      weekdayConfiguration({
        requiredTaskCount: 1,
        schedule: [{ weekday: "sunday", deadline: "09:00" }],
      }),
      new Date("2026-10-31T00:00:00.000Z"),
    );

    expect(task?.date).toBe("2026-11-01");
    expect(task?.deadline.toISOString()).toBe("2026-11-01T17:00:00.000Z");
    expect(task?.pauseCutoff.toISOString()).toBe("2026-11-01T09:00:00.000Z");
  });
});

describe("crossing a daylight saving transition", () => {
  it("keeps the wall-clock deadline the week the clocks go forward", () => {
    const tasks = materializeSchedule(
      weekdayConfiguration({ requiredTaskCount: 3 }),
      // Friday 2026-03-06, before the Sunday transition.
      new Date("2026-03-06T00:00:00.000Z"),
    );

    expect(tasks.map((task) => task.date)).toEqual(["2026-03-06", "2026-03-09", "2026-03-10"]);
    expect(tasks.map((task) => task.deadline.toISOString())).toEqual([
      "2026-03-06T17:00:00.000Z",
      "2026-03-09T16:00:00.000Z",
      "2026-03-10T16:00:00.000Z",
    ]);
  });

  it("keeps the wall-clock deadline the week the clocks go back", () => {
    const tasks = materializeSchedule(
      weekdayConfiguration({ requiredTaskCount: 3 }),
      new Date("2026-10-30T00:00:00.000Z"),
    );

    expect(tasks.map((task) => task.date)).toEqual(["2026-10-30", "2026-11-02", "2026-11-03"]);
    expect(tasks.map((task) => task.deadline.toISOString())).toEqual([
      "2026-10-30T16:00:00.000Z",
      "2026-11-02T17:00:00.000Z",
      "2026-11-03T17:00:00.000Z",
    ]);
  });

  it("places a deadline inside the skipped hour past the gap", () => {
    const [task] = materializeSchedule(
      weekdayConfiguration({
        requiredTaskCount: 1,
        schedule: [{ weekday: "sunday", deadline: "02:30" }],
        noRegretMinutes: 0,
      }),
      new Date("2026-03-07T00:00:00.000Z"),
    );

    expect(task?.date).toBe("2026-03-08");
    expect(task?.deadline.toISOString()).toBe("2026-03-08T10:30:00.000Z");
  });

  it("places a deadline inside the repeated hour at its later occurrence", () => {
    const [task] = materializeSchedule(
      weekdayConfiguration({
        requiredTaskCount: 1,
        schedule: [{ weekday: "sunday", deadline: "01:30" }],
        noRegretMinutes: 0,
      }),
      new Date("2026-10-31T00:00:00.000Z"),
    );

    expect(task?.date).toBe("2026-11-01");
    expect(task?.deadline.toISOString()).toBe("2026-11-01T09:30:00.000Z");
  });

  it("counts a day with 25 hours as one day when placing dates", () => {
    // The Sunday of the backward transition is 25 hours long. Placing the
    // following Monday by walking real time rather than the calendar would
    // land an hour short and produce the same date twice.
    const tasks = materializeSchedule(
      weekdayConfiguration({ requiredTaskCount: 2 }),
      new Date("2026-10-30T00:00:00.000Z"),
    );

    expect(new Set(tasks.map((task) => task.date)).size).toBe(2);
  });
});

describe("the projected end date", () => {
  it("is the last task's date", () => {
    const configuration = weekdayConfiguration({ requiredTaskCount: 12 });
    const startingAt = new Date("2026-01-15T00:00:00.000Z");
    const tasks = materializeSchedule(configuration, startingAt);

    expect(projectEndDate(configuration, startingAt)).toBe(tasks[tasks.length - 1]?.date);
  });

  it("spans the calendar days the weekly schedule implies", () => {
    // Ten tasks on two active weekdays a week. The first lands on Thursday,
    // so the tenth is four whole weeks and a Tuesday later.
    const configuration = weekdayConfiguration({
      requiredTaskCount: 10,
      schedule: [
        { weekday: "tuesday", deadline: "09:00" },
        { weekday: "thursday", deadline: "09:00" },
      ],
    });
    const startingAt = new Date("2026-01-15T00:00:00.000Z");

    expect(projectEndDate(configuration, startingAt)).toBe("2026-02-17");
    expect(daysBetween("2026-01-15", "2026-02-17")).toBe(33);
  });

  it("counts calendar days across a transition rather than 24-hour spans", () => {
    expect(daysBetween("2026-03-01", "2026-03-31")).toBe(30);
    expect(daysBetween("2026-01-15", "2027-01-15")).toBe(365);
  });
});

describe("appending a replacement task", () => {
  it("lands on the next scheduled date after the challenge's last task", () => {
    const configuration = weekdayConfiguration();
    const tasks = materializeSchedule(configuration, new Date("2026-01-15T00:00:00.000Z"));
    const last = tasks[tasks.length - 1];

    if (last === undefined) throw new Error("a schedule with no tasks");

    const appended = appendTask(configuration, last, tasks.length + 1);

    expect(last?.date).toBe("2026-01-21");
    expect(appended.date).toBe("2026-01-22");
    expect(appended.sequence).toBe(6);
  });

  it("crosses an inactive weekend", () => {
    const configuration = weekdayConfiguration();

    const friday = { date: "2026-01-16", deadline: new Date("2026-01-16T17:00:00.000Z") };

    expect(appendTask(configuration, friday, 2).date).toBe("2026-01-19");
  });

  it("is placed by date alone, so a long pause never shortens the challenge", () => {
    const configuration = weekdayConfiguration();
    const thursday = { date: "2026-01-15", deadline: new Date("2026-01-15T17:00:00.000Z") };
    const appended = appendTask(configuration, thursday, 2);

    expect(appended.date).toBe("2026-01-16");
    expect(appended.deadline.toISOString()).toBe("2026-01-16T17:00:00.000Z");
  });
});

describe("recomputing a task's instants", () => {
  it("gives the same instants materialization did", () => {
    const configuration = weekdayConfiguration();
    const tasks = materializeSchedule(configuration, new Date("2026-01-15T00:00:00.000Z"));

    let previousDeadline: Date | null = null;
    for (const task of tasks) {
      expect(taskInstants(configuration, task.date, task.sequence, previousDeadline)).toEqual(task);
      previousDeadline = task.deadline;
    }
  });

  it("moves only the instants when the zone changes", () => {
    const configuration = weekdayConfiguration();
    const moved = taskInstants(
      { ...configuration, timeZone: "Europe/Berlin" },
      "2026-01-15",
      4,
      new Date("2026-01-14T08:00:00.000Z"),
    );

    expect(moved.date).toBe("2026-01-15");
    expect(moved.sequence).toBe(4);
    expect(moved.deadline.toISOString()).toBe("2026-01-15T08:00:00.000Z");
    expect(moved.pauseCutoff.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(moved.opensAt.toISOString()).toBe("2026-01-15T07:50:00.000Z");
  });

  it("refuses a date the weekly schedule does not cover", () => {
    // Saturday. A caller asking for instants on an inactive day has a bug, and
    // inventing a deadline for it would hide the bug behind a plausible task.
    expect(() => taskInstants(weekdayConfiguration(), "2026-01-17", 1, null)).toThrow(
      /not an active weekday/,
    );
  });
});

describe("when a walk opens", () => {
  /** Every day at `deadline`, which is the densest schedule a challenge can hold. */
  function daily(deadline: string, overrides: Partial<ScheduleConfiguration> = {}) {
    return weekdayConfiguration({
      schedule: (
        ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const
      ).map((weekday) => ({ weekday, deadline })),
      noRegretMinutes: 0,
      ...overrides,
    });
  }

  it("opens the walk window before the deadline", () => {
    const [first] = materializeSchedule(
      weekdayConfiguration(),
      new Date("2026-01-15T00:00:00.000Z"),
    );

    // 09:00 in Los Angeles in January is 17:00 UTC, and ten minutes before it is 08:50.
    expect(first?.deadline.toISOString()).toBe("2026-01-15T17:00:00.000Z");
    expect(first?.opensAt.toISOString()).toBe("2026-01-15T16:50:00.000Z");
  });

  it("opens on the date before when the window reaches back past midnight", () => {
    const [first] = materializeSchedule(
      daily("00:30", { walkWindowMinutes: 60 }),
      new Date("2026-01-14T12:00:00.000Z"),
    );

    // A 12:30 AM deadline on the 15th opens at 11:30 PM on the 14th.
    expect(first?.date).toBe("2026-01-15");
    expect(first?.deadline.toISOString()).toBe("2026-01-15T08:30:00.000Z");
    expect(first?.opensAt.toISOString()).toBe("2026-01-15T07:30:00.000Z");
    expect(localDateOf(first?.opensAt ?? new Date(0), LOS_ANGELES)).toBe("2026-01-14");
  });

  it("measures the window in real time across a backward transition", () => {
    // 2026-11-01 in Los Angeles repeats 01:00 to 02:00. The 00:30 deadline is
    // before the change, at UTC-7, and the evening before is at UTC-7 too, so
    // sixty real minutes still read as 11:30 PM on the 31st.
    const tasks = materializeSchedule(
      daily("00:30", { walkWindowMinutes: 60, requiredTaskCount: 3 }),
      new Date("2026-10-31T12:00:00.000Z"),
    );
    const sunday = tasks.find((task) => task.date === "2026-11-01");
    const monday = tasks.find((task) => task.date === "2026-11-02");

    expect(sunday?.deadline.toISOString()).toBe("2026-11-01T07:30:00.000Z");
    expect(sunday?.opensAt.toISOString()).toBe("2026-11-01T06:30:00.000Z");
    // The first deadline after the change is at UTC-8, and so is its window.
    expect(monday?.deadline.toISOString()).toBe("2026-11-02T08:30:00.000Z");
    expect(monday?.opensAt.toISOString()).toBe("2026-11-02T07:30:00.000Z");
  });

  it("measures the window in real time when it spans a forward transition", () => {
    // 2026-03-08 in Los Angeles skips 02:00 to 03:00. A 03:30 deadline with a
    // ninety minute window opens at 01:00 by the wall clock, not 02:00: ninety
    // real minutes, one of which the clock never showed.
    const tasks = materializeSchedule(
      daily("03:30", { walkWindowMinutes: 90, requiredTaskCount: 2 }),
      new Date("2026-03-07T12:00:00.000Z"),
    );
    const sunday = tasks.find((task) => task.date === "2026-03-08");

    expect(sunday?.deadline.toISOString()).toBe("2026-03-08T10:30:00.000Z");
    expect(sunday?.opensAt.toISOString()).toBe("2026-03-08T09:00:00.000Z");
    expect(resolveLocalTime("2026-03-08", "01:00", LOS_ANGELES).toISOString()).toBe(
      "2026-03-08T09:00:00.000Z",
    );
  });

  it("never opens before the previous task's deadline", () => {
    // Monday at 23:30 and Tuesday at 00:30 are an hour apart. A two hour window
    // on Tuesday would reach back past Monday's deadline, so it opens there.
    const configuration = weekdayConfiguration({
      schedule: [
        { weekday: "monday", deadline: "23:30" },
        { weekday: "tuesday", deadline: "00:30" },
      ],
      walkWindowMinutes: 119,
      noRegretMinutes: 0,
      requiredTaskCount: 3,
    });
    const tasks = materializeSchedule(configuration, new Date("2026-01-12T12:00:00.000Z"));
    const [monday, tuesday] = tasks;

    expect(monday?.date).toBe("2026-01-12");
    expect(tuesday?.date).toBe("2026-01-13");
    expect(tuesday?.opensAt.toISOString()).toBe(monday?.deadline.toISOString());
    // Monday itself has no task an hour before it, so its window is whole.
    expect(monday?.opensAt.getTime()).toBe((monday?.deadline.getTime() ?? 0) - 119 * 60_000);
  });

  it("opens a replacement no earlier than the deadline of the task it follows", () => {
    const configuration = daily("00:30", { walkWindowMinutes: 119 });
    const last = { date: "2026-01-15", deadline: new Date("2026-01-16T07:00:00.000Z") };

    const appended = appendTask(configuration, last, 2);

    expect(appended.date).toBe("2026-01-16");
    expect(appended.opensAt.toISOString()).toBe("2026-01-16T07:00:00.000Z");
  });

  it("never opens after its own deadline, even behind a later previous deadline", () => {
    // Only a time zone change can put the previous deadline after this one.
    const moved = taskInstants(
      weekdayConfiguration(),
      "2026-01-15",
      2,
      new Date("2026-01-15T20:00:00.000Z"),
    );

    expect(moved.opensAt.toISOString()).toBe(moved.deadline.toISOString());
  });
});
