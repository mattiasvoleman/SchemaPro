// Tjänstefördelningens belastningsrapport, as the browser computes it.
//
// A MIRROR OF src/staffing/teacher-load.ts, not a second opinion on it. The
// gateway computes the report for GET /staffing/load and the matrix page reads
// that answer; this copy exists for the figures the page has to state BEFORE a
// round trip, or without one — the riktmärke a saved post would derive to while
// the admin is still typing it, the reglerad timmar/år beside it, the "kvar"
// per candidate in the requirements dialog when the report is a moment stale,
// and the parity test that proves the two copies agree. The two packages share
// no build, so the module is written out again on this side rather than
// imported across the boundary, and both copies replay one fixture:
// src/staffing/__fixtures__/teacher-load-cases.json, asserted by
// teacher-load.contract.spec.ts there and teacher-load.contract.test.ts here.
// A case is added for both sides at once; the code is fixed, never the fixture.
//
// What the numbers mean — two weeks not one, the riktmärke being the school's
// or nothing, co-teaching counting fully for both, behörighet checked only when
// the school has said something — is argued in the gateway file's header and
// not repeated here. The one thing worth saying on this side: the week
// arithmetic comes from lib/teaching-hours.ts, which is the module the timplan
// page already prints hours from, so a teacher's standardvecka and a group's
// hours are one requirement counted the same way twice.
//
// The dates are handled in LOCAL time here, as everything in lib/teaching-hours
// is, where the gateway works in UTC. The contract test for the week arithmetic
// pins that the two give the same week counts; nothing in this file touches a
// Date of its own.

import {
  peakPerWeekByKey,
  teachingWeeks,
  type ClosedRange,
  type TeachingPeriod,
  type YearBounds,
} from "@/lib/teaching-hours";
import type {
  StaffingCheckMode,
  TeacherContractKind,
  TeacherQualificationKind,
} from "@/lib/types";

export type LoadStatus = "UNDER" | "OK" | "OVER" | "NO_TARGET";

export interface GradeSpan {
  min: number;
  max: number;
}

/** The policy fields the report reads. Null policy = the school has none yet. */
export interface LoadPolicy {
  fullTimeTeachingMinutesPerWeek: number | null;
  overAllocationTolerancePercent: number;
  fullTimeRegulatedHoursPerYear: number;
  workDaysPerYear: number;
  qualificationMode: StaffingCheckMode;
}

/**
 * What the table's defaults say when no row exists: the Bilaga M frame and
 * WARN, with no riktmärke — the same values STAFFING_POLICY_DEFAULTS writes on
 * the gateway for a PUT of nothing.
 */
export const DEFAULT_LOAD_POLICY: LoadPolicy = {
  fullTimeTeachingMinutesPerWeek: null,
  overAllocationTolerancePercent: 10,
  fullTimeRegulatedHoursPerYear: 1360,
  workDaysPerYear: 194,
  qualificationMode: "WARN",
};

export interface LoadEmployment {
  userId: string;
  employmentPercent: number;
  reductionPercent: number;
  contractKind: TeacherContractKind;
  teachingTargetMinutesPerWeek: number | null;
  signature: string | null;
}

export interface LoadRequirement extends TeachingPeriod {
  id: string;
  subjectId: string;
  subjectName: string;
  studentGroupId: string;
  groupName: string;
  teacherId: string | null;
  coTeacherId: string | null;
  lessonsPerWeek: number;
  minutesPerLesson: number;
  /**
   * The years the group actually holds, derived as lib/grade-span.ts derives
   * it: members' home classes, the group's own gradeLevel when it has no
   * members with one, null when neither says anything.
   */
  gradeSpan: GradeSpan | null;
}

export interface LoadQualification {
  userId: string;
  subjectId: string;
  minGradeLevel: number;
  maxGradeLevel: number;
  kind: TeacherQualificationKind;
  /** yyyy-mm-dd or null. */
  validFrom: string | null;
  validTo: string | null;
}

export interface LoadInput {
  year: YearBounds;
  policy: LoadPolicy | null;
  employments: LoadEmployment[];
  requirements: LoadRequirement[];
  qualifications: LoadQualification[];
  closures: ClosedRange[];
}

