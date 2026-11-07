import { describe, expect, it } from "vitest";
import {
  ADMIN,
  BLOCKS,
  HOLIDAY,
  LESSONS,
  PRAO,
  STAFF_DAY,
  TEACHER_ALL,
  TEACHER_ROOMS,
  TUESDAY,
  WEEK_DAYS,
  day,
  free,
  lesson,
  view,
} from "./__fixtures__/school-day";
import {
  axisOf,
  breakOf,
  buildRows,
  closedFor,
  defaultInterval,
  hoursOf,
  intervalError,
  namedTeacherIds,
  placeOnAxis,
  protectedAmong,
  rowKindsOf,
  schoolClosure,
  shiftDay,
  staffDayOf,
  weekColumns,
  weekRange,
  weekdayOf,
  type Drawn,
} from "./school-day";

/**
 * Skolans dag's view-model: the rows, the lanes, the axis, the lov and the
 * finder's small rules. The web only draws what the gateway decided, so these
 * tests pin what is drawn where, and that nothing here decides again: the
 * minutes are the gateway's, as they are on both sides of a clock change.
 */

const row = (rows: ReturnType<typeof buildRows>, id: string) => rows.find((one) => one.id === id)!;
const on = (r: { byDate: Map<string, Drawn[]> }, date = TUESDAY) => r.byDate.get(date) ?? [];

describe("which rows a reader may choose between", () => {
  it("gives an administrator and a teacher with the whole schedule the three, and a teacher with the rooms the rooms", () => {
    expect(rowKindsOf(ADMIN)).toEqual(["GROUP", "TEACHER", "ROOM"]);
    expect(rowKindsOf(TEACHER_ALL)).toEqual(["GROUP", "TEACHER", "ROOM"]);
    expect(rowKindsOf(TEACHER_ROOMS)).toEqual(["ROOM"]);
  });
});

describe("class rows", () => {
  const rows = buildRows(view(), "GROUP");

  it("puts the classes first, even a class with no lesson, then the halves and teaching groups that have one", () => {
    // 7A-1 (a half) and Ma9 have no lesson in the range and are no rows; En7 is in a lesson through 7A's.
    expect(rows.map((one) => one.name)).toEqual(["7A", "9B", "En7"]);
    expect(rows.every((one) => one.kind === "GROUP")).toBe(true);
  });

  it("draws a lesson in the row of its group and of each extra group, naming only the other groups", () => {
    expect(on(row(rows, "g-7a")).map((one) => one.key)).toEqual(["l:l-1", "l:l-2", "l:l-6"]);
    expect(on(row(rows, "g-en7")).map((one) => one.key)).toEqual(["l:l-2"]);
    expect(on(row(rows, "g-en7"))[0]!.groups).toEqual(["7A"]);
    expect(on(row(rows, "g-7a")).find((one) => one.key === "l:l-2")!.groups).toEqual(["En7"]);
  });

  it("draws a cancelled and a rescheduled lesson struck, flags the aktivitet's replacement and keeps the cause", () => {
    const nine = on(row(rows, "g-9b"));
    const cancelled = nine.find((one) => one.key === "l:l-3")!;
    expect(cancelled).toMatchObject({ cancelled: true, status: "CANCELLED", cancelCause: "EVENT", activity: false });
    expect(nine.find((one) => one.key === "l:l-4")).toMatchObject({ cancelled: false, activity: true, subject: "Friluftsdag" });
    expect(on(row(rows, "g-7a")).find((one) => one.key === "l:l-6")).toMatchObject({ cancelled: true, status: "RESCHEDULED" });
  });

  it("lays a double-booked class in two lanes and leaves a lesson that overlaps nothing in one", () => {
    const seven = on(row(rows, "g-7a"));
    const [first, second, alone] = seven;
    expect([first!.lane, second!.lane]).toEqual([0, 1]);
    expect([first!.laneCount, second!.laneCount]).toEqual([2, 2]);
    expect([alone!.lane, alone!.laneCount]).toEqual([0, 1]);
  });

  it("draws a lesson whose teacher the gateway left out without one, and keeps no count that says someone is missing", () => {
    const left = on(row(rows, "g-9b")).find((one) => one.key === "l:l-5")!;
    expect(left.teachers).toEqual([]);
    expect(left).not.toHaveProperty("hiddenTeachers");
  });

  it("names a lesson's teachers, room and subject", () => {
    expect(on(row(rows, "g-7a"))[0]).toMatchObject({
      subject: "Matematik",
      room: "Sal 12",
      teachers: [{ id: "t-1", name: "Anna Svensson" }],
    });
  });
});

