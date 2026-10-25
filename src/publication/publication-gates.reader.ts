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
  // Halvklasser: a half among the groups, or a class with halves, brings the
  // class and its halves into the reads below — a half answers for the pupils
  // it may hold, a question about its whole class (class-halves.ts).
  const yearHalves = await readHalves(tx, academicYearId);
  const inPlay = new Set(groupIds);
  const halves = yearHalves.filter((half) => inPlay.has(half.id) || inPlay.has(half.halfOfId));
  const classes = [...new Set(halves.map((half) => half.halfOfId))];
  const halfClassIds = new Set(classes);
  const allHalves = yearHalves.filter((half) => halfClassIds.has(half.halfOfId));
  groupIds.push(...[...classes, ...allHalves.map((half) => half.id)].filter((id) => !inPlay.has(id)));
  // Ersättande grupper: the year's groups replacing a subject, and their
  // members with every other group's, so SvA7 beside 7A's svenska is no
  // double booking (replacing-groups.ts) — as the board and the generator see it.
  const replacing = (
    (await tx.studentGroup.findMany({
      where: { academicYearId, replacesSubjectId: { not: null } },
      select: { id: true, replacesSubjectId: true },
    })) ?? []
  ).flatMap((group) => (group.replacesSubjectId ? [{ id: group.id, replacesSubjectId: group.replacesSubjectId }] : []));
  const known = new Set(groupIds);
  groupIds.push(...replacing.map((group) => group.id).filter((id) => !known.has(id)));
  // Active STUDENTs, on both sides, as the generator and the hand edit read
  // them: a pupil who left a split class unplaced would otherwise pair both
  // halves with all their groups at every publish, on the generator's own
  // week, with no placement able to clear it (master-lessons.service rosterOf).
  const memberships = await tx.studentGroupMember.findMany({
    where: { studentGroupId: { in: groupIds }, student: { role: 'STUDENT', isActive: true } },
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
    const home = await readHomePupils(tx, basis, { role: 'STUDENT', isActive: true }, groupIds);
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
    halves: allHalves,
    ...(replacing.length > 0 ? { replacing } : {}),
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

/** A post of a parallel block, as blockSplitFinding reads it. */
export interface BlockPost {
  studentGroupId: string;
  subjectId: string;
  blockId: string;
  blockName: string;
}

/**
 * PUB_BLOCK_SPLIT: the parallel blocks whose lessons do not all stand
 * together — a member moved by hand away from the others (Block i schemat,
 * src/calendar/block-lessons.ts). Information, never asked about: the board
 * warned when the block was split, and the generation refuses it as partly
 * locked unless all of it is locked; the publish names it so a split nobody meant is seen before the
 * calendar takes it.
 *
 * A block stands together when every slot (day, clock, weeks) holding a
 * lesson of one of its members holds one of every member that has a placed
 * lesson. A member with none is unplaced, which PUB_UNPLACED says; it splits
 * nothing. Counted per lesson standing apart, as the entries name them,
 * each after its block's name. Positions only, not owners: a block made over
 * a timetable that never placed it together stands apart too, and the
 * generation places that one together again, so the finding says where the
 * lessons stand, not what the generation will do.
 */
export function blockSplits(lessons: readonly GateLesson[], posts: readonly BlockPost[]): GateFinding {
  const blocks = new Map<string, { name: string; keys: Set<string> }>();
  for (const post of posts) {
    const block = blocks.get(post.blockId) ?? { name: post.blockName, keys: new Set<string>() };
    block.keys.add(`${post.studentGroupId}:${post.subjectId}`);
    blocks.set(post.blockId, block);
  }
  const placed = new Map<string, GateLesson[]>();
  for (const lesson of lessons) {
    if (lesson.isParked) continue;
    const key = `${lesson.studentGroupId}:${lesson.subjectId}`;
    placed.set(key, [...(placed.get(key) ?? []), lesson]);
  }
  const entries: GateEntry[] = [];
  for (const { name, keys } of [...blocks.values()].sort((a, b) => a.name.localeCompare(b.name, 'sv'))) {
    const standing = [...keys].filter((key) => (placed.get(key) ?? []).length > 0);
    if (standing.length < 2) continue;
    const slots = new Map<string, { keys: Set<string>; lessons: GateLesson[] }>();
    for (const key of standing) {
      for (const lesson of placed.get(key)!) {
        const slot = [lesson.dayOfWeek, lesson.startTime, lesson.endTime, lesson.recurrence, lesson.startDate, lesson.endDate].join('|');
        const entry = slots.get(slot) ?? { keys: new Set<string>(), lessons: [] };
        entry.keys.add(key);
        entry.lessons.push(lesson);
        slots.set(slot, entry);
      }
    }
    const apart = [...slots.values()]
      .filter((slot) => slot.keys.size < standing.length)
      .flatMap((slot) => slot.lessons);
    entries.push(
      ...apart
        .map((lesson) => ({ label: `${name}: ${lessonLabel(lesson)}`, masterLessonId: lesson.id }))
        .sort((a, b) => a.label.localeCompare(b.label, 'sv')),
    );
  }
  return { code: 'PUB_BLOCK_SPLIT', count: entries.length, entries, info: true };
}

/** PUB_BLOCK_SPLIT over the year's blocks, read once. */
export async function blockSplitFinding(
  tx: PrismaClient,
  academicYearId: string,
  lessons: readonly GateLesson[],
): Promise<GateFinding> {
  const rows = await tx.teachingRequirement.findMany({
    where: { academicYearId, blockId: { not: null } },
    select: { studentGroupId: true, subjectId: true, blockId: true, block: { select: { name: true } } },
  });
  return blockSplits(
    lessons,
    rows.flatMap((row) =>
      row.blockId && row.block
        ? [{ studentGroupId: row.studentGroupId, subjectId: row.subjectId, blockId: row.blockId, blockName: row.block.name }]
        : [],
    ),
  );
}

/** The year's halves (Halvklasser), with their class. */
async function readHalves(tx: PrismaClient, academicYearId: string) {
  const rows = await tx.studentGroup.findMany({
    where: { academicYearId, halfOfId: { not: null } },
    select: { id: true, name: true, halfOfId: true, halfOf: { select: { name: true } } },
    orderBy: { name: 'asc' },
  });
  return rows.flatMap((row) =>
    row.halfOfId ? [{ id: row.id, name: row.name, halfOfId: row.halfOfId, className: row.halfOf?.name ?? '' }] : [],
  );
}

/**
 * PUB_EMPTY_HALF (Halvklasser): a half of a class that has lessons in the
 * timetable and no pupil placed in it. Its lessons would reach nobody's
 * week, while the pupils who are meant to have them see nothing — so it is
 * named before the calendar takes it, by the half and its class, and the
 * school's policy says whether that warns or refuses (gateEmptyHalf). A half
 * with no lessons is no business of the publish.
 */
export async function emptyHalfFinding(
  tx: PrismaClient,
  academicYearId: string,
  lessons: readonly GateLesson[],
): Promise<GateFinding> {
  const taught = new Set(
    lessons.filter((lesson) => !lesson.isParked).flatMap((lesson) => [lesson.studentGroupId, ...lesson.extraGroupIds]),
  );
  const halves = (await readHalves(tx, academicYearId)).filter((half) => taught.has(half.id));
  // The active pupils placed in each, as the memberships stand: a pupil who
  // left holds no half.
  const placed =
    halves.length === 0
      ? []
      : await tx.studentGroupMember.findMany({
          where: { studentGroupId: { in: halves.map((half) => half.id) }, student: { role: 'STUDENT', isActive: true } },
          select: { studentGroupId: true },
        });
  const held = new Set(placed.map((row) => row.studentGroupId));
  const empty = halves.filter((half) => !held.has(half.id));
  return {
    code: 'PUB_EMPTY_HALF',
    count: empty.length,
    entries: empty.map((half) => ({ label: `${half.name} (halva av ${half.className})` })),
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
