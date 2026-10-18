import { describe, expect, it } from "vitest";
import { buildRosterIndex } from "@/lib/lesson-audience";
import type { MasterLesson } from "@/lib/types";
import { alternates, candidateSheet, concerns, inYear, parityOf, referenceMonday, runsOn } from "./week";

const YEAR = { startDate: "2026-08-17", endDate: "2027-06-11" };

function lesson(overrides: Partial<MasterLesson> = {}): MasterLesson {
  return {
    id: "l-1",
    academicYearId: "y-1",
    subjectId: "s-ma",
    studentGroupId: "g-7a",
    teacherId: "t-1",
    coTeacherId: null,
    roomId: "r-1",
    dayOfWeek: 1,
    startTime: "08:00",
    endTime: "09:00",
    isLocked: false,
    isParked: false,
    recurrence: "ALL_WEEKS",
    startDate: null,
    endDate: null,
    extraGroupIds: [],
    studentIds: [],
    ...overrides,
  };
}

const names = {
  subject: (id: string) => ({ "s-ma": "Matematik", "s-sv": "Svenska" })[id] ?? null,
  group: (id: string) => ({ "g-7a": "7A", "g-7b": "7B", "g-7a-1": "7A grupp 1" })[id] ?? null,
  room: (id: string) => ({ "r-1": "Sal 1" })[id] ?? null,
  teacher: (id: string) => ({ "t-1": "Anna Ek", "t-2": "Bo Ek" })[id] ?? null,
};

describe("the week shown", () => {
  it("is today's, held inside the läsår", () => {
    // Saturday 17 October 2026 is in the week starting Monday the 12th.
    expect(referenceMonday(YEAR, "2026-10-17")).toBe("2026-10-12");
    // Before the year: its first week; after it: its last.
    expect(referenceMonday(YEAR, "2026-07-01")).toBe("2026-08-17");
    expect(referenceMonday(YEAR, "2027-07-20")).toBe("2027-06-07");
  });

  it("holds a planning spring to the start's week, and a weekend start to the Monday after it", () => {
    // Next year planned in April. A Wednesday start keeps its own week (its
    // Monday and Tuesday are drawn empty, below); a Saturday or Sunday start
    // has no day of the läsår in the week before, so the sheet begins after it.
    expect(referenceMonday({ startDate: "2027-08-18", endDate: "2028-06-09" }, "2027-04-10")).toBe("2027-08-16");
    expect(referenceMonday({ startDate: "2027-08-15", endDate: "2028-06-09" }, "2027-04-10")).toBe("2027-08-16");
    expect(referenceMonday({ startDate: "2027-08-14", endDate: "2028-06-09" }, "2027-04-10")).toBe("2027-08-16");
    // On the Sunday start itself, too.
    expect(referenceMonday({ startDate: "2027-08-15", endDate: "2028-06-09" }, "2027-08-15")).toBe("2027-08-16");
  });

  it("knows the läsår's days", () => {
    const year = { startDate: "2027-08-18", endDate: "2028-06-07" };
    expect(inYear(year, "2027-08-17")).toBe(false);
    expect(inYear(year, "2027-08-18")).toBe(true);
    expect(inYear(year, "2028-06-07")).toBe(true);
    expect(inYear(year, "2028-06-08")).toBe(false);
  });

  it("knows its ISO parity", () => {
    expect(parityOf("2026-10-12")).toBe("EVEN_WEEKS"); // week 42
    expect(parityOf("2026-10-19")).toBe("ODD_WEEKS"); // week 43
  });

  it("holds a lesson only where it runs: its weeks and its dates", () => {
    expect(runsOn(lesson(), "2026-10-12", "EVEN_WEEKS")).toBe(true);
    expect(runsOn(lesson({ recurrence: "ODD_WEEKS" }), "2026-10-12", "EVEN_WEEKS")).toBe(false);
    expect(runsOn(lesson({ startDate: "2027-01-07" }), "2026-10-12", "EVEN_WEEKS")).toBe(false);
    expect(runsOn(lesson({ endDate: "2026-12-18" }), "2026-10-12", "EVEN_WEEKS")).toBe(true);
    expect(runsOn(lesson({ endDate: "2026-10-11" }), "2026-10-12", "EVEN_WEEKS")).toBe(false);
  });

  it("offers a second week only when something alternates", () => {
    expect(alternates([lesson()])).toBe(false);
    expect(alternates([lesson(), lesson({ recurrence: "EVEN_WEEKS" })])).toBe(true);
  });
});