describe("teacher rows", () => {
  const rows = buildRows(view(), "TEACHER");

  it("draws a teacher's lessons and the blocks of their day, in time order", () => {
    expect(on(row(rows, "t-1")).map((one) => [one.type, one.startMinutes])).toEqual([
      ["LESSON", 495],
      ["LESSON", 660],
      ["BOOKING", 780],
    ]);
    expect(on(row(rows, "t-2")).map((one) => one.type)).toEqual(["LESSON", "PASS"]);
    expect(on(row(rows, "t-3")).map((one) => one.type)).toContain("ABSENT");
  });

  it("draws the substitute on the lesson they took, as a teacher like the rest", () => {
    expect(on(row(rows, "t-2"))[0]).toMatchObject({ key: "l:l-2", subject: "Engelska" });
  });

  it("names a protected teacher by nothing in a printout: the row and every lesson of theirs", () => {
    const held = buildRows(view(), "TEACHER", new Set(["t-1"]));
    expect(row(held, "t-1").name).toBeNull();
    expect(row(held, "t-2").name).toBe("Bo Ek");
    const seven = buildRows(view(), "GROUP", new Set(["t-1"]));
    expect(on(row(seven, "g-7a"))[0]!.teachers).toEqual([{ id: "t-1", name: null }]);
    // The screen passes none: names as they are.
    expect(on(row(buildRows(view(), "GROUP"), "g-7a"))[0]!.teachers).toEqual([{ id: "t-1", name: "Anna Svensson" }]);
  });
});

describe("room rows", () => {
  const rows = buildRows(view(), "ROOM");

  it("draws the lessons held in a room with its bookings and closures", () => {
    expect(on(row(rows, "r-12")).map((one) => one.type)).toEqual(["LESSON", "LESSON", "LESSON", "BOOKING"]);
    expect(on(row(rows, "r-12")).find((one) => one.type === "BOOKING")!.label).toBe("Föräldramöte");
    expect(on(row(rows, "r-gym")).map((one) => one.type)).toEqual(["LESSON", "CLOSED", "LOAN"]);
  });

  it("does not say a room again on the lessons held in it, nor a class on its own row's lessons", () => {
    expect(on(row(rows, "r-12"))[0]).toMatchObject({ room: null, groups: ["7A"] });
    expect(on(row(buildRows(view(), "TEACHER"), "t-1"))[0]).toMatchObject({ room: "Sal 12", groups: ["7A"] });
  });

  it("keeps a room's code for the small line under its name", () => {
    expect(row(rows, "r-gym").detail).toBe("G1");
    expect(row(rows, "r-12").detail).toBeNull();
  });

  it("draws a cancelled lesson in its room too, struck: the room is free then, the page only shows why it was booked", () => {
    expect(on(row(rows, "r-gym"))[0]).toMatchObject({ cancelled: true, cancelCause: "EVENT" });
  });
});

describe("a week", () => {
  const lessons = [
    ...LESSONS,
    lesson({ id: "l-w", date: "2026-11-05", start: 495, end: 540, subjectId: "s-ma", groupId: "g-7a", teachers: [{ id: "t-1", role: "LEAD" }] }),
  ];
  const week = view({ from: "2026-11-02", to: "2026-11-08", days: WEEK_DAYS, lessons });

  it("keeps each row's items by date", () => {
    const seven = row(buildRows(week, "GROUP"), "g-7a");
    expect([...seven.byDate.keys()].sort()).toEqual([TUESDAY, "2026-11-05"]);
    expect(on(seven, "2026-11-05")).toHaveLength(1);
  });

  it("has a column for Monday to Friday, and for a weekend day only when something is on it", () => {
    expect(weekColumns(week).map((one) => one.date)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]);
    const saturday = view({
      days: WEEK_DAYS.map((one) => (one.date === "2026-11-07" ? day(one.date, [HOLIDAY]) : one)),
      lessons: [...lessons, lesson({ id: "l-s", date: "2026-11-08", start: 600, end: 660, subjectId: "s-ma", groupId: "g-7a" })],
    });
    expect(weekColumns(saturday).map((one) => one.date)).toEqual([
      "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08",
    ]);
  });

  it("asks for Monday to Sunday of the week of any date in it, over a month and a year end", () => {
    expect(weekRange("2026-11-04")).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    expect(weekRange("2026-11-08")).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    expect(weekRange("2026-11-02")).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    expect(weekRange("2027-01-01")).toEqual({ from: "2026-12-28", to: "2027-01-03" });
  });
});