export interface SubjectLoad {
  subjectId: string;
  subjectName: string;
  /** Standardvecka minutes in this subject, whole minutes. */
  minutesPerWeek: number;
  /** minutes / the teacher's total, 0..1 to four decimals. */
  shareOfTeaching: number;
  /** employmentPercent × share — SCB's "tjänsteomfattning per ämne". Null without a post. */
  percentOfEmployment: number | null;
  /** minutes / the policy riktmärke. Null without one. */
  percentOfFullTime: number | null;
}

export interface TeacherLoad {
  userId: string;
  employment: LoadEmployment | null;
  targetMinutesPerWeek: number | null;
  /** Standardvecka, whole minutes. */
  assignedMinutesPerWeek: number;
  /** Toppvecka, whole minutes. */
  peakMinutesPerWeek: number;
  /** target − assigned: kvar till mål when positive, över mål when negative. */
  balanceMinutesPerWeek: number | null;
  percentOfTarget: number | null;
  status: LoadStatus;
  requirementCount: number;
  subjects: SubjectLoad[];
  annual: {
    /** Σ lessons × minutes × teaching weeks (lov subtracted) / 60, one decimal. */
    assignedHoursPerYear: number;
    /** policy.fullTimeRegulatedHoursPerYear × (tjänst − nedsättning) / 100. */
    regulatedHoursPerYear: number | null;
    workDaysPerYear: number;
  };
}

export interface UnstaffedRequirement {
  requirementId: string;
  subjectId: string;
  subjectName: string;
  studentGroupId: string;
  groupName: string;
  minutesPerWeek: number;
  gradeSpan: GradeSpan | null;
}

export interface UnqualifiedAssignment {
  requirementId: string;
  userId: string;
  role: "TEACHER" | "CO_TEACHER";
  subjectId: string;
  subjectName: string;
  studentGroupId: string;
  groupName: string;
  gradeSpan: GradeSpan | null;
}

export interface TeacherLoadReport {
  teachers: TeacherLoad[];
  unstaffedRequirements: UnstaffedRequirement[];
  unqualifiedAssignments: UnqualifiedAssignment[];
  /** False when the school has no qualification rows, so nothing was checked. */
  qualificationsRecorded: boolean;
  totals: {
    /** Σ over teachers of assigned minutes: a co-taught row counts twice. */
    teacherMinutesPerWeek: number;
    /** Σ over requirements of standardvecka minutes: every row once. */
    lessonMinutesPerWeek: number;
  };
}

