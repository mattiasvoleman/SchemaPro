import type {
  BreakKind,
  ConstraintResource,
  ConstraintType,
  LessonRecurrence,
  PrismaClient,
  StaffingCheckMode,
  StudentGroupKind,
} from '@prisma/client';
import type { FrameWindow } from '../common/year-rollover';
import type { LoadQualification } from '../staffing/teacher-load';
import { readDecidedTimplans, type DecidedTimplan } from '../timplan/year-timplans';
import { pendingMoves, planActivation, readActivationSource } from './activation-plan';
import type { SourceTimplanRow } from './rollover-timplans';
import type { SourceDuty, StaffingSource } from './rollover-staffing';

/**
 * Everything the rollover plan is computed from, read in the caller's
 * transaction — the preview's, or the execute's after its locks.
 *
 * READ ONLY, AND ONLY THE SOURCE. Nothing here writes, and every year-scoped
 * read is of the source year: the plan is a function of this object and the
 * request (rollover-plan.ts), so preview and execute compute the same plan
 * from the same rows, and the hash says whether the rows changed between the
 * two.
 *
 * In sequence, never Promise.all: one transaction is one connection (see
 * load-input.ts). RLS confines every read to the caller's school, and every
 * caller sits behind a SCHOOL_ADMIN route, who sees the whole school.
 */

const asDay = (value: Date): string => value.toISOString().slice(0, 10);
const asClock = (value: Date): string => value.toISOString().slice(11, 16);

export interface SourceYear {
  id: string;
  schoolId: string;
  name: string;
  startDate: string;
  endDate: string;
  isActive: boolean;
}

export interface SourceGroup {
  id: string;
  name: string;
  kind: StudentGroupKind;
  gradeLevel: number | null;
}

export interface SourceRequirement {
  id: string;
  subjectId: string;
  subjectName: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  lessonsPerWeek: number;
  minutesPerLesson: number;
  minutesBefore: number;
  minutesAfter: number;
  teacherLoadPercent: number;
  coTeacherLoadPercent: number;
  recurrence: LessonRecurrence;
  startDate: string | null;
  endDate: string | null;
}

export interface SourceBreak {
  id: string;
  name: string;
  kind: BreakKind;
  startDate: string;
  endDate: string;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
}

/** A weekly class rule: a STUDENT_GROUP constraint on a weekday, no date. */
export interface SourceClassRule {
  id: string;
  resourceType: ConstraintResource;
  studentGroupId: string;
  dayOfWeek: number;
  /** As stored: a Date anchored at 1970-01-01, written back unchanged. */
  startTime: Date;
  endTime: Date;
  type: ConstraintType;
  reason: string | null;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
}

export interface DecidedPlan {
  id: string;
  name: string;
  schoolForm: string;
  decidedAt: string;
  entries: { subjectId: string; gradeLevel: number; minutesPerWeek: number }[];
}

