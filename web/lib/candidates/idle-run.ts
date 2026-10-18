import { buildGroupConflictMap, buildPupilBufferMap, toPlacement, type GroupConflictMap, type PupilBufferMap } from "@/lib/conflicts";
import { findIdleGaps, type GroupMembership } from "@/lib/gaps";
import { buildGradeSpans, type GradeSpan } from "@/lib/grade-span";
import type { FrameTime } from "@/lib/frame-times";
import type { AvailabilityConstraint, LunchSettings, MasterLesson, StudentGroupKind } from "@/lib/types";
import { IDLE_MINIMUM_MINUTES, summarizeIdle, type IdleSummary } from "./idle";

/*
 * The håltimmar of one grundschema, computed. The heavy half of the
 * comparison: it runs lib/gaps.ts's findIdleGaps, and through it the conflict
 * engine, so only the compare page's lazy module imports it.
 *
 * The inputs are /admin/gaps' own — the roster (home classes and every
 * teaching-group membership), the conflict map, the years each group holds,
 * the ramtider, the availability rules, the pupils' ombyte and dusch around a
 * lesson, the school's lunch, and the classes' halves — so a candidate's
 * figure is the figure that page would show the day after the apply. Two
 * readings are fixed rather than the reader's: the minimum (15 minutes, a
 * rast below it) and parked lessons, which occupy nothing (lessons.ts leaves
 * them out of both weeks).
 */

export interface IdleInputs {
  constraints: readonly AvailabilityConstraint[];
  /** For the pupils' minutes before and after a lesson (ombyte, dusch). */
  requirements: ReadonlyArray<{ studentGroupId: string; subjectId: string; minutesBefore: number; minutesAfter: number }>;
  /** Every active pupil → their home class (the planned year's, for a year not yet activated). */
  studentGroupOf: ReadonlyMap<string, string | null>;
  memberships: readonly GroupMembership[];
  /** The school's groups: years, kinds and the halves of a split class. */
  groups: ReadonlyArray<{ id: string; academicYearId: string; kind: StudentGroupKind; gradeLevel: number | null; halfOfId?: string | null }>;
  frameTimes: readonly FrameTime[];
  lunch: LunchSettings | null;
  academicYearId: string;
  /** The active teachers, whose håltimmar are counted. */
  teacherIds: readonly string[];
}

/** What every week of one comparison is measured against: built once, read per week. */
export interface IdleContext {
  inputs: IdleInputs;
  studentGroupOf: Map<string, string | null>;
  groupConflicts: GroupConflictMap;
  gradeSpanOf: Map<string, GradeSpan>;
  pupilBuffers: PupilBufferMap;
  /** The year's classes. Home classes only: a teaching group is the same pupils again. */
  classIds: string[];
  yearGroups: IdleInputs["groups"];
  /** Pupils whose home class is one of `classIds`: the per-pupil figure's denominator. */
  pupils: number;
}

export function idleContextOf(inputs: IdleInputs): IdleContext {
  const studentGroupOf = new Map(inputs.studentGroupOf);
  const groups = [...inputs.groups];
  const yearGroups = groups.filter((group) => group.academicYearId === inputs.academicYearId);
  const classIds = yearGroups.filter((group) => group.kind === "CLASS").map((group) => group.id);
  const classes = new Set(classIds);
  const membersByGroup = new Map<string, string[]>();
  for (const row of inputs.memberships) {
    const list = membersByGroup.get(row.studentGroupId);
    if (list) list.push(row.studentId);
    else membersByGroup.set(row.studentGroupId, [row.studentId]);
  }
  return {
    inputs,
    studentGroupOf,
    groupConflicts: buildGroupConflictMap(studentGroupOf, [...inputs.memberships], groups),
    gradeSpanOf: buildGradeSpans({ groups, membersByGroup, homeClassOf: studentGroupOf }),
    pupilBuffers: buildPupilBufferMap([...inputs.requirements]),
    classIds,
    yearGroups,
    pupils: [...studentGroupOf.values()].filter((home) => home !== null && classes.has(home)).length,
  };
}

/** One week's håltimmar, as findIdleGaps reports them, added up (idle.ts). */
export function idleOf(week: readonly MasterLesson[], context: IdleContext): IdleSummary {
  const { inputs } = context;
  const reports = findIdleGaps({
    placements: week.map((lesson) => toPlacement(lesson, context.pupilBuffers)),
    constraints: [...inputs.constraints],
    groupConflicts: context.groupConflicts,
    studentGroupOf: context.studentGroupOf,
    gradeSpanOf: context.gradeSpanOf,
    frameTimes: [...inputs.frameTimes],
    // Always a roster, never "unknown": the page waits for the memberships,
    // and an empty list is a school whose pupils sit only in their classes.
    memberships: [...inputs.memberships],
    studentGroupIds: context.classIds,
    teacherIds: [...inputs.teacherIds],
    lunch: inputs.lunch,
    minimumMinutes: IDLE_MINIMUM_MINUTES,
    groups: context.yearGroups,
  });
  return summarizeIdle(reports, context.pupils);
}
