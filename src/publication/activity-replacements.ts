import type { PrismaClient } from '@prisma/client';
import { calendarLessonRosters, rostersOf } from '../calendar/lesson-roster';
import { asDay, day } from './cancellation-core';
import {
  closedDaysOf,
  noteOf,
  ownersOf,
  planReplacements,
  uncoveredPupilIds,
  type GroupFacts,
  type PlanLesson,
  type PlanOwner,
  type PlannedReplacement,
  type ScopeRule,
} from './activity-plan';

/*
 * THE REPLACEMENT LESSONS OF AN ACTIVITY, read and written in the caller's
 * transaction.
 *
 * They are CalendarLessons without a master lesson (the grundschema knows
 * nothing of them, as it knows nothing of an SS12000 ad hoc activity), marked
 * by ScheduleActivityLessons, one per owner and day. Everything that decides
 * WHAT they are is activity-plan.ts; this file reads the owned cancelled
 * lessons and the owners' pupils, asks it, and brings the calendar to match.
 *
 * Run by the activity when it is made or changed, and by the avbokning's
 * re-application (reapplyInTransaction): a publish or a refill that writes a
 * lesson into the activity's days is cancelled with the rest (S7), and the
 * replacement lesson of that class and day starts earlier, ends later, or
 * appears. Idempotent: a second run over the same calendar writes nothing.
 *
 * WHAT IT NEVER TOUCHES: a replacement lesson that has begun, or that carries
 * attendance. It is the record of a day that was held; a later change of the
 * activity ends before it. A replacement lesson ahead that no cancelled lesson
 * needs any more (its class's lessons were put back, or never came) is
 * deleted. Teachers are managed (LEAD and ASSISTANT rows follow the activity);
 * a SUBSTITUTE row on the lesson is the day's own and stays.
 */

export interface SyncResult {
  created: string[];
  updated: string[];
  deleted: string[];
  /** Kept although the plan no longer has them: began, or carry attendance. */
  kept: string[];
}

const EMPTY: SyncResult = { created: [], updated: [], deleted: [], kept: [] };

/** The year's groups, as the planner reads them. */
export async function loadGroupFacts(tx: PrismaClient, academicYearId: string): Promise<GroupFacts[]> {
  const rows = await tx.studentGroup.findMany({
    where: { academicYearId },
    select: { id: true, name: true, kind: true, gradeLevel: true, halfOfId: true },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    gradeLevel: row.gradeLevel,
    halfOfId: row.halfOfId,
  }));
}

/**
 * For each teaching group, the home class of each of its ACTIVE pupils (the
 * expansion's test). A pupil who has left is on no roster (the roster reader
 * asks for active pupils), so a group that only they tie to another class is
 * wholly inside the named ones all the same.
 */
export async function memberHomes(tx: PrismaClient, groupIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (groupIds.length === 0) return out;
  const rows = await tx.studentGroupMember.findMany({
    where: { studentGroupId: { in: [...groupIds] }, student: { role: 'STUDENT', isActive: true } },
    select: { studentGroupId: true, student: { select: { studentGroupId: true } } },
  });
  for (const row of rows) {
    const list = out.get(row.studentGroupId) ?? [];
    // A member with no home class can never be inside a named class.
    list.push(row.student.studentGroupId ?? 'none');
    out.set(row.studentGroupId, list);
  }
  return out;
}

/** What a cancelled lesson is, for the rosters and the plan. */
export interface ReplacedLesson {
  id: string;
  date: Date;
  startsAt: Date;
  endsAt: Date;
  subjectId: string;
  studentGroupId: string;
  extraGroups: ReadonlyArray<{ studentGroupId: string }>;
}

/** The days an activity covers, to find the lov inside them. */
export interface ActivityWindow {
  academicYearId: string;
  from: string;
  to: string;
}

/**
 * The owners with their pupils, for a replacement subject, and (when the
 * activity's days are given) the days each of them is off school.
 */
export async function ownersWithPupils(
  tx: PrismaClient,
  rule: ScopeRule,
  groups: readonly GroupFacts[],
  replacementSubjectId: string,
  window?: ActivityWindow,
): Promise<{ owners: GroupFacts[]; planOwners: PlanOwner[] }> {
  const owners = ownersOf(rule, groups);
  const rosters = await rostersOf(
    tx,
    owners.map((owner) => ({ subjectId: replacementSubjectId, groupIds: [owner.id], participantIds: [] })),
    { pupils: 'ACTIVE' },
  );
  const breaks = window
    ? await tx.schoolBreak.findMany({
        where: {
          academicYearId: window.academicYearId,
          startDate: { lte: day(window.to) },
          endDate: { gte: day(window.from) },
        },
        select: { startDate: true, endDate: true, minGradeLevel: true, maxGradeLevel: true },
      })
    : [];
  return {
    owners,
    planOwners: owners.map((owner, index) => ({
      groupId: owner.id,
      pupils: rosters[index],
      ...(window && breaks.length > 0 ? { closed: closedDaysOf(breaks, owner.gradeLevel, window.from, window.to) } : {}),
    })),
  };
}