describe("dates, which the clock change does not move", () => {
  it("steps whole calendar days across both clock changes", () => {
    expect(shiftDay("2027-03-27", 1)).toBe("2027-03-28");
    expect(shiftDay("2027-03-28", 1)).toBe("2027-03-29");
    expect(shiftDay("2027-10-30", 1)).toBe("2027-10-31");
    expect(shiftDay("2027-10-31", 1)).toBe("2027-11-01");
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
    expect(weekRange("2027-03-29")).toEqual({ from: "2027-03-29", to: "2027-04-04" });
    expect(weekRange("2027-03-28")).toEqual({ from: "2027-03-22", to: "2027-03-28" });
  });

  it("numbers the weekday ISO-wise, Sunday as 7", () => {
    expect([weekdayOf("2026-11-02"), weekdayOf("2026-11-07"), weekdayOf("2026-11-08")]).toEqual([1, 6, 7]);
  });

  it("draws a lesson at the same place on both sides of the change: the gateway sends 08:15 as 495 either way", () => {
    const before = { startMinutes: 495, endMinutes: 540 };
    const after = { startMinutes: 495, endMinutes: 540 };
    expect(placeOnAxis(after, axisOf(view()))).toEqual(placeOnAxis(before, axisOf(view())));
  });
});

describe("the time axis", () => {
  it("is never narrower than 07:00 to 16:00, in whole hours around the lessons", () => {
    // The Tuesday's replacement lesson ends at 15:00 and starts at 08:00.
    expect(axisOf(view())).toEqual({ start: 7 * 60, end: 16 * 60 });
    const wide = view({ lessons: [lesson({ id: "x", start: 6 * 60 + 30, end: 17 * 60 + 20, subjectId: "s-ma", groupId: "g-7a" })] });
    expect(axisOf(wide)).toEqual({ start: 6 * 60, end: 18 * 60 });
  });

  it("is widened by an evening loan as by an evening booking: a lent room is a window of the working day", () => {
    const evening: typeof BLOCKS = [{ resource: "ROOM", resourceId: "r-gym", date: TUESDAY, start: 16 * 60 + 30, end: 18 * 60, kind: "LOAN", label: null }];
    expect(axisOf(view({ blocks: evening })).end).toBe(18 * 60);
  });

  it("is widened by an evening booking, and not by an absence or a closure that is the whole day", () => {
    const evening: typeof BLOCKS = [{ resource: "ROOM", resourceId: "r-12", date: TUESDAY, start: 18 * 60, end: 19 * 60 + 30, kind: "BOOKING", label: null }];
    expect(axisOf(view({ blocks: evening })).end).toBe(20 * 60);
    const whole: typeof BLOCKS = [
      { resource: "TEACHER", resourceId: "t-1", date: TUESDAY, start: 0, end: 1440, kind: "ABSENT", label: null },
      { resource: "ROOM", resourceId: "r-12", date: TUESDAY, start: 0, end: 1440, kind: "CLOSED", label: null },
      { resource: "TEACHER", resourceId: "t-2", date: TUESDAY, start: 0, end: 1440, kind: "UNAVAILABLE", label: null },
    ];
    expect(axisOf(view({ blocks: whole }))).toEqual({ start: 7 * 60, end: 16 * 60 });
  });

  it("places an item in percent of the axis, clips what sticks out and drops what lies outside", () => {
    const axis = { start: 420, end: 960 };
    expect(placeOnAxis({ startMinutes: 480, endMinutes: 600 }, axis)).toEqual({ left: (60 / 540) * 100, width: (120 / 540) * 100 });
    expect(placeOnAxis({ startMinutes: 0, endMinutes: 1440 }, axis)).toEqual({ left: 0, width: 100 });
    expect(placeOnAxis({ startMinutes: 1000, endMinutes: 1100 }, axis)).toBeNull();
    expect(placeOnAxis({ startMinutes: 300, endMinutes: 420 }, axis)).toBeNull();
  });

  it("marks the whole hours", () => {
    expect(hoursOf({ start: 420, end: 600 })).toEqual([420, 480, 540, 600]);
  });
});

