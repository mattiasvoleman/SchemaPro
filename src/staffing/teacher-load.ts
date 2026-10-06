import type {
  StaffingCheckMode,
  TeacherContractKind,
  TeacherQualificationKind,
} from '@prisma/client';
import {
  peakPerWeekByKey,
  teachingWeeks,
  type ClosedRange,
  type TeachingPeriod,
  type YearBounds,
} from './teaching-weeks';

/*
 * Tjänstefördelningens belastningsrapport: who carries how many minutes a week,
 * against what target, in which subjects — computed, never stored.
 *
 * PURE ARITHMETIC. No Prisma, no clock, no school. The service hands in the
 * year's requirements, the teachers' posts, the policy, the behörigheter and
 * the lov, and gets the report back; the SS12000 duties export, the SCB CSV and
 * the Phase 4 staffing proposal will call the same function on the same rows,
 * which is why it is computed here rather than in the browser like gaps.ts —
 * and why it is not stored: Skola24's Tidssammanställning, Untis' Weekly values
 * and Lectio's Årsopgørelse are all reports over the rows, and a stored copy
 * would drift from them the first time a requirement changed.
 *
 * TWO WEEKS, NOT ONE. "Minutes per week" is two different numbers the moment a
 * school has an odd-week slöjd or a term-only course, and Skola24 changed its
 * own definition in 2025-12 for exactly that reason. The STANDARDVECKA weights
 * every requirement by how much of the year it runs: an all-year row counts
 * whole, an odd- or even-week row half, a dated row by its share of the year's
 * teaching weeks (lov subtracted, through the same arithmetic the timplan page
 * uses — see teaching-weeks.ts). The TOPPVECKA is the single busiest ISO week,
 * where a term course and a year course collide in September although neither
 * alone is heavy. Both are reported; neither is "the" load.
 *
 * THE RIKTMÄRKE IS THE SCHOOL'S, OR NOTHING. The central agreement fixes no
 * weekly teaching measure, so the policy's fullTimeTeachingMinutesPerWeek is
 * nullable with no default, and a null there makes every teacher NO_TARGET and
 * the tolerance inert. A teacher's own teachingTargetMinutesPerWeek overrides
 * the derivation; otherwise target = round5(riktmärke × (tjänst − nedsättning)
 * / 100), rounded to the solver's five-minute grid because a target of 863
 * minutes is a precision no timetable has.
 *
 * CO-TEACHING COUNTS FULLY FOR BOTH in this phase. Both teachers are in the
 * room, and the solver already holds both in NoOverlap. A school that counts the
 * co-teacher at 50 % will say so on the row (Fas 2, coTeacherLoadPercent); until
 * then the report keeps the two totals apart — minutes räknade för lärare and
 * lektionsminuter — so the inflation is visible rather than hidden.
 *
 * BEHÖRIGHET IS CHECKED ONLY WHEN THE SCHOOL HAS SAID SOMETHING. A school with
 * zero qualification rows has not recorded that nobody is qualified, it has
 * recorded nothing, and flagging all 300 of its assignments would be noise that
 * teaches the school to ignore the list. The report says `qualificationsRecorded:
 * false` and leaves unqualifiedAssignments empty, the same reading the substitute
 * picker gives the empty table. With rows present, an assignment is unqualified
 * when no qualification of the teacher in the subject covers the group's whole
 * grade span and is valid at some point in the year.
 */

export type LoadStatus = 'UNDER' | 'OK' | 'OVER' | 'NO_TARGET';

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
 * WARN, with no riktmärke. Stated here so a school without a policy row reads
 * the same report it would read the moment an admin saves the form untouched.
 */
