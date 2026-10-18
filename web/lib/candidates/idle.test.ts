import { describe, expect, it } from "vitest";
import type { GapReport, IdleGap } from "@/lib/gaps";
import {
  idleDelta,
  standardWeekMinutes,
  standardWeekPupilMinutes,
  summarizeIdle,
  weekShare,
  worseFor,
} from "./idle";

const gap = (overrides: Partial<IdleGap> = {}): IdleGap => ({
  dayOfWeek: 1,
  startMinutes: 600,
  endMinutes: 660,
  weeks: "ALL_WEEKS",
  minutes: 60,
  lunchMinutes: 0,
  idleMinutes: 60,
  idleStudents: 0,
  ...overrides,
});

const teacher = (id: string, gaps: IdleGap[], totalMinutes: number): GapReport => ({
  subjectId: id,
  kind: "TEACHER",
  gaps,
  totalMinutes,
  worstMinutes: Math.max(...gaps.map((entry) => entry.idleMinutes)),
  studentCount: 0,
});

const klass = (id: string, gaps: IdleGap[], totalMinutes: number, studentCount: number): GapReport => ({
  subjectId: id,
  kind: "STUDENT_GROUP",
  gaps,
  totalMinutes,
  worstMinutes: Math.max(...gaps.map((entry) => entry.idleMinutes)),
  studentCount,
});

describe("the average week", () => {
  it("counts a hole of every week whole and one of every other week by half", () => {
    expect(weekShare("ALL_WEEKS")).toBe(1);
    expect(weekShare("ODD_WEEKS")).toBe(0.5);
    expect(weekShare("EVEN_WEEKS")).toBe(0.5);
  });

  it("adds a teacher's holes at their share of the weeks", () => {
    expect(
      standardWeekMinutes([gap({ idleMinutes: 40 }), gap({ weeks: "ODD_WEEKS", idleMinutes: 60 }), gap({ weeks: "EVEN_WEEKS", idleMinutes: 20 })]),
    ).toBe(80);
  });

  it("counts a class's hole once per pupil sitting in it", () => {
    // 14 of 7A idle for 60 minutes every week, the whole 30 for 40 on odd weeks.
    expect(
      standardWeekPupilMinutes([gap({ idleMinutes: 60, idleStudents: 14 }), gap({ weeks: "ODD_WEEKS", idleMinutes: 40, idleStudents: 30 })]),
    ).toBe(14 * 60 + 0.5 * 30 * 40);
  });
});

describe("summarizeIdle", () => {
  const reports = [
    teacher("t-1", [gap({ idleMinutes: 60 }), gap({ weeks: "ODD_WEEKS", idleMinutes: 40 })], 100),
    teacher("t-2", [gap({ idleMinutes: 30 })], 30),
    klass("g-7a", [gap({ idleMinutes: 60, idleStudents: 10 })], 60, 30),
    klass("g-7b", [gap({ idleMinutes: 45, idleStudents: 20 })], 45, 20),
  ];

  it("adds the teachers up, counts them and names the worst week", () => {
    const summary = summarizeIdle(reports, 100);
    expect(summary.teachers).toEqual({ minutes: 80 + 30, count: 2, worst: 100 });
    expect(summary.perTeacher).toEqual(new Map([["t-1", 80], ["t-2", 30]]));
  });

  it("divides pupil-minutes by every pupil of the classes, reported or not", () => {
    // 10 × 60 + 20 × 45 = 1500 pupil-minutes over 100 pupils, of whom only 50
    // are in a class with a håltimme.
    const summary = summarizeIdle(reports, 100);
    expect(summary.pupils).toEqual({ minutesPerPupil: 15, classes: 2, worst: 60 });
  });

  it("reads a school with no pupils, or no håltimmar, as zero rather than dividing by nothing", () => {
    expect(summarizeIdle([], 0)).toEqual({
      teachers: { minutes: 0, count: 0, worst: 0 },
      pupils: { minutesPerPupil: 0, classes: 0, worst: 0 },
      perTeacher: new Map(),
    });
  });
});

describe("a candidate against the current grundschema", () => {
  const current = summarizeIdle([teacher("t-1", [gap({ idleMinutes: 60 })], 60), klass("g-7a", [gap({ idleStudents: 30 })], 60, 30)], 30);
  const candidate = summarizeIdle([teacher("t-1", [gap({ idleMinutes: 20 })], 20), teacher("t-2", [gap({ idleMinutes: 40 })], 40)], 30);

  it("says each figure's difference, positive for more håltimmar", () => {
    expect(idleDelta(candidate, current)).toEqual({
      teacherMinutes: 0,
      teacherCount: 1,
      teacherWorst: -20,
      minutesPerPupil: -60,
      classes: -1,
      pupilWorst: -60,
    });
  });

  it("names whom it gets worse for even when the school's total does not move", () => {
    expect(worseFor(current.perTeacher, candidate.perTeacher)).toEqual([{ teacherId: "t-2", before: 0, after: 40 }]);
  });

  it("lists the biggest growth first, ties by id, at most the limit", () => {
    const before = new Map([["a", 10], ["b", 10], ["c", 0]]);
    const after = new Map([["a", 40], ["b", 30], ["c", 30], ["d", 5]]);
    expect(worseFor(before, after, 3).map((entry) => entry.teacherId)).toEqual(["a", "c", "b"]);
  });
});
