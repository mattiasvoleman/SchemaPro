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
 * EACH TEACHER IS CHARGED THE ROW'S OWN PERCENTAGE. A requirement counts for
 * its lead at lessons × minutes × teacherLoadPercent / 100 × the standardvecka
 * weight, and for its co-teacher at × coTeacherLoadPercent / 100 — Skola24's
 * "Justera längd för lärare (%)", per row and per role, 0..200. Both default to
 * 100, so a school that never touches them reads the Fas 1 report unchanged:
 * both teachers fully charged, because both are in the room and the solver
 * holds both in NoOverlap. The percentage reaches every figure charged to a
 * TEACHER — standardvecka, toppvecka, timmar per år, the subject split — and
 * none charged to the LESSON: lektionsminuter stay what the pupils sit through,
 * so the two totals still differ by exactly what the school chose to count.
 * A 0 % row is still the teacher's row (requirementCount, the subject listed at
 * 0 minutes): resurslärare who are in the room but not charged are a real case.
 *
 * UPPDRAG ARE PART OF THE TJÄNST, NOT OF THE TEACHING. Mentorskap, rastvakt,
 * förstelärare — TeacherDuties — are reported per teacher as dutyMinutesPerWeek.
 * Only the ones the school marked countsAsTeaching are compared with the target:
 * they are added to the teaching minutes in countedMinutesPerWeek, which is what
 * status, saldo and percentOfTarget read. The rest are drawn beside the
 * teaching as "uppdrag" and consume nothing, because the riktmärke is a measure
 * of undervisning and a school that counts mentorskap against it says so on the
 * duty. percentOfEmployment per subject stays a share of the TEACHING minutes:
 * SCB's tjänsteomfattning per ämne has no column for rastvakt. Duties carry no
 * week pattern, so they enter neither the toppvecka nor the annual hours.
 *
 * ÄMNESFLASKHALSAR are the question the unstaffed list cannot answer on its
 * own: is there anybody left to take these rows? Per subject with an unstaffed
 * row, demanded = the minutes those rows would charge their lead, and
 * qualifiedRemaining = Σ max(0, target − counted) over every teacher holding a
 * qualification in the subject valid at some point of the year. A teacher with
 * no target contributes nothing — their room is unknown, not infinite — and is
 * counted separately so the page can say "plus 2 utan riktmärke". Short when
 * demanded > remaining. A school with zero qualification rows gets no
 * bottlenecks at all (`bottlenecksComputed: false`): with nobody recorded as
 * qualified, every subject would read as fully short, which is the same noise
 * the unqualified list refuses to make. The policy's qualificationMode does not
 * switch this off: OFF says "do not warn about assignments", and capacity is a
 * planning figure, not a warning.
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
  /** How much of the row the lead is charged, 0..200; 100 = all of it. */
  teacherLoadPercent: number;
  /** How much of the row the co-teacher is charged, 0..200. */
  coTeacherLoadPercent: number;
  /**
   * The years the group actually holds, derived as the optimisation proxy
   * derives it (room-eligibility.ts gradeSpanOf): members' home classes, the
   * group's own gradeLevel when it has no members with one, null when neither
   * says anything.
   */
  gradeSpan: GradeSpan | null;
}

/** One uppdrag of the year: what it costs a week and whether it is teaching. */
export interface LoadDuty {
  userId: string;
  minutesPerWeek: number;
  countsAsTeaching: boolean;
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
  duties: LoadDuty[];
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
  /** Teaching charged by the requirements, standardvecka, whole minutes. */
  assignedMinutesPerWeek: number;
  /** Toppvecka of the teaching, whole minutes. */
  peakMinutesPerWeek: number;
  /** Every uppdrag of the year, counted or not. */
  dutyMinutesPerWeek: number;
  /** The uppdrag marked countsAsTeaching — the part of dutyMinutes that meets the target. */
  countedDutyMinutesPerWeek: number;
  /** assigned + counted uppdrag: what the target is compared with. */
  countedMinutesPerWeek: number;
  /** target − counted: kvar till mål when positive, över mål when negative. */
  balanceMinutesPerWeek: number | null;
  percentOfTarget: number | null;
  status: LoadStatus;
  requirementCount: number;
  dutyCount: number;
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
  /** Lektionsminuter, standardvecka: what the pupils sit through. */
  minutesPerWeek: number;
  /** What the row would charge the teacher who takes it (× teacherLoadPercent). */
  teacherMinutesPerWeek: number;
  gradeSpan: GradeSpan | null;
}