export const DEFAULT_LOAD_POLICY: LoadPolicy = {
  fullTimeTeachingMinutesPerWeek: null,
  overAllocationTolerancePercent: 10,
  fullTimeRegulatedHoursPerYear: 1360,
  workDaysPerYear: 194,
  qualificationMode: 'WARN',
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
   * The years the group actually holds, derived as the optimisation proxy
   * derives it (room-eligibility.ts gradeSpanOf): members' home classes, the
   * group's own gradeLevel when it has no members with one, null when neither
   * says anything.
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
  role: 'TEACHER' | 'CO_TEACHER';
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
 * How much of a standardvecka one requirement is worth, 0..1.
 *
 * Undated rows are the two flat figures Skola24 and the timplan page agree on:
 * every week 1, varannan vecka 0.5. A dated row is its share of the year's
 * teaching weeks, lov and studiedagar subtracted from both numerator and
 * denominator — the recurrence is inside the numerator, so an odd-week autumn
 * course is roughly a quarter. A year with no teaching weeks weighs nothing,
 * rather than dividing by zero.
 *
 * `gradeLevel` is handed to the closure arithmetic only when the group sits in
 * ONE grade. A teaching group spanning several has no single answer to "does
 * this lågstadiet studiedag close it", so only school-wide closures apply there.
 */
export function standardWeekWeight(
  requirement: TeachingPeriod & { gradeSpan?: GradeSpan | null },
  year: YearBounds,
  closures: ClosedRange[],
): number {
  if (!requirement.startDate && !requirement.endDate) {
    return (requirement.recurrence ?? 'ALL_WEEKS') === 'ALL_WEEKS' ? 1 : 0.5;
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
 * The teacher's target for the week, or null for NO_TARGET.
 *
 * The per-teacher override wins outright, even over a null riktmärke: a school
 * that has agreed 900 minutes with one teacher has a target for that teacher
 * whether or not it has decided on a school-wide measure.
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
 * UNDER / OK / OVER against the target with the policy's tolerance on BOTH
 * sides. Over-allocation is what the policy mode refuses, so the upper edge is
 * the one that matters: exactly target × (1 + tolerance / 100) is still OK, one
 * minute more is OVER. The same band downward keeps a teacher 3 % under from
 * reading as a problem to fix.
 */
export function loadStatus(
  assigned: number,
  target: number | null,
  tolerancePercent: number,
): LoadStatus {
  if (target === null) return 'NO_TARGET';
  const band = (target * tolerancePercent) / 100;
  if (assigned > target + band) return 'OVER';
  if (assigned < target - band) return 'UNDER';
  return 'OK';
}

/**
 * Whether one qualification covers a requirement: same subject, the whole
 * grade span inside the qualification's, and valid at some point of the year.
 * A requirement whose group has no derivable grade is covered by any
 * qualification in the subject — the span cannot be judged, and refusing it
 * would flag every memberless teaching group.
 */
export function qualificationCovers(
  qualification: LoadQualification,
  requirement: Pick<LoadRequirement, 'subjectId' | 'gradeSpan'>,
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
  // A teacher with a post and no requirement is still a row: their whole
  // target is unfilled, which is the thing the matrix exists to show.
  for (const employment of input.employments) accumulatorFor(employment.userId);

  const unstaffedRequirements: UnstaffedRequirement[] = [];
  const unqualifiedAssignments: UnqualifiedAssignment[] = [];
  const qualificationsRecorded = input.qualifications.length > 0;
  const checkQualifications = qualificationsRecorded && policy.qualificationMode !== 'OFF';
  const qualificationsByUser = new Map<string, LoadQualification[]>();
  for (const qualification of input.qualifications) {
    const list = qualificationsByUser.get(qualification.userId) ?? [];
    list.push(qualification);
    qualificationsByUser.set(qualification.userId, list);
  }

  let lessonMinutesPerWeek = 0;
  // Per teacher so the peak sums only that teacher's rows; a co-taught row is
  // handed in once per teacher, under each one's key.
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

    const assignees: [string | null, UnqualifiedAssignment['role']][] = [
      [requirement.teacherId, 'TEACHER'],
      [requirement.coTeacherId, 'CO_TEACHER'],
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

    // Shares are taken on the unrounded minutes, so 600 of 900 is exactly
    // two thirds whatever the rounding did to either figure.
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

  // OVER first: the matrix is read to find the problem rows. Then by id, so
  // the order is stable rather than the order the rows were typed in.
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
