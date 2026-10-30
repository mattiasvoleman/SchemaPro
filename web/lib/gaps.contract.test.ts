import { describe, expect, it } from "vitest";
import cases from "../../src/common/__fixtures__/pupil-gaps-cases.json";
import { buildPupilBufferMap, pupilBufferOf, type Placement } from "@/lib/conflicts";
import { findIdleGaps } from "@/lib/gaps";
import { IDLE_MINIMUM_MINUTES, pupilMinutesOf } from "@/lib/candidates/idle";
import type { AvailabilityConstraint, LunchSettings } from "@/lib/types";
import type { FrameTime } from "@/lib/frame-times";
import type { GradeSpan } from "@/lib/grade-span";

/*
 * The report's side of the contract (src/common/__fixtures__/pupil-gaps-cases.json):
 * each case's school, its timetable laid, through findIdleGaps at the
 * generator's minimum, added up as the candidates' comparison adds it — the
 * number the Håltimmar page shows as the generator's. The engine counts the
 * same timetable to the same number (optimization-engine/tests/test_pupil_gaps.py),
 * from the cohorts the gateway sends (src/optimization/pupil-cohorts.spec.ts).
 */

interface SchoolCase {
  name: string;
  why: string;
  groups: { id: string; kind: string; halfOfId: string | null; replacesSubjectId: string | null; years: [number, number] }[];
  pupils: { id: string; home: string; groups: string[] }[];
  buffers: { group: string; subject: string; minutesBefore: number; minutesAfter: number }[];
  lessons: {
    id: string;
    groups: string[];
    subject: string;
    day: number;
    start: string;
    end: string;
    pupils: string[];
    locked: boolean;
    /** A/B-veckor: absent is every week. */
    weeks?: "ODD_WEEKS" | "EVEN_WEEKS";
  }[];
  constraints: {
    kind: "STUDENT_GROUP" | "GRADE_LEVEL";
    group: string | null;
    min: number | null;
    max: number | null;
    day: number;
    start: string;
    end: string;
  }[];
  frames: { min: number; max: number; day: number | null; start: string; end: string }[];
  lunch: { start: string; end: string; minutes: number } | null;
  pupilIdleMinutes: number;
}

const all = (cases as unknown as { cases: SchoolCase[] }).cases;

const minutes = (clock: string): number => {
  const [hours, mins] = clock.split(":").map(Number);
  return hours! * 60 + mins!;
};

function countOf(school: SchoolCase): number {
  const buffers = buildPupilBufferMap(
    school.buffers.map((row) => ({
      studentGroupId: row.group,
      subjectId: row.subject,
      minutesBefore: row.minutesBefore,
      minutesAfter: row.minutesAfter,
    })),
  );
  const placements: Placement[] = school.lessons.map((lesson) => {
    const shape = { studentGroupId: lesson.groups[0]!, extraGroupIds: lesson.groups.slice(1), subjectId: lesson.subject };
    return {
      ...(pupilBufferOf(buffers, shape) ?? {}),
      ...shape,
      id: lesson.id,
      dayOfWeek: lesson.day,
      startMinutes: minutes(lesson.start),
      endMinutes: minutes(lesson.end),
      teacherId: null,
      roomId: null,
      studentIds: lesson.pupils,
      recurrence: lesson.weeks ?? "ALL_WEEKS",
      startDate: null,
      endDate: null,
    };
  });
  const constraints: AvailabilityConstraint[] = school.constraints.map((rule, index) => ({
    id: `c${index}`,
    resourceType: rule.kind,
    userId: null,
    roomId: null,
    studentGroupId: rule.group,
    minGradeLevel: rule.min,
    maxGradeLevel: rule.max,
    dayOfWeek: rule.day,
    date: null,
    startTime: rule.start,
    endTime: rule.end,
    type: "UNAVAILABLE",
    reason: null,
  }));
  const frameTimes: FrameTime[] = school.frames.map((frame, index) => ({
    id: `f${index}`,
    minGradeLevel: frame.min,
    maxGradeLevel: frame.max,
    dayOfWeek: frame.day,
    startTime: frame.start,
    endTime: frame.end,
    changeoverMinutes: 0,
  }));
  const lunch = school.lunch
    ? ({
        id: "lunch",
        lunchEnabled: true,
        lunchStartTime: school.lunch.start,
        lunchEndTime: school.lunch.end,
        lunchMinutes: school.lunch.minutes,
        diningSeats: null,
        maxLessonsPerDayPerGroup: null,
      } as LunchSettings)
    : null;
  const reports = findIdleGaps({
    placements,
    constraints,
    frameTimes,
    studentGroupOf: new Map(school.pupils.map((pupil) => [pupil.id, pupil.home])),
    memberships: school.pupils.flatMap((pupil) =>
      pupil.groups.map((groupId) => ({ studentId: pupil.id, studentGroupId: groupId })),
    ),
    gradeSpanOf: new Map<string, GradeSpan>(
      school.groups.map((group) => [group.id, { min: group.years[0], max: group.years[1] }]),
    ),
    groups: school.groups.map((group) => ({ ...group, academicYearId: "y" })),
    studentGroupIds: school.groups.filter((group) => group.kind === "CLASS").map((group) => group.id),
    lunch,
    minimumMinutes: IDLE_MINIMUM_MINUTES,
  });
  return pupilMinutesOf(reports);
}

describe("the håltimmesrapport's number for the generator", () => {
  it.each(all.map((school) => [school.name, school] as const))("%s", (_name, school) => {
    expect(countOf(school), school.why).toBe(school.pupilIdleMinutes);
  });
});