/** Per subject with an unstaffed row: is there anybody qualified left to take it? */
export interface SubjectBottleneck {
  subjectId: string;
  subjectName: string;
  unstaffedCount: number;
  /** Σ teacherMinutesPerWeek of the subject's unstaffed rows. */
  demandedMinutesPerWeek: number;
  /** Σ max(0, target − counted) over qualified teachers with a target. */
  qualifiedRemainingMinutesPerWeek: number;
  /** Qualified teachers with a target, whether or not they have room left. */
  qualifiedTeacherCount: number;
  /** Qualified teachers with no target: room unknown, so not in the sum. */
  qualifiedNoTargetCount: number;
  short: boolean;
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
  /** Short first, then by deficit. Empty when bottlenecksComputed is false. */
  subjectBottlenecks: SubjectBottleneck[];
  /** False with zero qualification rows: capacity cannot be known. */
  bottlenecksComputed: boolean;
  totals: {
    /** Σ over teachers of assigned minutes, each at its row's percentage. */
    teacherMinutesPerWeek: number;
    /** Σ over requirements of standardvecka minutes: every row once, at 100 %. */
    lessonMinutesPerWeek: number;
    /** Σ over teachers of every uppdrag. */
    dutyMinutesPerWeek: number;
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

/** Whether a qualification is valid at some point of the year. */
export function qualificationValidInYear(
  qualification: Pick<LoadQualification, 'validFrom' | 'validTo'>,
  year: YearBounds,
): boolean {
  if (qualification.validFrom && qualification.validFrom > year.endDate) return false;
  if (qualification.validTo && qualification.validTo < year.startDate) return false;
  return true;
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
  if (!qualificationValidInYear(qualification, year)) return false;
  const span = requirement.gradeSpan;
  if (span === null) return true;
  return qualification.minGradeLevel <= span.min && qualification.maxGradeLevel >= span.max;
}

/**
 * LEGITIMATION over BEHORIG over TILLATEN, as skollagen ranks them — the same
 * order the substitute picker sorts by (calendar-lessons.service.ts).
 */
export const QUALIFICATION_RANK: Record<LoadQualification['kind'], number> = {
  LEGITIMATION: 3,
  BEHORIG: 2,
  TILLATEN: 1,
};

/**
 * The strongest of `held` that covers the requirement, or null. `held` may
 * carry anybody's rows; only `userId`'s are read.
 */
export function strongestCoveringQualification(
  held: LoadQualification[],
  userId: string,
  requirement: Pick<LoadRequirement, 'subjectId' | 'gradeSpan'>,
  year: YearBounds,
): LoadQualification['kind'] | null {
  let best: LoadQualification['kind'] | null = null;
  for (const qualification of held) {
    if (qualification.userId !== userId) continue;
    if (!qualificationCovers(qualification, requirement, year)) continue;
    if (best === null || QUALIFICATION_RANK[qualification.kind] > QUALIFICATION_RANK[best]) {
      best = qualification.kind;
    }
  }
  return best;
}

/** The minutes one requirement charges each role, before rounding. */
export function chargedMinutes(
  requirement: Pick<
    LoadRequirement,
    | 'lessonsPerWeek'
    | 'minutesPerLesson'
    | 'teacherLoadPercent'
    | 'coTeacherLoadPercent'
    | 'recurrence'
    | 'startDate'
    | 'endDate'
    | 'gradeSpan'
  >,
  year: YearBounds,
  closures: ClosedRange[],
): { lesson: number; teacher: number; coTeacher: number } {
  const lesson =
    requirement.lessonsPerWeek *
    requirement.minutesPerLesson *
    standardWeekWeight(requirement, year, closures);
  return {
    lesson,
    teacher: (lesson * requirement.teacherLoadPercent) / 100,
    coTeacher: (lesson * requirement.coTeacherLoadPercent) / 100,
  };
}

interface Accumulator {
  assigned: number;
  annualMinutes: number;
  requirementCount: number;
  dutyMinutes: number;
  countedDutyMinutes: number;
  dutyCount: number;
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
      acc = {
        assigned: 0,
        annualMinutes: 0,
        requirementCount: 0,
        dutyMinutes: 0,
        countedDutyMinutes: 0,
        dutyCount: 0,
        subjects: new Map(),
      };
      accumulators.set(userId, acc);
    }
    return acc;
  };
  // A teacher with a post and no requirement is still a row: their whole
  // target is unfilled, which is the thing the matrix exists to show.
  for (const employment of input.employments) accumulatorFor(employment.userId);

