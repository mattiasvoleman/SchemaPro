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
import { pendingMoves, planActivation, readActivationSource } from './activation-plan';

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
  /** Pupils the source's own activation would still move (ROLLOVER_SOURCE_NOT_ACTIVATED). */
  pendingMoves: number;
}

export async function readRolloverSource(
  tx: PrismaClient,
  sourceYearId: string,
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
  const employments = await tx.teacherEmployment.count({ where: { academicYearId: sourceYearId } });
  const duties = await tx.teacherDuty.count({ where: { academicYearId: sourceYearId } });
  const dutyBlockedSlots = await tx.teacherDuty.count({
    where: { academicYearId: sourceYearId, blockedConstraintId: { not: null } },
  });
  const mentorskap = await tx.teacherDuty.count({
    where: { academicYearId: sourceYearId, kind: 'MENTORSKAP' },
  });

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
    pendingMoves: pending,
  };
}
