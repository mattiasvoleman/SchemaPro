import { NotFoundException } from '@nestjs/common';
import type { LessonRecurrence, PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { GradeNumbering } from '../common/grade-numbering';
import type { DistributionRule } from '../common/subject-distribution';
import type { TeacherDayRule } from '../common/teacher-day';
import { effectiveDistribution } from '../common/subject-distribution';
import { loadRosters, type Rosters } from '../optimization/room-eligibility';
import { readOtherSchoolHolds, type OtherSchoolHold } from '../optimization/other-school-holds';
import { constraintsOfYear } from '../staffing/duty-slot-year';
import { rostersOfYear, type RosterBasis } from '../year-rollover/projected-rosters';
import type { LunchRule } from './swap-gaps';
import type { SwapLesson } from './swap-types';

/*
 * WHAT THE SEARCH READS, ONCE.
 *
 * The year's placed grundschema and the facts the rules about it stand on, read
 * inside one RLS transaction of the scheduler's own, then left to memory: a
 * search asks the clash rule hundreds of times and must not ask the database
 * each time. Every read is a read the hand edit, the generator or the publish
 * gate already makes, of the same rows by the same filters; none is a new
 * view of the school. Nothing here names a person beyond the ids the grid has.
 */

const WEEKDAY_MAX = 7;

export interface SwapPost {
  studentGroupId: string;
  subjectId: string;
  blockId: string | null;
  minutesBefore: number;
  minutesAfter: number;
  distribution: DistributionRule;
}

export interface SwapGroup {
  id: string;
  name: string;
  kind: 'CLASS' | 'TEACHING_GROUP';
  halfOfId: string | null;
  replacesSubjectId: string | null;
  gradeLevel: number | null;
}

/** A weekly UNAVAILABLE row, in minutes. */
export interface SwapConstraint {
  resourceType: 'TEACHER' | 'ROOM' | 'STUDENT_GROUP' | 'GRADE_LEVEL' | string;
  userId: string | null;
  roomId: string | null;
  studentGroupId: string | null;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  dayOfWeek: number | null;
  startMinutes: number;
  endMinutes: number;
}

export interface SwapFrame {
  min: number;
  max: number;
  day: number | null;
  start: number;
  end: number;
}

export interface SwapSitting {
  studentGroupId: string;
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
}

export interface SwapData {
  schoolId: string;
  academicYearId: string;
  gradeNumbering: GradeNumbering;
  basis: RosterBasis;
  lessons: SwapLesson[];
  posts: SwapPost[];
  blocks: Array<{ id: string; sameTimesAsBlockId: string | null }>;
  groups: SwapGroup[];
  rosters: Rosters;
  constraints: SwapConstraint[];
  frames: SwapFrame[];
  lunch: LunchRule | null;
  sittings: SwapSitting[];
  holds: OtherSchoolHold[];
  /** Only the teachers who have a rule of their day, caps and the post's limits. */
  teacherRules: Map<string, TeacherDayRule>;
  /** The teachers whose rule includes a limit of their post (HR data). */
  postLimited: Set<string>;
}

const minutesOf = (time: Date): number => time.getUTCHours() * 60 + time.getUTCMinutes();
const dayOf = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null);