/** The plan for these cancelled lessons and owners. */
export async function planOf(
  tx: PrismaClient,
  lessons: readonly ReplacedLesson[],
  planOwners: readonly PlanOwner[],
): Promise<{
  plan: PlannedReplacement[];
  planLessons: PlanLesson[];
  /** How many pupils on a cancelled lesson no owner holds, and who they are. */
  uncovered: number;
  uncoveredIds: ReadonlySet<string>;
}> {
  const rosters = await calendarLessonRosters(
    tx,
    lessons.map((lesson) => ({
      id: lesson.id,
      subjectId: lesson.subjectId,
      studentGroupId: lesson.studentGroupId,
      extraGroups: lesson.extraGroups,
    })),
    { pupils: 'ACTIVE' },
  );
  const planLessons: PlanLesson[] = lessons.map((lesson) => ({
    id: lesson.id,
    date: asDay(lesson.date),
    startsAt: lesson.startsAt,
    endsAt: lesson.endsAt,
    pupils: rosters.get(lesson.id) ?? new Set<string>(),
  }));
  const uncovered = uncoveredPupilIds(planLessons, planOwners);
  return {
    plan: planReplacements(planLessons, planOwners),
    planLessons,
    uncovered: uncovered.size,
    uncoveredIds: uncovered,
  };
}

const LESSON_SHAPE = {
  id: true,
  date: true,
  startsAt: true,
  endsAt: true,
  subjectId: true,
  studentGroupId: true,
  extraGroups: { select: { studentGroupId: true } },
} as const;

/**
 * Brings the replacement lessons of the activity that owns this avbokning to
 * the plan its cancelled lessons make. A batch that no activity owns, or one
 * that was removed, writes nothing.
 */