describe("lov", () => {
  const rowOf = (kind: "GROUP" | "TEACHER" | "ROOM", id: string) => ({ kind, id });

  it("closes every class, teacher and room on a holiday of the whole school", () => {
    const holiday = day(TUESDAY, [HOLIDAY]);
    expect(breakOf(holiday, rowOf("GROUP", "g-7a"))).toBe(HOLIDAY);
    expect(breakOf(holiday, rowOf("TEACHER", "t-1"))).toBe(HOLIDAY);
    expect(breakOf(holiday, rowOf("ROOM", "r-12"))).toBe(HOLIDAY);
    expect(schoolClosure(holiday)).toBe(HOLIDAY);
  });

  it("closes only the classes of the årskurs a narrowed lov covers, and no teacher or room", () => {
    const prao = day(TUESDAY, [PRAO]);
    expect(breakOf(prao, rowOf("GROUP", "g-9b"))).toBe(PRAO);
    expect(breakOf(prao, rowOf("GROUP", "g-7a"))).toBeNull();
    expect(breakOf(prao, rowOf("TEACHER", "t-1"))).toBeNull();
    expect(breakOf(prao, rowOf("ROOM", "r-12"))).toBeNull();
    expect(schoolClosure(prao)).toBeNull();
  });

  it("takes a studiedag as the pupils' day off and the staff's working day: a class is closed, a teacher is not", () => {
    const planning = day(TUESDAY, [STAFF_DAY]);
    expect(breakOf(planning, rowOf("GROUP", "g-7a"))).toBe(STAFF_DAY);
    expect(breakOf(planning, rowOf("TEACHER", "t-1"))).toBeNull();
    expect(breakOf(planning, rowOf("ROOM", "r-12"))).toBeNull();
    expect(schoolClosure(planning)).toBeNull();
  });

  it("names the holiday when a holiday and a studiedag fall on one day", () => {
    expect(breakOf(day(TUESDAY, [STAFF_DAY, HOLIDAY]), rowOf("GROUP", "g-7a"))).toBe(HOLIDAY);
  });
});

describe("the finder", () => {
  it("opens on the hour that is on and the hour after it, and stops at 23:59", () => {
    expect(defaultInterval(new Date("2026-11-03T10:25:00"))).toEqual({ from: "10:00", to: "11:00" });
    expect(defaultInterval(new Date("2026-11-03T00:05:00"))).toEqual({ from: "00:00", to: "01:00" });
    expect(defaultInterval(new Date("2026-11-03T23:40:00"))).toEqual({ from: "23:00", to: "23:59" });
  });

  it("asks only for a real interval: both times written and the end after the start", () => {
    expect(intervalError("10:00", "11:00")).toBeNull();
    expect(intervalError("10:00", "10:00")).toBe("ORDER");
    expect(intervalError("11:00", "10:00")).toBe("ORDER");
    expect(intervalError("", "10:00")).toBe("TIMES");
    expect(intervalError("10:00", "24:00")).toBe("TIMES");
    expect(intervalError("9:00", "10:00")).toBe("TIMES");
  });

  it("finds a holiday of the whole school, and a studiedag, but not a narrowed lov", () => {
    expect(closedFor(free({ breaks: [HOLIDAY] }))).toBe(HOLIDAY);
    expect(closedFor(free({ breaks: [PRAO, STAFF_DAY] }))).toBeNull();
    expect(staffDayOf(free({ breaks: [STAFF_DAY] }))).toBe(STAFF_DAY);
    expect(staffDayOf(free({ breaks: [HOLIDAY] }))).toBeNull();
  });
});

describe("protected persons", () => {
  it("lists the teachers the answer names, as rows or on a lesson", () => {
    expect([...namedTeacherIds(view())].sort()).toEqual(["t-1", "t-2", "t-3"]);
    expect([...namedTeacherIds(view({ teachers: [], lessons: [], blocks: [] }))]).toEqual([]);
  });

  it("finds the marked among them, and only them", () => {
    expect([...protectedAmong(view(), new Set(["t-2", "t-9"]))]).toEqual(["t-2"]);
    expect(protectedAmong(view(), new Set()).size).toBe(0);
  });
});
