import { describe, expect, it } from "vitest";
import {
  cellValue,
  formatPercent,
  groupsInSubject,
  kpis,
  loadBarSegments,
  matrixColumns,
} from "./staffing-view";
import type { TeacherLoad, TeacherLoadReport } from "./teacher-load";

const teacher = (overrides: Partial<TeacherLoad> = {}): TeacherLoad => ({
  userId: "t-1",
  employment: null,
  targetMinutesPerWeek: 1080,
  assignedMinutesPerWeek: 900,
  peakMinutesPerWeek: 960,
  dutyMinutesPerWeek: 0,
  countedDutyMinutesPerWeek: 0,
  countedMinutesPerWeek: 900,
  balanceMinutesPerWeek: 180,
  percentOfTarget: 83.3,
  status: "UNDER",
  requirementCount: 2,
  dutyCount: 0,
  subjects: [
    {
      subjectId: "s-ma",
      subjectName: "Matematik",
      minutesPerWeek: 600,
      shareOfTeaching: 0.6667,
      percentOfEmployment: 53.3,
      percentOfFullTime: 55.6,
    },
    {
      subjectId: "s-no",
      subjectName: "NO",
      minutesPerWeek: 300,
      shareOfTeaching: 0.3333,
      percentOfEmployment: 26.7,
      percentOfFullTime: 27.8,
    },
  ],
  annual: { assignedHoursPerYear: 600, regulatedHoursPerYear: 1088, workDaysPerYear: 194 },
  ...overrides,
});

describe("formatPercent", () => {
  it("writes one decimal with a comma and drops a trailing zero", () => {
    expect(formatPercent(53.3)).toBe("53,3");
    expect(formatPercent(80)).toBe("80");
    expect(formatPercent(66.667)).toBe("66,7");
  });
});

describe("matrixColumns", () => {
  it("lists only taught subjects, sorted by code, naming unknown ones from the report", () => {
    const report = { teachers: [teacher()] };
    const columns = matrixColumns(report, [
      { id: "s-no", name: "Naturorientering", code: "NO" },
      { id: "s-ma", name: "Matematik", code: "MA" },
      { id: "s-sv", name: "Svenska", code: "SV" },
    ]);
    expect(columns.map((column) => column.id)).toEqual(["s-ma", "s-no"]);

    const orphan = matrixColumns(report, []);
    expect(orphan.map((column) => column.name)).toEqual(["Matematik", "NO"]);
  });
});

describe("cellValue", () => {
  it("prints minutes, or the SCB share as a percentage", () => {
    expect(cellValue(teacher(), "s-ma", "minutes")?.text).toBe("600");
    expect(cellValue(teacher(), "s-ma", "percent")?.text).toBe("53,3 %");
    expect(cellValue(teacher(), "s-sv", "minutes")).toBeNull();
  });

  it("leaves the percent cell empty for a teacher without a post", () => {
    const noPost = teacher({
      subjects: [{ ...teacher().subjects[0]!, percentOfEmployment: null }],
    });
    expect(cellValue(noPost, "s-ma", "percent")).toBeNull();
    expect(cellValue(noPost, "s-ma", "minutes")?.text).toBe("600");
  });
});

describe("groupsInSubject", () => {
  it("collects the groups a teacher carries in the subject, as lead or co-teacher, once each", () => {
    const requirements = [
      { subjectId: "s-ma", studentGroupId: "g-7a", teacherId: "t-1", coTeacherId: null },
      { subjectId: "s-ma", studentGroupId: "g-7b", teacherId: "t-2", coTeacherId: "t-1" },
      { subjectId: "s-ma", studentGroupId: "g-7c", teacherId: "t-2", coTeacherId: null },
      { subjectId: "s-no", studentGroupId: "g-7a", teacherId: "t-1", coTeacherId: null },
    ];
    const names: Record<string, string> = { "g-7a": "7A", "g-7b": "7B", "g-7c": "7C" };
    expect(groupsInSubject(requirements, "t-1", "s-ma", (id) => names[id]!)).toEqual(["7A", "7B"]);
  });
});

describe("loadBarSegments", () => {
  it("fills to the target with the remainder green", () => {
    const segments = loadBarSegments({ assignedMinutesPerWeek: 900, targetMinutesPerWeek: 1080 });
    expect(segments).toEqual({
      duty: 0,
      teaching: 900 / 1080,
      remaining: 180 / 1080,
      over: 0,
      dutyMinutes: 0,
      teachingMinutes: 900,
      remainingMinutes: 180,
      overMinutes: 0,
      countedDutyMinutes: 0,
    });
  });

  it("scales to the assigned minutes when over, so the excess is red and nothing overflows", () => {
    const segments = loadBarSegments({ assignedMinutesPerWeek: 1200, targetMinutesPerWeek: 1080 });
    expect(segments.teaching).toBeCloseTo(1080 / 1200, 10);
    expect(segments.over).toBeCloseTo(120 / 1200, 10);
    expect(segments.remaining).toBe(0);
    expect(segments.teaching + segments.over).toBeCloseTo(1, 10);
  });

  it("is teaching alone without a target", () => {
    expect(loadBarSegments({ assignedMinutesPerWeek: 300, targetMinutesPerWeek: null })).toMatchObject({
      teaching: 1,
      remaining: 0,
      over: 0,
      teachingMinutes: 300,
    });
    expect(loadBarSegments({ assignedMinutesPerWeek: 0, targetMinutesPerWeek: null }).teaching).toBe(0);
  });

  it("reads the peak week when asked", () => {
    const segments = loadBarSegments(
      { assignedMinutesPerWeek: 900, targetMinutesPerWeek: 1080 },
      "peak",
      1100,
    );
    expect(segments.overMinutes).toBe(20);
  });
});