export async function syncReplacementsInTransaction(
  tx: PrismaClient,
  schoolId: string,
  batchId: string,
  now: Date = new Date(),
): Promise<SyncResult> {
  const activity = await tx.scheduleActivity.findFirst({
    where: { batchId, removedAt: null },
    select: {
      id: true,
      academicYearId: true,
      replacementSubjectId: true,
      description: true,
      scopeGroupIds: true,
      batch: {
        select: { name: true, cause: true, scope: true, minGradeLevel: true, maxGradeLevel: true, fromDate: true, toDate: true },
      },
      teachers: { select: { studentGroupId: true, teacherId: true, role: true } },
    },
  });
  if (!activity) return { ...EMPTY };

  const owned = await tx.calendarLesson.findMany({
    where: {
      batchLessons: { some: { batchId } },
      status: 'CANCELLED',
      cancelCause: activity.batch.cause,
    },
    select: LESSON_SHAPE,
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
  });
  const groups = await loadGroupFacts(tx, activity.academicYearId);
  const rule: ScopeRule = {
    scope: activity.batch.scope as ScopeRule['scope'],
    minGradeLevel: activity.batch.minGradeLevel,
    maxGradeLevel: activity.batch.maxGradeLevel,
    groupIds: activity.scopeGroupIds,
  };
  const { planOwners } = await ownersWithPupils(tx, rule, groups, activity.replacementSubjectId, {
    academicYearId: activity.academicYearId,
    from: asDay(activity.batch.fromDate),
    to: asDay(activity.batch.toDate),
  });
  const { plan } = owned.length === 0 ? { plan: [] as PlannedReplacement[] } : await planOf(tx, owned, planOwners);

  const existing = await tx.scheduleActivityLesson.findMany({
    where: { activityId: activity.id },
    select: {
      calendarLessonId: true,
      studentGroupId: true,
      date: true,
      calendarLesson: {
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          note: true,
          status: true,
          _count: { select: { attendanceRecords: true } },
          teachers: { select: { id: true, teacherId: true, role: true } },
        },
      },
    },
  });
  const keyOf = (groupId: string, date: string) => `${groupId}|${date}`;
  const have = new Map(existing.map((row) => [keyOf(row.studentGroupId, asDay(row.date)), row]));
  const want = new Map(plan.map((entry) => [keyOf(entry.groupId, entry.date), entry]));
  const note = noteOf(activity.batch.name, activity.description);
  const result: SyncResult = { created: [], updated: [], deleted: [], kept: [] };

  const wanted = (groupId: string) =>
    activity.teachers
      .filter((teacher) => teacher.studentGroupId === groupId)
      .map((teacher) => ({ teacherId: teacher.teacherId, role: teacher.role }));

  for (const [key, entry] of want) {
    const row = have.get(key);
    if (!row) {
      // A day that has begun is not given a replacement after the fact.
      if (entry.startsAt <= now) continue;
      const lesson = await tx.calendarLesson.create({
        data: {
          schoolId,
          masterLessonId: null,
          subjectId: activity.replacementSubjectId,
          studentGroupId: entry.groupId,
          date: day(entry.date),
          startsAt: entry.startsAt,
          endsAt: entry.endsAt,
          status: 'SCHEDULED',
          note,
          teachers: {
            create: wanted(entry.groupId).map((teacher) => ({ teacherId: teacher.teacherId, role: teacher.role })),
          },
        },
        select: { id: true },
      });
      await tx.scheduleActivityLesson.create({
        data: { activityId: activity.id, calendarLessonId: lesson.id, studentGroupId: entry.groupId, date: day(entry.date), schoolId },
      });
      result.created.push(lesson.id);
      continue;
    }
    const lesson = row.calendarLesson;
    // History: it has begun or carries a register. Left exactly as it was held.
    // And one the administrator cancelled by hand (the day planner) stays so.
    if (lesson.startsAt <= now || lesson._count.attendanceRecords > 0 || lesson.status !== 'SCHEDULED') continue;
    const moved = lesson.startsAt.getTime() !== entry.startsAt.getTime() || lesson.endsAt.getTime() !== entry.endsAt.getTime();
    if (moved || lesson.note !== note) {
      await tx.calendarLesson.update({
        where: { id: lesson.id },
        data: { startsAt: entry.startsAt, endsAt: entry.endsAt, note, subjectId: activity.replacementSubjectId },
      });
    }
    const changedTeachers = await syncTeachers(tx, schoolId, lesson, wanted(entry.groupId));
    if (moved || lesson.note !== note || changedTeachers) result.updated.push(lesson.id);
  }

  for (const [key, row] of have) {
    if (want.has(key)) continue;
    const lesson = row.calendarLesson;
    if (lesson.startsAt <= now || lesson._count.attendanceRecords > 0) {
      result.kept.push(lesson.id);
      continue;
    }
    // The guard again in the statement: a register saved since the read above
    // would go with the lesson (AttendanceRecords cascade), so a lesson that
    // began or gained attendance in between is kept.
    const { count } = await tx.calendarLesson.deleteMany({
      where: { id: lesson.id, startsAt: { gt: now }, attendanceRecords: { none: {} } },
    });
    if (count === 1) result.deleted.push(lesson.id);
    else result.kept.push(lesson.id);
  }
  return result;
}

type Role = 'LEAD' | 'ASSISTANT' | 'SUBSTITUTE';

/** LEAD and ASSISTANT rows follow the activity; a SUBSTITUTE row stays. True when anything changed. */
async function syncTeachers(
  tx: PrismaClient,
  schoolId: string,
  lesson: { id: string; teachers: ReadonlyArray<{ id: string; teacherId: string; role: Role }> },
  wanted: ReadonlyArray<{ teacherId: string; role: Role }>,
): Promise<boolean> {
  let changed = false;
  const managed = lesson.teachers.filter((row) => row.role !== 'SUBSTITUTE');
  const wantedById = new Map(wanted.map((teacher) => [teacher.teacherId, teacher.role]));
  const present = new Set(lesson.teachers.map((row) => row.teacherId));
  for (const row of managed) {
    const role = wantedById.get(row.teacherId);
    if (role === undefined) {
      await tx.calendarLessonTeacher.delete({ where: { id: row.id } });
      changed = true;
    } else if (role !== row.role) {
      await tx.calendarLessonTeacher.update({ where: { id: row.id }, data: { role } });
      changed = true;
    }
  }
  for (const teacher of wanted) {
    if (present.has(teacher.teacherId)) continue;
    await tx.calendarLessonTeacher.create({
      data: { schoolId, calendarLessonId: lesson.id, teacherId: teacher.teacherId, role: teacher.role },
    });
    changed = true;
  }
  return changed;
}
