import { ConflictException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { clashPairs, yearClashes, type YearClashKind } from '../common/year-clashes';
import { constraintsOfYear } from '../staffing/duty-slot-year';
import { readUnstaffedRequirements } from '../staffing/unstaffed-requirements';
import { readHomeClassesOf, readHomePupils, rostersOfYear } from '../year-rollover/projected-rosters';
import type { GateEntry, GateFinding } from './publication-gates';

/**
 * The grundschema checks of the gate list, read inside the publish's own
 * transaction so they judge exactly the lessons the publish materialises.
 * The checks that need another module's whole report (the timplan layers,
 * the staffing load) are the service's: those modules answer in a
 * transaction of their own, through their public methods, so the gate reads
 * the figure the admin sees on their page and never a second copy of it.
 */

const WEEKDAY = ['', 'mån', 'tis', 'ons', 'tors', 'fre', 'lör', 'sön'];

const clock = (value: Date): string => value.toISOString().slice(11, 16);
const day = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null);

/** The year's master lessons as the gates read them, names included. */
export interface GateLesson {
  id: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  recurrence: 'ALL_WEEKS' | 'ODD_WEEKS' | 'EVEN_WEEKS';
  startDate: string | null;
  endDate: string | null;
  isParked: boolean;
  extraGroupIds: string[];
  studentIds: string[];
  subjectName: string;
  groupName: string;
}

export async function readGateLessons(tx: PrismaClient, academicYearId: string): Promise<GateLesson[]> {
  const rows = await tx.masterLesson.findMany({
    where: { academicYearId },
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
      recurrence: true,
      startDate: true,
      endDate: true,
      isParked: true,
      extraGroups: { select: { studentGroupId: true } },
      participants: { select: { studentId: true } },
      subject: { select: { name: true } },
      studentGroup: { select: { name: true } },
    },
    orderBy: { id: 'asc' },
  });
  return rows.map((row) => ({
    id: row.id,
    subjectId: row.subjectId,
    studentGroupId: row.studentGroupId,
    teacherId: row.teacherId,
    coTeacherId: row.coTeacherId,
    roomId: row.roomId,
    dayOfWeek: row.dayOfWeek,
    startTime: clock(row.startTime),
    endTime: clock(row.endTime),
    recurrence: row.recurrence,
    startDate: day(row.startDate),
    endDate: day(row.endDate),
    isParked: row.isParked,
    extraGroupIds: row.extraGroups.map((entry) => entry.studentGroupId).sort(),
    studentIds: row.participants.map((entry) => entry.studentId).sort(),
    subjectName: row.subject.name,
    groupName: row.studentGroup.name,
  }));
}

/** "Matematik · 7B, mån 08:00–09:00": the lesson as the board names it. */
export function lessonLabel(lesson: GateLesson): string {
  return `${lesson.subjectName} · ${lesson.groupName}, ${WEEKDAY[lesson.dayOfWeek] ?? lesson.dayOfWeek} ${lesson.startTime}–${lesson.endTime}`;
}

const entryOf = (lesson: GateLesson): GateEntry => ({ label: lessonLabel(lesson), masterLessonId: lesson.id });

/** PUB_PARKED, PUB_NO_TEACHER, PUB_NO_ROOM: read off the lessons alone. */
export function lessonFindings(lessons: readonly GateLesson[]): GateFinding[] {
  const parked = lessons.filter((lesson) => lesson.isParked);
  const placed = lessons.filter((lesson) => !lesson.isParked);
  const noTeacher = placed.filter((lesson) => !lesson.teacherId && !lesson.coTeacherId);
  const noRoom = placed.filter((lesson) => !lesson.roomId);
  return [
    { code: 'PUB_PARKED', count: parked.length, entries: parked.map(entryOf) },
    { code: 'PUB_NO_TEACHER', count: noTeacher.length, entries: noTeacher.map(entryOf) },
    { code: 'PUB_NO_ROOM', count: noRoom.length, entries: noRoom.map(entryOf) },
  ];
}

const KIND_LABEL: Record<YearClashKind, string> = {
  TEACHER: 'Lärare dubbelbokad',
  ROOM: 'Sal dubbelbokad',
  GROUP: 'Elever dubbelbokade',
  AVAILABILITY: 'Otillgänglig tid',
};

/**
 * PUB_CLASHES: what the board paints red (src/common/year-clashes.ts), over
 * the placed lessons, with the board's own inputs — weekly UNAVAILABLE rules
 * of the year, pupils' home classes and teaching groups, pupil buffers.
 */