export interface RolloverSource {
  year: SourceYear;
  successor: { id: string; name: string } | null;
  /** The school's other years, for the name and the overlap checks. */
  otherYears: { id: string; name: string; startDate: string; endDate: string }[];
  groups: SourceGroup[];
  /** groupId → its active pupils' ids, home class (Users.studentGroupId). */
  homePupils: Map<string, string[]>;
  /** Teaching-group members who are active pupils. */
  members: { studentGroupId: string; studentId: string }[];
  /** studentId → home class, for every member above. */
  homeClassOf: Map<string, string | null>;
  requirements: SourceRequirement[];
  breaks: SourceBreak[];
  classRules: SourceClassRule[];
  frames: FrameWindow[];
  decidedPlans: DecidedPlan[];
  /** Timplan per årskurs of the source year (AcademicYearTimplans), by grade. */
  timplans: SourceTimplanRow[];
  /** Every DECIDED plan and its grades, newest first; the first is P2's default for a new year. */
  decidedTimplans: DecidedTimplan[];
  /** planId → entries, for every plan the new year can follow (attached or decided). */
  planEntries: Map<string, { subjectId: string; gradeLevel: number; minutesPerWeek: number }[]>;
  subjectNames: Map<string, string>;
  /** Users who may teach a row: TEACHER or SCHOOL_ADMIN, and active. */
  activeTeacherIds: Set<string>;
  qualificationMode: StaffingCheckMode;
  qualifications: LoadQualification[];
  skipped: {
    masterLessons: number;
    lockedLessons: number;
    lunchSittings: number;
    handPinnedSittings: number;
    employments: number;
    duties: number;
    dutyBlockedSlots: number;
    mentorskap: number;
  };
  /**
   * The source year's tjänster and uppdrag, read only when the request asks
   * to carry them (staffing Fas 5); null otherwise, and then `skipped` holds
   * the four counts the preview has always shown.
   */
  staffing: StaffingSource | null;
  /**
   * Pupils the source's own activation would still move: all of a year not
   * yet activated (ROLLOVER_SOURCE_NOT_ACTIVATED), or the stragglers of an
   * active one (ROLLOVER_SOURCE_HAS_STRAGGLERS) — a pupil who was inactive at
   * the activation and has come back, still in last year's class.
   */
  pendingMoves: number;
}

