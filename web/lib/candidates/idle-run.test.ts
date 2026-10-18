import { describe, expect, it } from "vitest";
import type { MasterLesson } from "@/lib/types";
import { idleContextOf, idleOf, type IdleInputs } from "./idle-run";
import { currentWeek, type OriginMaster } from "./lessons";

/*
 * Through the real findIdleGaps and the real conflict engine, on a school of
 * four pupils: what idle-run adds is the wiring — the roster, the halves, the
 * fixed minimum — and only a real run shows the wiring is right.
 */

let seq = 0;
function lesson(studentGroupId: string, start: string, end: string, overrides: Partial<OriginMaster> = {}): OriginMaster {
  seq += 1;
  return {
    id: `l-${seq}`,
    academicYearId: "y-1",
    subjectId: "s-1",
    studentGroupId,
    teacherId: "t-1",
    coTeacherId: null,
    roomId: null,
    dayOfWeek: 1,
    startTime: `${start}:00`,
    endTime: `${end}:00`,
    isLocked: false,
    isParked: false,
    isGenerated: true,
    recurrence: "ALL_WEEKS",
    startDate: null,
    endDate: null,
    extraGroupIds: [],
    studentIds: [],
    ...overrides,
  };
}

function inputs(overrides: Partial<IdleInputs> = {}): IdleInputs {
  return {
    constraints: [],
    requirements: [],
    studentGroupOf: new Map([
      ["p-1", "g-7a"],
      ["p-2", "g-7a"],
      ["p-3", "g-7a"],
      ["p-4", "g-7a"],
      // Another year's pupil: not one of this year's classes, not in the denominator.
      ["p-9", "g-old"],
    ]),
    memberships: [],
    groups: [
      { id: "g-7a", academicYearId: "y-1", kind: "CLASS", gradeLevel: 7, halfOfId: null },
      { id: "g-ma71", academicYearId: "y-1", kind: "TEACHING_GROUP", gradeLevel: null, halfOfId: null },
      { id: "g-old", academicYearId: "y-0", kind: "CLASS", gradeLevel: 7, halfOfId: null },
    ],
    frameTimes: [],
    lunch: null,
    academicYearId: "y-1",
    teacherIds: ["t-1", "t-2"],
    ...overrides,
  };
}

const measure = (week: MasterLesson[], overrides: Partial<IdleInputs> = {}) => idleOf(week, idleContextOf(inputs(overrides)));

describe("idleOf — one grundschema's håltimmar", () => {
  it("counts a hole between a teacher's and a class's lessons, per pupil", () => {
    const summary = measure([lesson("g-7a", "08:00", "09:00"), lesson("g-7a", "11:00", "12:00")]);

    expect(summary.teachers).toEqual({ minutes: 120, count: 1, worst: 120 });
    // Four pupils idle 120 minutes, over the four pupils of this year's classes.
    expect(summary.pupils).toEqual({ minutesPerPupil: 120, classes: 1, worst: 120 });
    expect(summary.perTeacher).toEqual(new Map([["t-1", 120]]));
  });

  it("reads the roster: a teaching group's lesson fills the hole for its own pupils only", () => {
    const summary = measure(
      [
        lesson("g-7a", "08:00", "09:00"),
        lesson("g-ma71", "09:00", "10:00", { teacherId: "t-2" }),
        lesson("g-7a", "11:00", "12:00"),
      ],
      { memberships: [{ studentId: "p-1", studentGroupId: "g-ma71" }, { studentId: "p-2", studentGroupId: "g-ma71" }] },
    );

    // p-1 and p-2 wait 60 minutes, p-3 and p-4 120: (2 × 60 + 2 × 120) / 4.
    expect(summary.pupils.minutesPerPupil).toBe(90);
    expect(summary.pupils.worst).toBe(120);
  });

  it("counts an every-other-week hole at half, and the worst week whole", () => {
    const summary = measure([
      lesson("g-7a", "08:00", "09:00"),
      lesson("g-7a", "09:00", "10:00", { teacherId: "t-2", recurrence: "ODD_WEEKS" }),
      lesson("g-7a", "11:00", "12:00"),
    ]);

    // Odd weeks a 60-minute hole, even weeks 120: the average week is 90.
    expect(summary.pupils.minutesPerPupil).toBe(90);
    expect(summary.pupils.worst).toBe(120);
    // t-1 is not in the odd-week lesson: 120 every week.
    expect(summary.perTeacher.get("t-1")).toBe(120);
  });

  it("holds the minimum at 15 minutes: a ten-minute change is a rast", () => {
    const summary = measure([lesson("g-7a", "08:00", "09:00"), lesson("g-7a", "09:10", "10:00")]);
    expect(summary.teachers.count).toBe(0);
    expect(summary.pupils.classes).toBe(0);
  });

  it("knows a split class's halves, so the hour they rotate through is no håltimme", () => {
    const week = [
      lesson("g-7a", "08:00", "09:00"),
      lesson("g-7a-1", "09:00", "10:00", { teacherId: "t-2" }),
      lesson("g-7a", "10:00", "11:00"),
    ];
    const halves = [
      { id: "g-7a-1", academicYearId: "y-1", kind: "TEACHING_GROUP" as const, gradeLevel: null, halfOfId: "g-7a" },
      { id: "g-7a-2", academicYearId: "y-1", kind: "TEACHING_GROUP" as const, gradeLevel: null, halfOfId: "g-7a" },
    ];
    const groups = [...inputs().groups, ...halves];

    // Nobody is placed in a half yet, so every pupil may be in either.
    expect(measure(week, { groups }).pupils.classes).toBe(0);
    // Without the halves the same week would report the hour for all of 7A.
    expect(measure(week, { groups: groups.map((group) => ({ ...group, halfOfId: null })) }).pupils.classes).toBe(1);
  });

  it("is measured on the week as drawn: a parked lesson fills no hole", () => {
    const draft = [
      lesson("g-7a", "08:00", "09:00"),
      lesson("g-7a", "09:00", "11:00", { isParked: true }),
      lesson("g-7a", "11:00", "12:00"),
    ];
    expect(measure(currentWeek(draft)).teachers.minutes).toBe(120);
  });

  it("credits the school's lunch, as /admin/gaps does", () => {
    const week = [lesson("g-7a", "10:00", "11:00"), lesson("g-7a", "12:00", "13:00")];
    const lunch = {
      id: "lunch",
      lunchEnabled: true,
      lunchStartTime: "11:00",
      lunchEndTime: "12:30",
      lunchMinutes: 30,
      diningSeats: null,
      maxLessonsPerDayPerGroup: null,
    };
    expect(measure(week, { lunch }).teachers.minutes).toBe(30);
  });
});