export async function clashFinding(
  tx: PrismaClient,
  user: AuthenticatedUser,
  academicYearId: string,
  lessons: readonly GateLesson[],
): Promise<GateFinding> {
  const placed = lessons.filter((lesson) => !lesson.isParked);
  if (placed.length === 0) return { code: 'PUB_CLASHES', count: 0 };
  const groupIds = [...new Set(placed.flatMap((lesson) => [lesson.studentGroupId, ...lesson.extraGroupIds]))];
  const participantIds = [...new Set(placed.flatMap((lesson) => lesson.studentIds))];

  const constraints = await tx.availabilityConstraint.findMany({
    where: { type: 'UNAVAILABLE', date: null, AND: [constraintsOfYear(academicYearId)] },
    select: {
      type: true,
      resourceType: true,
      userId: true,
      roomId: true,
      studentGroupId: true,
      dayOfWeek: true,
      startTime: true,
      endTime: true,
    },
  });
  const buffers = await tx.teachingRequirement.findMany({
    where: { academicYearId, OR: [{ minutesBefore: { gt: 0 } }, { minutesAfter: { gt: 0 } }] },
    select: { studentGroupId: true, subjectId: true, minutesBefore: true, minutesAfter: true },
  });
  const memberships = await tx.studentGroupMember.findMany({
    where: { studentGroupId: { in: groupIds } },
    select: { studentId: true, studentGroupId: true },
  });
  // The pupils whose class decides a shared-pupil clash, through the year's
  // roster basis — the one the API's own findConflicts reads. A year two
  // steps ahead has no basis (R6, 409); its classes are then read as they
  // stand, which is what the board shows for it too.
  let homes: Array<[string, string | null]> = [];
  try {
    const basis = await rostersOfYear(tx, user, academicYearId);
    const studentIds = [...new Set(memberships.map((row) => row.studentId).concat(participantIds))];
    const home = await readHomePupils(tx, basis, {}, groupIds);
    const named = studentIds.length > 0 ? await readHomeClassesOf(tx, basis, studentIds) : [];
    homes = [
      ...home.map((row) => [row.id, row.studentGroupId] as [string, string | null]),
      ...named.map((row) => [row.id, row.studentGroupId] as [string, string | null]),
    ];
  } catch (error) {
    if (!(error instanceof ConflictException)) throw error;
  }

  const clashes = yearClashes({
    lessons: placed,
    constraints: constraints.map((row) => ({
      ...row,
      date: null,
      startTime: clock(row.startTime),
      endTime: clock(row.endTime),
    })),
    studentGroupOf: homes,
    memberships,
    pupilBuffers: buffers,
  });
  const byId = new Map(placed.map((lesson) => [lesson.id, lesson]));
  const pairs = clashPairs(clashes);
  return {
    code: 'PUB_CLASHES',
    count: pairs.length,
    entries: pairs.map((pair) => ({
      label: `${KIND_LABEL[pair.kind]}: ${pair.lessonIds
        .map((id) => byId.get(id))
        .filter((lesson): lesson is GateLesson => Boolean(lesson))
        .map(lessonLabel)
        .join(' och ')}`,
      masterLessonId: pair.lessonIds[0],
    })),
  };
}

/** PUB_UNSTAFFED: the timplansposter with no teacher (the generate pre-flight's query). */
export async function unstaffedFinding(tx: PrismaClient, academicYearId: string): Promise<GateFinding> {
  const rows = await readUnstaffedRequirements(tx, academicYearId);
  const named = rows
    .map((row) => ({ id: row.id, label: `${row.subject.name} för ${row.studentGroup.name}` }))
    .sort((a, b) => a.label.localeCompare(b.label, 'sv') || a.id.localeCompare(b.id));
  return {
    code: 'PUB_UNSTAFFED',
    count: named.length,
    entries: named.map((row) => ({ label: row.label, requirementId: row.id })),
  };
}

/** PUB_LUNCH_NOT_SET: the publish dialog's old warning, now a named check. */
export async function lunchFinding(tx: PrismaClient, schoolId: string): Promise<GateFinding> {
  const setting = await tx.lunchSetting.findUnique({
    where: { schoolId },
    select: { lunchEnabled: true },
  });
  return { code: 'PUB_LUNCH_NOT_SET', count: setting?.lunchEnabled === true ? 0 : 1 };
}