export async function readRolloverSource(
  tx: PrismaClient,
  sourceYearId: string,
  options: { carryStaffing?: boolean } = {},
): Promise<RolloverSource | null> {
  const year = await tx.academicYear.findUnique({
    where: { id: sourceYearId },
    select: { id: true, schoolId: true, name: true, startDate: true, endDate: true, isActive: true },
  });
  if (!year) return null;
  const successor = await tx.academicYear.findFirst({
    where: { predecessorId: sourceYearId },
    select: { id: true, name: true },
  });
  const otherYears = await tx.academicYear.findMany({
    where: { id: { not: sourceYearId } },
    select: { id: true, name: true, startDate: true, endDate: true },
  });

  const groups = await tx.studentGroup.findMany({
    where: { academicYearId: sourceYearId },
    select: { id: true, name: true, kind: true, gradeLevel: true },
    orderBy: { id: 'asc' },
  });
  const groupIds = (groups ?? []).map((group) => group.id);
  const homeRows =
    groupIds.length > 0
      ? await tx.user.findMany({
          where: { role: 'STUDENT', isActive: true, studentGroupId: { in: groupIds } },
          select: { id: true, studentGroupId: true },
        })
      : [];
  const homePupils = new Map<string, string[]>();
  for (const row of homeRows ?? []) {
    const ids = homePupils.get(row.studentGroupId as string) ?? [];
    ids.push(row.id);
    homePupils.set(row.studentGroupId as string, ids);
  }
  const memberRows =
    groupIds.length > 0
      ? await tx.studentGroupMember.findMany({
          where: { studentGroupId: { in: groupIds }, student: { role: 'STUDENT', isActive: true } },
          select: { studentGroupId: true, studentId: true, student: { select: { studentGroupId: true } } },
        })
      : [];
  const homeClassOf = new Map<string, string | null>();
  for (const row of memberRows ?? []) homeClassOf.set(row.studentId, row.student.studentGroupId);

  const requirements = await tx.teachingRequirement.findMany({
    where: { academicYearId: sourceYearId },
    select: {
      id: true,
      subjectId: true,
      studentGroupId: true,
      teacherId: true,
      coTeacherId: true,
      lessonsPerWeek: true,
      minutesPerLesson: true,
      minutesBefore: true,
      minutesAfter: true,
      teacherLoadPercent: true,
      coTeacherLoadPercent: true,
      recurrence: true,
      startDate: true,
      endDate: true,
      subject: { select: { name: true } },
    },
    orderBy: { id: 'asc' },
  });
  const breaks = await tx.schoolBreak.findMany({
    where: { academicYearId: sourceYearId },
    select: {
      id: true,
      name: true,
      kind: true,
      startDate: true,
      endDate: true,
      minGradeLevel: true,
      maxGradeLevel: true,
    },
    orderBy: { startDate: 'asc' },
  });
  const classRules =
    groupIds.length > 0
      ? await tx.availabilityConstraint.findMany({
          where: {
            resourceType: 'STUDENT_GROUP',
            studentGroupId: { in: groupIds },
            dayOfWeek: { not: null },
            date: null,
          },
          select: {
            id: true,
            resourceType: true,
            studentGroupId: true,
            dayOfWeek: true,
            startTime: true,
            endTime: true,
            type: true,
            reason: true,
            minGradeLevel: true,
            maxGradeLevel: true,
          },
          orderBy: { id: 'asc' },
        })
      : [];
  const frames = await tx.frameTime.findMany({
    select: { minGradeLevel: true, maxGradeLevel: true, dayOfWeek: true, startTime: true, endTime: true },
  });
  const plans = await tx.localTimplan.findMany({
    where: { status: 'DECIDED' },
    select: {
      id: true,
      name: true,
      schoolForm: true,
      decidedAt: true,
      entries: { select: { subjectId: true, gradeLevel: true, minutesPerWeek: true } },
    },
  });
  const subjects = await tx.subject.findMany({ select: { id: true, name: true } });
  const attached = await tx.academicYearTimplan.findMany({
    where: { academicYearId: sourceYearId },
    orderBy: { gradeLevel: 'asc' },
    select: {
      gradeLevel: true,
      localTimplanId: true,
      localTimplan: {
        select: {
          name: true,
          status: true,
          schoolForm: true,
          entries: { select: { subjectId: true, gradeLevel: true, minutesPerWeek: true } },
        },
      },
    },
  });
  const decidedTimplans = await readDecidedTimplans(tx);
  const planEntries = new Map<string, { subjectId: string; gradeLevel: number; minutesPerWeek: number }[]>();
  for (const plan of plans ?? []) planEntries.set(plan.id, plan.entries);
  for (const row of attached ?? []) planEntries.set(row.localTimplanId, row.localTimplan.entries);

  const teacherIds = [
    ...new Set(
      (requirements ?? []).flatMap((row) =>
        [row.teacherId, row.coTeacherId].filter((id): id is string => id !== null),
      ),
    ),
  ];
  const activeTeachers =
    teacherIds.length > 0
      ? await tx.user.findMany({
          where: { id: { in: teacherIds }, isActive: true, role: { in: ['TEACHER', 'SCHOOL_ADMIN'] } },
          select: { id: true },
        })
      : [];
  const policy = await tx.staffingPolicy.findFirst({ select: { qualificationMode: true } });
  const qualifications =
    teacherIds.length > 0
      ? await tx.teacherSubjectQualification.findMany({
          select: {
            userId: true,
            subjectId: true,
            minGradeLevel: true,
            maxGradeLevel: true,
            kind: true,
            validFrom: true,
            validTo: true,
          },
        })
      : [];

  const masterLessons = await tx.masterLesson.count({ where: { academicYearId: sourceYearId } });
  const lockedLessons = await tx.masterLesson.count({
    where: { academicYearId: sourceYearId, isLocked: true },
  });
  const lunchSittings = await tx.lunchSitting.count({ where: { academicYearId: sourceYearId } });
  const handPinnedSittings = await tx.lunchSitting.count({
    where: { academicYearId: sourceYearId, isGenerated: false },
  });
  // Without the option, exactly the four counts of fa4a3d6, so a rollover
  // that does not carry tjänster sends the statements it always has. With
  // it, the rows themselves, and the counts follow from them.
  let staffing: StaffingSource | null = null;
  let employments: number;
  let duties: number;
  let dutyBlockedSlots: number;
  let mentorskap: number;
  if (options.carryStaffing === true) {
    staffing = await readSourceStaffing(tx, sourceYearId);
    employments = staffing.employments.length;
    duties = staffing.duties.length;
    dutyBlockedSlots = staffing.duties.filter((duty) => duty.slot !== null).length;
    mentorskap = staffing.duties.filter((duty) => duty.kind === 'MENTORSKAP').length;
  } else {
    employments = await tx.teacherEmployment.count({ where: { academicYearId: sourceYearId } });
    duties = await tx.teacherDuty.count({ where: { academicYearId: sourceYearId } });
    dutyBlockedSlots = await tx.teacherDuty.count({
      where: { academicYearId: sourceYearId, blockedConstraintId: { not: null } },
    });
    mentorskap = await tx.teacherDuty.count({
      where: { academicYearId: sourceYearId, kind: 'MENTORSKAP' },
    });
  }

  // ROLLOVER_SOURCE_NOT_ACTIVATED: a year whose own pupils have not moved in
  // yet has empty home classes, so its counts and exclusions would be judged
  // on the year before it.
  const activation = await readActivationSource(tx, sourceYearId);
  const pending = activation ? pendingMoves(planActivation(activation, '9999-12-31')) : 0;

  return {
    year: {
      id: year.id,
      schoolId: year.schoolId,
      name: year.name,
      startDate: asDay(year.startDate),
      endDate: asDay(year.endDate),
      isActive: year.isActive,
    },
    successor: successor ?? null,
    otherYears: (otherYears ?? []).map((other) => ({
      id: other.id,
      name: other.name,
      startDate: asDay(other.startDate),
      endDate: asDay(other.endDate),
    })),
    groups: groups ?? [],
    homePupils,
    members: (memberRows ?? []).map((row) => ({ studentGroupId: row.studentGroupId, studentId: row.studentId })),
    homeClassOf,
    requirements: (requirements ?? []).map((row) => ({
      id: row.id,
      subjectId: row.subjectId,
      subjectName: row.subject.name,
      studentGroupId: row.studentGroupId,
      teacherId: row.teacherId,
      coTeacherId: row.coTeacherId,
      lessonsPerWeek: row.lessonsPerWeek,
      minutesPerLesson: row.minutesPerLesson,
      minutesBefore: row.minutesBefore,
      minutesAfter: row.minutesAfter,
      teacherLoadPercent: row.teacherLoadPercent,
      coTeacherLoadPercent: row.coTeacherLoadPercent,
      recurrence: row.recurrence,
      startDate: row.startDate ? asDay(row.startDate) : null,
      endDate: row.endDate ? asDay(row.endDate) : null,
    })),
    breaks: (breaks ?? []).map((row) => ({
      ...row,
      startDate: asDay(row.startDate),
      endDate: asDay(row.endDate),
    })),
    classRules: (classRules ?? []).map((row) => ({
      ...row,
      studentGroupId: row.studentGroupId as string,
      dayOfWeek: row.dayOfWeek as number,
    })),
    frames: (frames ?? []).map((frame) => ({
      minGradeLevel: frame.minGradeLevel,
      maxGradeLevel: frame.maxGradeLevel,
      dayOfWeek: frame.dayOfWeek,
      startTime: asClock(frame.startTime),
      endTime: asClock(frame.endTime),
    })),
    decidedPlans: (plans ?? []).map((plan) => ({
      id: plan.id,
      name: plan.name,
      schoolForm: plan.schoolForm,
      decidedAt: plan.decidedAt ? plan.decidedAt.toISOString() : '',
      entries: plan.entries,
    })),
    timplans: (attached ?? []).map((row) => ({
      gradeLevel: row.gradeLevel,
      localTimplanId: row.localTimplanId,
      planName: row.localTimplan.name,
      planStatus: row.localTimplan.status,
      planSchoolForm: row.localTimplan.schoolForm,
    })),
    decidedTimplans,
    planEntries,
    subjectNames: new Map((subjects ?? []).map((subject) => [subject.id, subject.name])),
    activeTeacherIds: new Set((activeTeachers ?? []).map((teacher) => teacher.id)),
    qualificationMode: policy?.qualificationMode ?? 'WARN',
    qualifications: (qualifications ?? []).map((row) => ({
      ...row,
      validFrom: row.validFrom ? asDay(row.validFrom) : null,
      validTo: row.validTo ? asDay(row.validTo) : null,
    })),
    skipped: {
      masterLessons: masterLessons ?? 0,
      lockedLessons: lockedLessons ?? 0,
      lunchSittings: lunchSittings ?? 0,
      handPinnedSittings: handPinnedSittings ?? 0,
      employments: employments ?? 0,
      duties: duties ?? 0,
      dutyBlockedSlots: dutyBlockedSlots ?? 0,
      mentorskap: mentorskap ?? 0,
    },
    staffing,
    pendingMoves: pending,
  };
}