describe("whose week a lesson is on", () => {
  const groups = [
    { id: "g-7a", halfOfId: null },
    { id: "g-7a-1", halfOfId: "g-7a" },
    { id: "g-7b", halfOfId: null },
    { id: "g-ma71", halfOfId: null },
    { id: "g-ma72", halfOfId: null },
  ];
  // Cia's home is 7A and Dan's 7B; Cia is in Ma71, Dan in Ma72.
  const roster = buildRosterIndex(
    new Map([
      ["p-cia", "g-7a"],
      ["p-dan", "g-7b"],
    ]),
    [
      { studentId: "p-cia", studentGroupId: "g-ma71" },
      { studentId: "p-dan", studentGroupId: "g-ma72" },
    ],
    groups,
  );

  it("puts a class's halves and visiting lessons on the class's week", () => {
    expect(concerns(lesson({ studentGroupId: "g-7a-1" }), "GROUP", "g-7a", roster)).toBe(true);
    expect(concerns(lesson({ studentGroupId: "g-7b", extraGroupIds: ["g-7a"] }), "GROUP", "g-7a", roster)).toBe(true);
    expect(concerns(lesson({ studentGroupId: "g-7b" }), "GROUP", "g-7a", roster)).toBe(false);
  });

  it("puts a teaching group's lesson on the week of every class whose pupils sit in it", () => {
    // A candidate's lesson sits on its requirement's group: Ma71's maths is
    // 7A's hour because Cia is in it, and not 7B's, whose Dan is in Ma72.
    expect(concerns(lesson({ studentGroupId: "g-ma71" }), "GROUP", "g-7a", roster)).toBe(true);
    expect(concerns(lesson({ studentGroupId: "g-ma71" }), "GROUP", "g-7b", roster)).toBe(false);
    // And on the teaching group's own week.
    expect(concerns(lesson({ studentGroupId: "g-ma71" }), "GROUP", "g-ma71", roster)).toBe(true);
    // Until the roster has arrived, only by name.
    expect(concerns(lesson({ studentGroupId: "g-ma71" }), "GROUP", "g-7a")).toBe(false);
    expect(concerns(lesson({ studentGroupId: "g-ma71" }), "GROUP", "g-ma71")).toBe(true);
  });

  it("draws Ma71's lesson on 7A's sheet", () => {
    const sheet = candidateSheet({
      lessons: [lesson({ studentGroupId: "g-ma71", subjectId: "s-ma" })],
      kind: "GROUP",
      targetId: "g-7a",
      title: "7A",
      school: "Förslag 1",
      monday: "2026-10-12",
      year: YEAR,
      names: { ...names, group: (id: string) => (id === "g-ma71" ? "Ma71" : names.group(id)) },
      roster,
    });
    expect(sheet.days[0]!.lessons).toEqual([
      { start: "08:00", end: "09:00", subject: "Matematik", groups: ["Ma71"], room: "Sal 1", teachers: ["Anna Ek"] },
    ]);
  });

  it("puts a co-teacher's lessons on their week, and a room's on the room's", () => {
    expect(concerns(lesson({ teacherId: "t-2", coTeacherId: "t-1" }), "TEACHER", "t-1")).toBe(true);
    expect(concerns(lesson({ teacherId: "t-2" }), "TEACHER", "t-1")).toBe(false);
    expect(concerns(lesson(), "ROOM", "r-1")).toBe(true);
    expect(concerns(lesson({ roomId: null }), "ROOM", "r-1")).toBe(false);
  });
});

describe("candidateSheet", () => {
  it("lays the target's lessons on the days they run, named, in clock order", () => {
    const sheet = candidateSheet({
      lessons: [
        lesson({ id: "late", startTime: "10:00:00", endTime: "11:00:00", subjectId: "s-sv", coTeacherId: "t-2" }),
        lesson({ id: "early" }),
        lesson({ id: "odd", dayOfWeek: 2, recurrence: "ODD_WEEKS" }),
        lesson({ id: "other", studentGroupId: "g-7b" }),
      ],
      kind: "GROUP",
      targetId: "g-7a",
      title: "7A",
      school: "Förslag 2: Färre håltimmar för lärarna",
      monday: "2026-10-12",
      year: YEAR,
      names,
    });

    expect(sheet.kind).toBe("GROUP");
    expect(sheet.school).toBe("Förslag 2: Färre håltimmar för lärarna");
    expect(sheet.week).toEqual({ from: "2026-10-12", to: "2026-10-18", isoWeek: "2026-W42" });
    expect(sheet.days).toHaveLength(7);
    expect(sheet.days[0]!.lessons).toEqual([
      { start: "08:00", end: "09:00", subject: "Matematik", groups: ["7A"], room: "Sal 1", teachers: ["Anna Ek"] },
      { start: "10:00", end: "11:00", subject: "Svenska", groups: ["7A"], room: "Sal 1", teachers: ["Anna Ek", "Bo Ek"] },
    ]);
    // Week 42 is even: the odd-weeks lesson is not on this sheet.
    expect(sheet.days[1]!.lessons).toEqual([]);
  });

  it("draws an unknown name as the sheet's own placeholder, never an id", () => {
    const sheet = candidateSheet({
      lessons: [lesson({ studentGroupId: "g-unknown", roomId: "r-unknown", teacherId: "t-unknown" })],
      kind: "TEACHER",
      targetId: "t-unknown",
      title: "Lärare",
      school: "Förslag 1",
      monday: "2026-10-12",
      year: YEAR,
      names,
    });
    expect(sheet.days[0]!.lessons[0]).toMatchObject({ groups: [null], room: null, teachers: [] });
  });

  it("draws nothing on a day before the läsår starts or after it ends", () => {
    const week = [1, 2, 3, 4, 5].map((dayOfWeek) => lesson({ id: `d-${dayOfWeek}`, dayOfWeek }));
    const at = (year: { startDate: string; endDate: string }, monday: string) =>
      candidateSheet({ lessons: week, kind: "GROUP", targetId: "g-7a", title: "7A", school: "Förslag 1", monday, year, names })
        .days.map((day) => day.lessons.length);

    // A Wednesday start, 18 August 2027: the Monday and Tuesday are no school days.
    const wednesday = { startDate: "2027-08-18", endDate: "2028-06-07" };
    expect(at(wednesday, referenceMonday(wednesday, "2027-04-10"))).toEqual([0, 0, 1, 1, 1, 0, 0]);
    // A Sunday start, 15 August 2027: the sheet is the week after it, whole.
    const sunday = { startDate: "2027-08-15", endDate: "2028-06-07" };
    expect(at(sunday, referenceMonday(sunday, "2027-04-10"))).toEqual([1, 1, 1, 1, 1, 0, 0]);
    // The last week, ending on Wednesday 7 June 2028.
    expect(at(wednesday, referenceMonday(wednesday, "2028-07-01"))).toEqual([1, 1, 1, 0, 0, 0, 0]);
  });
});