/** Rounded to the solver's grid, like every other target this app states. */
export function round5(value: number): number {
  return Math.round(value / 5) * 5;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/**
 * How much of a standardvecka one requirement is worth, 0..1: undated rows 1
 * (every week) or 0.5 (varannan vecka); a dated row its share of the year's
 * teaching weeks, lov subtracted from both sides. The grade reaches the lov
 * arithmetic only for a single-grade group — see the gateway's header.
 */
export function standardWeekWeight(
  requirement: TeachingPeriod & { gradeSpan?: GradeSpan | null },
  year: YearBounds,
  closures: ClosedRange[],
): number {
  if (!requirement.startDate && !requirement.endDate) {
    return (requirement.recurrence ?? "ALL_WEEKS") === "ALL_WEEKS" ? 1 : 0.5;
  }
  const gradeLevel = singleGrade(requirement.gradeSpan ?? null);
  const yearWeeks = teachingWeeks({}, year, closures, gradeLevel);
  if (yearWeeks === 0) return 0;
  return teachingWeeks(requirement, year, closures, gradeLevel) / yearWeeks;
}

function singleGrade(span: GradeSpan | null): number | null {
  return span !== null && span.min === span.max ? span.min : null;
}

/**
 * The teacher's target for the week, or null for NO_TARGET. The per-teacher
 * override wins outright, even over a null riktmärke.
 */
export function targetMinutesPerWeek(
  employment: LoadEmployment | null,
  policy: LoadPolicy,
): number | null {
  if (!employment) return null;
  if (employment.teachingTargetMinutesPerWeek !== null) {
    return employment.teachingTargetMinutesPerWeek;
  }
  if (policy.fullTimeTeachingMinutesPerWeek === null) return null;
  const activePercent = employment.employmentPercent - employment.reductionPercent;
  return round5((policy.fullTimeTeachingMinutesPerWeek * activePercent) / 100);
}

/**
 * UNDER / OK / OVER against the target with the tolerance on BOTH sides, the
 * edges inclusive: exactly target × (1 + t/100) is OK, one minute more is OVER.
 */
export function loadStatus(
  assigned: number,
  target: number | null,
  tolerancePercent: number,
): LoadStatus {
  if (target === null) return "NO_TARGET";
  const band = (target * tolerancePercent) / 100;
  if (assigned > target + band) return "OVER";
  if (assigned < target - band) return "UNDER";
  return "OK";
}

/**
 * Whether one qualification covers a requirement: same subject, the whole
 * grade span inside the qualification's, and valid at some point of the year.
 * A requirement whose group has no derivable grade is covered by any
 * qualification in the subject.
 */
export function qualificationCovers(
  qualification: LoadQualification,
  requirement: Pick<LoadRequirement, "subjectId" | "gradeSpan">,
  year: YearBounds,
): boolean {
  if (qualification.subjectId !== requirement.subjectId) return false;
  if (qualification.validFrom && qualification.validFrom > year.endDate) return false;
  if (qualification.validTo && qualification.validTo < year.startDate) return false;
  const span = requirement.gradeSpan;
  if (span === null) return true;
  return qualification.minGradeLevel <= span.min && qualification.maxGradeLevel >= span.max;
}

interface Accumulator {
  assigned: number;
  annualMinutes: number;
  requirementCount: number;
  subjects: Map<string, { subjectName: string; minutes: number }>;
}

const STATUS_ORDER: Record<LoadStatus, number> = { OVER: 0, UNDER: 1, OK: 2, NO_TARGET: 3 };

export function buildTeacherLoadReport(input: LoadInput): TeacherLoadReport {
  const policy = input.policy ?? DEFAULT_LOAD_POLICY;
  const { year, closures } = input;

  const employmentByUser = new Map(input.employments.map((row) => [row.userId, row]));
  const accumulators = new Map<string, Accumulator>();
  const accumulatorFor = (userId: string): Accumulator => {
    let acc = accumulators.get(userId);
    if (!acc) {
      acc = { assigned: 0, annualMinutes: 0, requirementCount: 0, subjects: new Map() };
      accumulators.set(userId, acc);
    }
    return acc;
  };
  for (const employment of input.employments) accumulatorFor(employment.userId);

  const unstaffedRequirements: UnstaffedRequirement[] = [];
  const unqualifiedAssignments: UnqualifiedAssignment[] = [];
  const qualificationsRecorded = input.qualifications.length > 0;
  const checkQualifications = qualificationsRecorded && policy.qualificationMode !== "OFF";
  const qualificationsByUser = new Map<string, LoadQualification[]>();
  for (const qualification of input.qualifications) {
    const list = qualificationsByUser.get(qualification.userId) ?? [];
    list.push(qualification);
    qualificationsByUser.set(qualification.userId, list);
  }

  let lessonMinutesPerWeek = 0;
  const peakItems: (TeachingPeriod & { key: string; minutes: number })[] = [];

  for (const requirement of input.requirements) {
    const weeklyMinutes = requirement.lessonsPerWeek * requirement.minutesPerLesson;
    const weight = standardWeekWeight(requirement, year, closures);
    const standardMinutes = weeklyMinutes * weight;
    const annualMinutes =
      weeklyMinutes *
      teachingWeeks(requirement, year, closures, singleGrade(requirement.gradeSpan));
    lessonMinutesPerWeek += standardMinutes;

    if (requirement.teacherId === null) {
      unstaffedRequirements.push({
        requirementId: requirement.id,
        subjectId: requirement.subjectId,
        subjectName: requirement.subjectName,
        studentGroupId: requirement.studentGroupId,
        groupName: requirement.groupName,
        minutesPerWeek: Math.round(standardMinutes),
        gradeSpan: requirement.gradeSpan,
      });
    }

    const assignees: [string | null, UnqualifiedAssignment["role"]][] = [
      [requirement.teacherId, "TEACHER"],
      [requirement.coTeacherId, "CO_TEACHER"],
    ];
    for (const [userId, role] of assignees) {
      if (userId === null) continue;
      const acc = accumulatorFor(userId);
      acc.assigned += standardMinutes;
      acc.annualMinutes += annualMinutes;
      acc.requirementCount += 1;
      const subject = acc.subjects.get(requirement.subjectId) ?? {
        subjectName: requirement.subjectName,
        minutes: 0,
      };
      subject.minutes += standardMinutes;
      acc.subjects.set(requirement.subjectId, subject);
      peakItems.push({
        key: userId,
        minutes: weeklyMinutes,
        recurrence: requirement.recurrence,
        startDate: requirement.startDate,
        endDate: requirement.endDate,
      });

      if (checkQualifications) {
        const held = qualificationsByUser.get(userId) ?? [];
        if (!held.some((q) => qualificationCovers(q, requirement, year))) {
          unqualifiedAssignments.push({
            requirementId: requirement.id,
            userId,
            role,
            subjectId: requirement.subjectId,
            subjectName: requirement.subjectName,
            studentGroupId: requirement.studentGroupId,
            groupName: requirement.groupName,
            gradeSpan: requirement.gradeSpan,
          });
        }
      }
    }
  }

  const peaks = peakPerWeekByKey(
    peakItems,
    year,
    (item) => item.key,
    (item) => item.minutes,
  );

  let teacherMinutesPerWeek = 0;
  const teachers: TeacherLoad[] = [];
  for (const [userId, acc] of accumulators) {
    const employment = employmentByUser.get(userId) ?? null;
    const target = targetMinutesPerWeek(employment, policy);
    const assigned = Math.round(acc.assigned);
    teacherMinutesPerWeek += acc.assigned;
    const activePercent = employment
      ? employment.employmentPercent - employment.reductionPercent
      : null;

    const subjects: SubjectLoad[] = [...acc.subjects.entries()]
      .map(([subjectId, subject]) => {
        const share = acc.assigned > 0 ? subject.minutes / acc.assigned : 0;
        return {
          subjectId,
          subjectName: subject.subjectName,
          minutesPerWeek: Math.round(subject.minutes),
          shareOfTeaching: round4(share),
          percentOfEmployment:
            employment === null ? null : round1(employment.employmentPercent * share),
          percentOfFullTime:
            policy.fullTimeTeachingMinutesPerWeek === null
              ? null
              : round1((subject.minutes / policy.fullTimeTeachingMinutesPerWeek) * 100),
        };
      })
      .sort((a, b) => b.minutesPerWeek - a.minutesPerWeek || a.subjectId.localeCompare(b.subjectId));

    teachers.push({
      userId,
      employment,
      targetMinutesPerWeek: target,
      assignedMinutesPerWeek: assigned,
      peakMinutesPerWeek: Math.round(peaks.get(userId) ?? 0),
      balanceMinutesPerWeek: target === null ? null : target - assigned,
      percentOfTarget:
        target === null || target === 0 ? null : round1((acc.assigned / target) * 100),
      status: loadStatus(acc.assigned, target, policy.overAllocationTolerancePercent),
      requirementCount: acc.requirementCount,
      subjects,
      annual: {
        assignedHoursPerYear: round1(acc.annualMinutes / 60),
        regulatedHoursPerYear:
          activePercent === null
            ? null
            : round1((policy.fullTimeRegulatedHoursPerYear * activePercent) / 100),
        workDaysPerYear: policy.workDaysPerYear,
      },
    });
  }

  teachers.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.userId.localeCompare(b.userId),
  );

  return {
    teachers,
    unstaffedRequirements,
    unqualifiedAssignments,
    qualificationsRecorded,
    totals: {
      teacherMinutesPerWeek: Math.round(teacherMinutesPerWeek),
      lessonMinutesPerWeek: Math.round(lessonMinutesPerWeek),
    },
  };
}

/**
 * Reglerad arbetstid for one post: the policy's full-time hours scaled by the
 * active share of the post. The same line the report computes per teacher,
 * exposed on its own so the Anställning card can show the figure a draft WOULD
 * derive to before it is saved. One decimal, like the report's.
 */
export function regulatedHoursPerYear(
  fullTimeRegulatedHoursPerYear: number,
  employmentPercent: number,
  reductionPercent: number,
): number {
  return round1((fullTimeRegulatedHoursPerYear * (employmentPercent - reductionPercent)) / 100);
}