/** Seconds kept when there are any, so the grid check sees a slot PostgREST wrote at 10:00:30. */
const slotClock = (value: Date): string =>
  value.getUTCSeconds() === 0 ? asClock(value) : value.toISOString().slice(11, 19);

/**
 * A year's tjänster and uppdrag as the carry reads them (staffing Fas 5), and
 * the role and active flag of every person they name.
 *
 * Shared by the rollover and by the carry into an already rolled year, and
 * read in the caller's transaction after its locks. A slot is read only in
 * the shape the Fas 2 triggers guard — a weekly UNAVAILABLE TEACHER row of
 * the duty's own teacher; anything else reads as no slot, so a carry never
 * copies a shape the triggers would refuse. The people read is by id, not a
 * roster: whose rows these are, not who sits in which class.
 */
export async function readSourceStaffing(tx: PrismaClient, yearId: string): Promise<StaffingSource> {
  const employmentRows = await tx.teacherEmployment.findMany({
    where: { academicYearId: yearId },
    select: {
      id: true,
      userId: true,
      employmentPercent: true,
      reductionPercent: true,
      contractKind: true,
      teachingTargetMinutesPerWeek: true,
      signature: true,
      note: true,
    },
    orderBy: { id: 'asc' },
  });
  const dutyRows = await tx.teacherDuty.findMany({
    where: { academicYearId: yearId },
    select: {
      id: true,
      userId: true,
      kind: true,
      label: true,
      minutesPerWeek: true,
      countsAsTeaching: true,
      subjectId: true,
      studentGroupId: true,
      note: true,
      blockedConstraint: {
        select: { resourceType: true, type: true, userId: true, dayOfWeek: true, date: true, startTime: true, endTime: true },
      },
    },
    orderBy: { id: 'asc' },
  });
  const ids = [...new Set([...(employmentRows ?? []), ...(dutyRows ?? [])].map((row) => row.userId))].sort();
  const people =
    ids.length > 0
      ? await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, role: true, isActive: true } })
      : [];
  const decimal = (value: unknown): string => Number(value).toFixed(3);
  return {
    employments: (employmentRows ?? []).map((row) => ({
      id: row.id,
      userId: row.userId,
      employmentPercent: decimal(row.employmentPercent),
      reductionPercent: decimal(row.reductionPercent),
      contractKind: row.contractKind,
      teachingTargetMinutesPerWeek: row.teachingTargetMinutesPerWeek,
      signature: row.signature,
      note: row.note,
    })),
    duties: (dutyRows ?? []).map((row): SourceDuty => {
      const slot = row.blockedConstraint;
      const guarded =
        slot !== null &&
        slot !== undefined &&
        slot.resourceType === 'TEACHER' &&
        slot.type === 'UNAVAILABLE' &&
        slot.userId === row.userId &&
        slot.dayOfWeek !== null &&
        slot.date === null;
      return {
        id: row.id,
        userId: row.userId,
        kind: row.kind,
        label: row.label,
        minutesPerWeek: row.minutesPerWeek,
        countsAsTeaching: row.countsAsTeaching,
        subjectId: row.subjectId,
        studentGroupId: row.studentGroupId,
        note: row.note,
        slot: guarded
          ? { dayOfWeek: slot.dayOfWeek as number, startTime: slotClock(slot.startTime), endTime: slotClock(slot.endTime) }
          : null,
      };
    }),
    staff: new Map((people ?? []).map((person) => [person.id, { role: person.role, isActive: person.isActive }])),
  };
}