describe("loadBarSegments with uppdrag", () => {
  it("draws an uncounted uppdrag before the comparison, widening the bar without moving the target", () => {
    // 900 teaching, 90 min mentorskap that does not count, target 1080.
    const segments = loadBarSegments({
      assignedMinutesPerWeek: 900,
      targetMinutesPerWeek: 1080,
      dutyMinutesPerWeek: 90,
      countedDutyMinutesPerWeek: 0,
    });
    expect(segments.dutyMinutes).toBe(90);
    expect(segments.remainingMinutes).toBe(180);
    expect(segments.overMinutes).toBe(0);
    expect(segments.duty).toBeCloseTo(90 / 1170, 10);
    expect(segments.duty + segments.teaching + segments.remaining).toBeCloseTo(1, 10);
  });

  it("puts a counted uppdrag inside the teaching segment, where the report's status reads it", () => {
    // 1000 teaching + 120 pedagogisk lunch that counts = 1120 against 1080.
    const segments = loadBarSegments({
      assignedMinutesPerWeek: 1000,
      targetMinutesPerWeek: 1080,
      dutyMinutesPerWeek: 150,
      countedDutyMinutesPerWeek: 120,
    });
    expect(segments.countedDutyMinutes).toBe(120);
    expect(segments.teachingMinutes).toBe(1080);
    expect(segments.overMinutes).toBe(40);
    // Only the 30 uncounted minutes are drawn as uppdrag.
    expect(segments.dutyMinutes).toBe(30);
    expect(segments.duty + segments.teaching + segments.over).toBeCloseTo(1, 10);
  });

  it("adds the uppdrag to the peak week too, since they have no week pattern", () => {
    const segments = loadBarSegments(
      {
        assignedMinutesPerWeek: 900,
        targetMinutesPerWeek: 1080,
        dutyMinutesPerWeek: 60,
        countedDutyMinutesPerWeek: 60,
      },
      "peak",
      1050,
    );
    expect(segments.overMinutes).toBe(30);
  });

  it("splits the whole width between uppdrag and teaching without a target", () => {
    const segments = loadBarSegments({
      assignedMinutesPerWeek: 300,
      targetMinutesPerWeek: null,
      dutyMinutesPerWeek: 100,
      countedDutyMinutesPerWeek: 0,
    });
    expect(segments.duty).toBeCloseTo(0.25, 10);
    expect(segments.teaching).toBeCloseTo(0.75, 10);
  });
});

describe("kpis", () => {
  const report = (overrides: Partial<TeacherLoadReport> = {}): TeacherLoadReport => ({
    teachers: [teacher({ status: "OVER" }), teacher({ userId: "t-2" })],
    unstaffedRequirements: [
      {
        requirementId: "r1",
        subjectId: "s-ma",
        subjectName: "Matematik",
        studentGroupId: "g",
        groupName: "7A",
        minutesPerWeek: 180,
        teacherMinutesPerWeek: 180,
        gradeSpan: null,
      },
    ],
    unqualifiedAssignments: [],
    qualificationsRecorded: false,
    subjectBottlenecks: [],
    bottlenecksComputed: false,
    totals: { teacherMinutesPerWeek: 0, lessonMinutesPerWeek: 0, dutyMinutesPerWeek: 0 },
    ...overrides,
  });

  it("counts, and reads an unchecked school as null rather than zero", () => {
    expect(kpis(report())).toEqual({
      unstaffed: 1,
      unqualified: null,
      overTarget: 1,
      bottlenecks: null,
    });
    expect(kpis(report({ qualificationsRecorded: true })).unqualified).toBe(0);
  });

  it("counts only the short subjects as bottlenecks, and nothing when capacity is unknown", () => {
    const bottleneck = (subjectId: string, short: boolean) => ({
      subjectId,
      subjectName: subjectId,
      unstaffedCount: 1,
      demandedMinutesPerWeek: 180,
      qualifiedRemainingMinutesPerWeek: short ? 60 : 600,
      qualifiedTeacherCount: 1,
      qualifiedNoTargetCount: 0,
      short,
    });
    const computed = report({
      bottlenecksComputed: true,
      subjectBottlenecks: [bottleneck("s-ma", true), bottleneck("s-no", false)],
    });
    expect(kpis(computed).bottlenecks).toBe(1);
    expect(kpis(report({ bottlenecksComputed: true })).bottlenecks).toBe(0);
  });
});