export async function readSwapData(
  tx: PrismaClient,
  user: AuthenticatedUser,
  academicYearId: string,
): Promise<SwapData> {
  const year = await tx.academicYear.findUnique({
    where: { id: academicYearId },
    select: { id: true, schoolId: true, isActive: true, predecessorId: true, gradeNumbering: true },
  });
  if (!year) throw new NotFoundException('Academic year not found.');
  const schoolId = year.schoolId;
  const basis = await rostersOfYear(tx, user, academicYearId, year);

  const [lessonRows, postRows, blockRows, groupRows, constraintRows, frameRows, lunchRow, sittingRows] =
    await Promise.all([
      tx.masterLesson.findMany({
        where: { academicYearId, isParked: false },
        select: {
          id: true,
          subjectId: true,
          studentGroupId: true,
          teacherId: true,
          coTeacherId: true,
          roomId: true,
          dayOfWeek: true,
          startTime: true,
          endTime: true,
          isLocked: true,
          isGenerated: true,
          recurrence: true,
          startDate: true,
          endDate: true,
          subject: { select: { name: true } },
          studentGroup: { select: { name: true } },
          extraGroups: { select: { studentGroupId: true } },
          participants: { select: { studentId: true } },
        },
        orderBy: { id: 'asc' },
      }),
      tx.teachingRequirement.findMany({
        where: { academicYearId },
        select: {
          studentGroupId: true,
          subjectId: true,
          blockId: true,
          minutesBefore: true,
          minutesAfter: true,
          ownDistribution: true,
          maxLessonsPerDay: true,
          minDaysBetween: true,
          subject: { select: { maxLessonsPerDay: true, minDaysBetween: true } },
        },
      }),
      tx.teachingBlock.findMany({
        where: { academicYearId },
        select: { id: true, sameTimesAsBlockId: true },
      }),
      tx.studentGroup.findMany({
        where: { academicYearId },
        select: { id: true, name: true, kind: true, halfOfId: true, replacesSubjectId: true, gradeLevel: true },
      }),
      tx.availabilityConstraint.findMany({
        where: { type: 'UNAVAILABLE', date: null, AND: [constraintsOfYear(academicYearId)] },
        select: {
          resourceType: true,
          userId: true,
          roomId: true,
          studentGroupId: true,
          minGradeLevel: true,
          maxGradeLevel: true,
          dayOfWeek: true,
          startTime: true,
          endTime: true,
        },
      }),
      tx.frameTime.findMany({
        where: { school: { academicYears: { some: { id: academicYearId } } } },
        select: { minGradeLevel: true, maxGradeLevel: true, dayOfWeek: true, startTime: true, endTime: true },
      }),
      tx.lunchSetting.findUnique({
        where: { schoolId },
        select: { lunchEnabled: true, lunchStartTime: true, lunchEndTime: true, lunchMinutes: true },
      }),
      tx.lunchSitting.findMany({
        where: { academicYearId },
        select: { studentGroupId: true, dayOfWeek: true, startTime: true, endTime: true },
      }),
    ]);

  const groups: SwapGroup[] = groupRows.map((group) => ({
    id: group.id,
    name: group.name,
    kind: group.kind as SwapGroup['kind'],
    halfOfId: group.halfOfId,
    replacesSubjectId: group.replacesSubjectId,
    gradeLevel: group.gradeLevel,
  }));
  const lessons: SwapLesson[] = lessonRows
    .filter((row) => row.dayOfWeek >= 1 && row.dayOfWeek <= WEEKDAY_MAX && row.endTime > row.startTime)
    .map((row) => ({
      id: row.id,
      subjectId: row.subjectId,
      subjectName: row.subject.name,
      studentGroupId: row.studentGroupId,
      groupName: row.studentGroup.name,
      teacherId: row.teacherId,
      coTeacherId: row.coTeacherId,
      roomId: row.roomId,
      dayOfWeek: row.dayOfWeek,
      startMinutes: minutesOf(row.startTime),
      endMinutes: minutesOf(row.endTime),
      recurrence: row.recurrence as LessonRecurrence,
      startDate: dayOf(row.startDate),
      endDate: dayOf(row.endDate),
      isLocked: row.isLocked,
      isGenerated: row.isGenerated,
      extraGroupIds: row.extraGroups.map((entry) => entry.studentGroupId).sort(),
      studentIds: row.participants.map((entry) => entry.studentId).sort(),
    }));

  // The pupils behind the groups, through the year's basis as the clash rule reads them.
  const groupIds = [...new Set([...groups.map((group) => group.id), ...lessons.flatMap((l) => [l.studentGroupId, ...l.extraGroupIds])])];
  const rosters = await loadRosters(
    tx,
    basis,
    groupIds,
    groups.map((group) => ({ id: group.id, gradeLevel: group.gradeLevel, halfOfId: group.halfOfId })),
    lessons.flatMap((lesson) => lesson.studentIds),
  );

  // The other schools' hold on this school's teachers and rooms: the shared
  // teacher's lessons elsewhere, a room lent out or borrowed.
  const holds = (await readOtherSchoolHolds(tx, academicYearId, schoolId)).holds;

  // The teachers' day rules: the cap is the work rule's, every member of staff
  // reads it; the day limit and the limit for teaching in a row are the post's.
  const teacherIds = [...new Set(lessons.flatMap((l) => [l.teacherId, l.coTeacherId]).filter((id): id is string => id !== null))];
  const [workRules, posts] = teacherIds.length === 0
    ? [[], []]
    : await Promise.all([
        tx.teacherWorkRule.findMany({
          where: { userId: { in: teacherIds }, maxTeachingMinutesPerDay: { not: null } },
          select: { userId: true, maxTeachingMinutesPerDay: true },
        }),
        tx.teacherEmployment.findMany({
          where: {
            academicYearId,
            userId: { in: teacherIds },
            OR: [{ maxTeachingDaysPerWeek: { not: null } }, { maxConsecutiveTeachingMinutes: { not: null } }],
          },
          select: {
            userId: true,
            maxTeachingDaysPerWeek: true,
            maxConsecutiveTeachingMinutes: true,
            consecutiveBreakMinutes: true,
          },
        }),
      ]);
  const teacherRules = new Map<string, TeacherDayRule>();
  const postLimited = new Set<string>();
  for (const id of teacherIds) {
    const cap = workRules.find((row) => row.userId === id)?.maxTeachingMinutesPerDay ?? null;
    const post = posts.find((row) => row.userId === id);
    if (post) postLimited.add(id);
    if (cap === null && !post) continue;
    teacherRules.set(id, {
      maxTeachingMinutesPerDay: cap,
      maxTeachingDaysPerWeek: post?.maxTeachingDaysPerWeek ?? null,
      maxConsecutiveTeachingMinutes: post?.maxConsecutiveTeachingMinutes ?? null,
      consecutiveBreakMinutes: post?.consecutiveBreakMinutes ?? null,
    });
  }

  return {
    schoolId,
    academicYearId,
    gradeNumbering: year.gradeNumbering as GradeNumbering,
    basis,
    lessons,
    posts: postRows.map((row) => ({
      studentGroupId: row.studentGroupId,
      subjectId: row.subjectId,
      blockId: row.blockId,
      minutesBefore: row.minutesBefore,
      minutesAfter: row.minutesAfter,
      distribution: effectiveDistribution(row, row.subject),
    })),
    blocks: blockRows,
    groups,
    rosters,
    constraints: constraintRows.map((row) => ({
      resourceType: row.resourceType,
      userId: row.userId,
      roomId: row.roomId,
      studentGroupId: row.studentGroupId,
      minGradeLevel: row.minGradeLevel,
      maxGradeLevel: row.maxGradeLevel,
      dayOfWeek: row.dayOfWeek,
      startMinutes: minutesOf(row.startTime),
      endMinutes: minutesOf(row.endTime),
    })),
    frames: frameRows.map((row) => ({
      min: row.minGradeLevel,
      max: row.maxGradeLevel,
      day: row.dayOfWeek,
      start: minutesOf(row.startTime),
      end: minutesOf(row.endTime),
    })),
    lunch:
      lunchRow && lunchRow.lunchEnabled && minutesOf(lunchRow.lunchEndTime) > minutesOf(lunchRow.lunchStartTime)
        ? {
            start: minutesOf(lunchRow.lunchStartTime),
            end: minutesOf(lunchRow.lunchEndTime),
            minutes: Math.min(
              Math.max(lunchRow.lunchMinutes ?? 0, 0),
              minutesOf(lunchRow.lunchEndTime) - minutesOf(lunchRow.lunchStartTime),
            ),
          }
        : null,
    sittings: sittingRows.map((row) => ({
      studentGroupId: row.studentGroupId,
      dayOfWeek: row.dayOfWeek,
      startMinutes: minutesOf(row.startTime),
      endMinutes: minutesOf(row.endTime),
    })),
    holds,
    teacherRules,
    postLimited,
  };
}