  // Uppdrag before requirements, so a teacher whose only line is a mentorskap
  // is a row in the matrix like one whose only line is a post.
  for (const duty of input.duties) {
    const acc = accumulatorFor(duty.userId);
    acc.dutyMinutes += duty.minutesPerWeek;
    acc.dutyCount += 1;
    if (duty.countsAsTeaching) acc.countedDutyMinutes += duty.minutesPerWeek;
  }

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
  // handed in once per teacher, under each one's key and at each one's share.
  const peakItems: (TeachingPeriod & { key: string; minutes: number })[] = [];
  // Per subject, the demand the unstaffed rows put on whoever takes them.
  const demand = new Map<string, { subjectName: string; minutes: number; count: number }>();

  for (const requirement of input.requirements) {
    const weeklyMinutes = requirement.lessonsPerWeek * requirement.minutesPerLesson;
    const charged = chargedMinutes(requirement, year, closures);
    const yearMinutes =
      weeklyMinutes *
      teachingWeeks(requirement, year, closures, singleGrade(requirement.gradeSpan));
    lessonMinutesPerWeek += charged.lesson;

    if (requirement.teacherId === null) {
      unstaffedRequirements.push({
        requirementId: requirement.id,
        subjectId: requirement.subjectId,
        subjectName: requirement.subjectName,
        studentGroupId: requirement.studentGroupId,
        groupName: requirement.groupName,
        minutesPerWeek: Math.round(charged.lesson),
        teacherMinutesPerWeek: Math.round(charged.teacher),
        gradeSpan: requirement.gradeSpan,
      });
      const subjectDemand = demand.get(requirement.subjectId) ?? {
        subjectName: requirement.subjectName,
        minutes: 0,
        count: 0,
      };
      subjectDemand.minutes += charged.teacher;
      subjectDemand.count += 1;
      demand.set(requirement.subjectId, subjectDemand);
    }

    const assignees: [string | null, UnqualifiedAssignment['role'], number][] = [
      [requirement.teacherId, 'TEACHER', requirement.teacherLoadPercent],
      [requirement.coTeacherId, 'CO_TEACHER', requirement.coTeacherLoadPercent],
    ];
    for (const [userId, role, percent] of assignees) {
      if (userId === null) continue;
      const share = percent / 100;
      const standardMinutes = role === 'TEACHER' ? charged.teacher : charged.coTeacher;
      const acc = accumulatorFor(userId);
      acc.assigned += standardMinutes;
      acc.annualMinutes += yearMinutes * share;
      acc.requirementCount += 1;
      const subject = acc.subjects.get(requirement.subjectId) ?? {
        subjectName: requirement.subjectName,
        minutes: 0,
      };
      subject.minutes += standardMinutes;
      acc.subjects.set(requirement.subjectId, subject);
      peakItems.push({
        key: userId,
        minutes: weeklyMinutes * share,
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
  let dutyMinutesPerWeek = 0;
  const teachers: TeacherLoad[] = [];
  for (const [userId, acc] of accumulators) {
    const employment = employmentByUser.get(userId) ?? null;
    const target = targetMinutesPerWeek(employment, policy);
    const assigned = Math.round(acc.assigned);
    const counted = acc.assigned + acc.countedDutyMinutes;
    teacherMinutesPerWeek += acc.assigned;
    dutyMinutesPerWeek += acc.dutyMinutes;
    const activePercent = employment
      ? employment.employmentPercent - employment.reductionPercent
      : null;

    // Shares are taken on the unrounded minutes, so 600 of 900 is exactly
    // two thirds whatever the rounding did to either figure. Teaching minutes
    // only: an uppdrag is no subject's share.
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
      dutyMinutesPerWeek: acc.dutyMinutes,
      countedDutyMinutesPerWeek: acc.countedDutyMinutes,
      countedMinutesPerWeek: Math.round(counted),
      balanceMinutesPerWeek: target === null ? null : target - Math.round(counted),
      percentOfTarget:
        target === null || target === 0 ? null : round1((counted / target) * 100),
      status: loadStatus(counted, target, policy.overAllocationTolerancePercent),
      requirementCount: acc.requirementCount,
      dutyCount: acc.dutyCount,
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

  const subjectBottlenecks: SubjectBottleneck[] = [];
  if (qualificationsRecorded) {
    // Who holds a qualification in which subject this year, any span: the
    // question is whether the subject has teachers left, not who takes which row.
    const holders = new Map<string, Set<string>>();
    for (const qualification of input.qualifications) {
      if (!qualificationValidInYear(qualification, year)) continue;
      const set = holders.get(qualification.subjectId) ?? new Set<string>();
      set.add(qualification.userId);
      holders.set(qualification.subjectId, set);
    }
    for (const [subjectId, subjectDemand] of demand) {
      let remaining = 0;
      let withTarget = 0;
      let noTarget = 0;
      for (const userId of holders.get(subjectId) ?? []) {
        const target = targetMinutesPerWeek(employmentByUser.get(userId) ?? null, policy);
        if (target === null) {
          noTarget += 1;
          continue;
        }
        withTarget += 1;
        const acc = accumulators.get(userId);
        const counted = acc ? acc.assigned + acc.countedDutyMinutes : 0;
        remaining += Math.max(0, target - counted);
      }
      const demanded = Math.round(subjectDemand.minutes);
      const qualifiedRemaining = Math.round(remaining);
      subjectBottlenecks.push({
        subjectId,
        subjectName: subjectDemand.subjectName,
        unstaffedCount: subjectDemand.count,
        demandedMinutesPerWeek: demanded,
        qualifiedRemainingMinutesPerWeek: qualifiedRemaining,
        qualifiedTeacherCount: withTarget,
        qualifiedNoTargetCount: noTarget,
        short: demanded > qualifiedRemaining,
      });
    }
    // Short first, the deepest deficit first among them; then by id.
    subjectBottlenecks.sort(
      (a, b) =>
        Number(b.short) - Number(a.short) ||
        b.demandedMinutesPerWeek -
          b.qualifiedRemainingMinutesPerWeek -
          (a.demandedMinutesPerWeek - a.qualifiedRemainingMinutesPerWeek) ||
        a.subjectId.localeCompare(b.subjectId),
    );
  }

  return {
    teachers,
    unstaffedRequirements,
    unqualifiedAssignments,
    qualificationsRecorded,
    subjectBottlenecks,
    bottlenecksComputed: qualificationsRecorded,
    totals: {
      teacherMinutesPerWeek: Math.round(teacherMinutesPerWeek),
      lessonMinutesPerWeek: Math.round(lessonMinutesPerWeek),
      dutyMinutesPerWeek,
    },
  };
}

/**
 * Per teacher, the minutes the target is compared with — teaching at each
 * row's percentage plus the uppdrag marked countsAsTeaching — UNROUNDED.
 *
 * The report's countedMinutesPerWeek is this, rounded; its status is
 * loadStatus over this. Exposed on its own for the two questions asked about
 * one hypothetical write rather than about the year: "how much room would
 * this teacher have left after taking that row" (suggest-teachers) and "would
 * this write put them over" (STAFF_TEACHER_OVER_TARGET). Both add one row's
 * charge to this figure and ask loadStatus, so a candidate the picker calls
 * OVER is exactly the one the write would refuse — no rounding in between.
 * No peaks and no subjects, so it is cheap enough to ask per request.
 *
 * Gateway-only: the browser reads these answers from the endpoints, so the
 * web mirror has no copy (the contract test ties this to the report instead).
 */
export function countedMinutesByTeacher(
  input: Pick<LoadInput, 'year' | 'closures' | 'requirements' | 'duties'>,
): Map<string, number> {
  const counted = new Map<string, number>();
  const add = (userId: string, minutes: number) =>
    counted.set(userId, (counted.get(userId) ?? 0) + minutes);
  for (const duty of input.duties) {
    add(duty.userId, duty.countsAsTeaching ? duty.minutesPerWeek : 0);
  }
  for (const requirement of input.requirements) {
    const charged = chargedMinutes(requirement, input.year, input.closures);
    if (requirement.teacherId !== null) add(requirement.teacherId, charged.teacher);
    if (requirement.coTeacherId !== null) add(requirement.coTeacherId, charged.coTeacher);
  }
  return counted;
}
