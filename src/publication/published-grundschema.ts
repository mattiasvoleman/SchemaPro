import type { LessonRecurrence, Prisma, PrismaClient } from '@prisma/client';
import { Role } from '../auth/enums/role.enum';
import { todayInZone } from '../common/utils/time';
import { effectiveSegments, type PublicationRange, type ValiditySegment } from './publication-validity';
import { publishModeOf } from './publish-mode';

/**
 * THE PUBLISHED GRUNDSCHEMA, for every reader that must not see a draft.
 *
 * In DIRECT the master lessons ARE what is published, and every reader reads
 * them as it always has. In DRAFT they are the admin's draft: RLS shows a
 * TEACHER, a pupil, a guardian and the SS12000 service none of them
 * (20261011100000), and the readers that answer about the grundschema itself —
 * the teacher's figure endpoints, the family statements, /activities — read
 * the snapshot the last publish took instead (PublishedLessons,
 * 20261011090000), in the shape of the master-lesson select they always made.
 */

/** A snapshot row in the master-lesson select's shape: a superset of every reader's select. */
export interface PublishedMaster {
  id: string;
  academicYearId: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string | null;
  dayOfWeek: number;
  startTime: Date;
  endTime: Date;
  recurrence: LessonRecurrence;
  startDate: Date | null;
  endDate: Date | null;
  isParked: boolean;
  isLocked: boolean;
  isGenerated: boolean;
  extraGroups: { studentGroupId: string }[];
  participants: { studentId: string }[];
  subject: { id: string; name: string };
  studentGroup: { id: string; name: string };
}

const asDay = (value: Date): string => value.toISOString().slice(0, 10);

/** The publications of a year that carry a snapshot, as validity ranges. */
export async function snapshotRanges(tx: PrismaClient, academicYearId: string): Promise<PublicationRange[]> {
  const rows = await tx.timetablePublication.findMany({
    where: { academicYearId, outcome: 'PUBLISHED', lessonCount: { not: null }, kind: { not: 'REFILL' } },
    orderBy: [{ publishedAt: 'asc' }, { id: 'asc' }],
    select: { id: true, publishedAt: true, validFrom: true, validTo: true },
  });
  return rows.map((row) => ({
    id: row.id,
    publishedAt: row.publishedAt,
    validFrom: asDay(row.validFrom),
    validTo: asDay(row.validTo),
  }));
}

/**
 * The snapshot a reader of "the grundschema" is shown: the one valid today,
 * else the nearest one ahead, else the last one before — a teacher looking at
 * next term's figures in June reads what has been published for it.
 */
export function snapshotFor(segments: readonly ValiditySegment[], today: string): string | null {
  const now = segments.find((segment) => segment.from <= today && today <= segment.to);
  if (now) return now.publicationId;
  const ahead = segments.find((segment) => segment.from > today);
  if (ahead) return ahead.publicationId;
  return segments.length > 0 ? segments[segments.length - 1]!.publicationId : null;
}

/**
 * A snapshot's rows in the master-lesson shape, with every reference that no
 * longer exists mapped the way the live foreign key would have acted in
 * DIRECT: a deleted subject or group drops the row (CASCADE), a deleted
 * teacher, co-teacher or room becomes null (SET NULL), and extra groups and
 * named pupils keep only those that still exist. Sorted by id, as every
 * reader orders its own read.
 */
export async function readPublishedMasters(tx: PrismaClient, publicationId: string): Promise<PublishedMaster[]> {
  const rows = await tx.publishedLesson.findMany({
    where: { publicationId },
    orderBy: { masterLessonId: 'asc' },
  });
  if (rows.length === 0) return [];
  const ids = (pick: (row: (typeof rows)[number]) => (string | null)[]) => [
    ...new Set(rows.flatMap(pick).filter((id): id is string => id !== null)),
  ];
  const subjects = new Map(
    (
      await tx.subject.findMany({ where: { id: { in: ids((row) => [row.subjectId]) } }, select: { id: true, name: true } })
    ).map((row) => [row.id, row]),
  );
  const groups = new Map(
    (
      await tx.studentGroup.findMany({
        where: { id: { in: ids((row) => [row.studentGroupId, ...row.extraGroupIds]) } },
        select: { id: true, name: true },
      })
    ).map((row) => [row.id, row]),
  );
  const rooms = new Set(
    (await tx.room.findMany({ where: { id: { in: ids((row) => [row.roomId]) } }, select: { id: true } })).map((row) => row.id),
  );
  const people = new Set(
    (
      await tx.user.findMany({
        where: { id: { in: ids((row) => [row.teacherId, row.coTeacherId, ...row.studentIds]) } },
        select: { id: true },
      })
    ).map((row) => row.id),
  );
  const out: PublishedMaster[] = [];
  for (const row of rows) {
    const subject = subjects.get(row.subjectId);
    const group = groups.get(row.studentGroupId);
    if (!subject || !group) continue;
    out.push({
      id: row.masterLessonId,
      academicYearId: row.academicYearId,
      subjectId: row.subjectId,
      studentGroupId: row.studentGroupId,
      teacherId: row.teacherId && people.has(row.teacherId) ? row.teacherId : null,
      coTeacherId: row.coTeacherId && people.has(row.coTeacherId) ? row.coTeacherId : null,
      roomId: row.roomId && rooms.has(row.roomId) ? row.roomId : null,
      dayOfWeek: row.dayOfWeek,
      startTime: row.startTime,
      endTime: row.endTime,
      recurrence: row.recurrence,
      startDate: row.startDate,
      endDate: row.endDate,
      isParked: row.isParked,
      isLocked: row.isLocked,
      isGenerated: row.isGenerated,
      extraGroups: row.extraGroupIds.filter((id) => groups.has(id)).sort().map((studentGroupId) => ({ studentGroupId })),
      participants: row.studentIds.filter((id) => people.has(id)).sort().map((studentId) => ({ studentId })),
      subject: { id: subject.id, name: subject.name },
      studentGroup: { id: group.id, name: group.name },
    });
  }
  return out;
}

/** Where a reader's grundschema came from: the masters, or a publication's snapshot. */
export type GrundschemaSource = { kind: 'LIVE' } | { kind: 'PUBLISHED'; publicationId: string | null };

export interface GrundschemaViewer {
  /** null for the SS12000 service principal. */
  role: Role | string | null;
  schoolId: string;
}

/**
 * The year's grundschema for a reader that must not see a draft.
 *
 * `live` is the reader's own master-lesson query, unchanged. For a
 * non-admin it runs FIRST: in DIRECT it returns the rows (RLS's predicate is
 * true) and nothing more is asked — the same statements as before. Only when
 * it finds nothing is the mode asked; in DRAFT the snapshot is read instead.
 * The admin reads the masters, the draft, except where `forFamilies` says the
 * answer goes to pupils and guardians (the stage statements), which read the
 * published grundschema whoever asks.
 */
export async function readGrundschema<T>(
  tx: PrismaClient,
  viewer: GrundschemaViewer,
  academicYearId: string,
  live: () => Promise<T[]>,
  options: { forFamilies?: boolean; timezone?: string } = {},
): Promise<{ rows: T[]; source: GrundschemaSource }> {
  const admin = viewer.role === Role.SCHOOL_ADMIN;
  if (admin && !options.forFamilies) return { rows: await live(), source: { kind: 'LIVE' } };
  if (!admin) {
    const rows = await live();
    if (rows.length > 0) return { rows, source: { kind: 'LIVE' } };
  }
  if ((await publishModeOf(tx, viewer.schoolId)) === 'DIRECT') {
    return { rows: admin ? await live() : [], source: { kind: 'LIVE' } };
  }
  const timezone =
    options.timezone ??
    (await tx.school.findUnique({ where: { id: viewer.schoolId }, select: { timezone: true } }))?.timezone ??
    'Europe/Stockholm';
  const today = asDay(todayInZone(timezone));
  const publicationId = snapshotFor(effectiveSegments(await snapshotRanges(tx, academicYearId)), today);
  const rows = publicationId === null ? [] : await readPublishedMasters(tx, publicationId);
  return { rows: rows as unknown as T[], source: { kind: 'PUBLISHED', publicationId } };
}

/** The fields a publish compares a master with its published row on (isParked is not one: parking moves nothing). */
export interface SlotFields {
  dayOfWeek: number;
  startTime: Date;
  endTime: Date;
  roomId: string | null;
  teacherId: string | null;
  recurrence: LessonRecurrence;
  startDate: Date | null;
  endDate: Date | null;
}

const time = (value: Date): string => value.toISOString().slice(11, 16);
const dayOrNull = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null);

export function slotChanged(before: SlotFields, after: SlotFields): boolean {
  return (
    before.dayOfWeek !== after.dayOfWeek ||
    time(before.startTime) !== time(after.startTime) ||
    time(before.endTime) !== time(after.endTime) ||
    before.roomId !== after.roomId ||
    before.teacherId !== after.teacherId ||
    before.recurrence !== after.recurrence ||
    dayOrNull(before.startDate) !== dayOrNull(after.startDate) ||
    dayOrNull(before.endDate) !== dayOrNull(after.endDate)
  );
}

/** Everything a snapshot holds, for "is the draft the published grundschema?". */
export function lessonDiffers(
  before: SlotFields & { coTeacherId: string | null; isParked: boolean; subjectId: string; studentGroupId: string; extraGroups: { studentGroupId: string }[]; participants: { studentId: string }[] },
  after: SlotFields & { coTeacherId: string | null; isParked: boolean; subjectId: string; studentGroupId: string; extraGroups: { studentGroupId: string }[]; participants: { studentId: string }[] },
): boolean {
  const ids = (list: { studentGroupId?: string; studentId?: string }[]) =>
    list.map((entry) => entry.studentGroupId ?? entry.studentId).sort().join(',');
  return (
    slotChanged(before, after) ||
    before.coTeacherId !== after.coTeacherId ||
    before.isParked !== after.isParked ||
    before.subjectId !== after.subjectId ||
    before.studentGroupId !== after.studentGroupId ||
    ids(before.extraGroups) !== ids(after.extraGroups) ||
    ids(before.participants) !== ids(after.participants)
  );
}

/** The year's masters in the PublishedMaster shape (the admin's draft). */
export function readDraftMasters(tx: PrismaClient, academicYearId: string): Promise<PublishedMaster[]> {
  return tx.masterLesson.findMany({
    where: { academicYearId },
    select: {
      id: true,
      academicYearId: true,
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
      isLocked: true,
      isGenerated: true,
      extraGroups: { select: { studentGroupId: true }, orderBy: { studentGroupId: 'asc' } },
      participants: { select: { studentId: true }, orderBy: { studentId: 'asc' } },
      subject: { select: { id: true, name: true } },
      studentGroup: { select: { id: true, name: true } },
    },
    orderBy: { id: 'asc' },
  });
}

/** Writes the masters as a publication's snapshot. */
export async function snapshotMasters(
  tx: PrismaClient,
  publication: { id: string; schoolId: string; academicYearId: string },
  masters: readonly PublishedMaster[],
): Promise<number> {
  if (masters.length === 0) return 0;
  const data: Prisma.PublishedLessonCreateManyInput[] = masters.map((master) => ({
    schoolId: publication.schoolId,
    publicationId: publication.id,
    academicYearId: publication.academicYearId,
    masterLessonId: master.id,
    subjectId: master.subjectId,
    studentGroupId: master.studentGroupId,
    teacherId: master.teacherId,
    coTeacherId: master.coTeacherId,
    roomId: master.roomId,
    dayOfWeek: master.dayOfWeek,
    startTime: master.startTime,
    endTime: master.endTime,
    isLocked: master.isLocked,
    isGenerated: master.isGenerated,
    isParked: master.isParked,
    recurrence: master.recurrence,
    startDate: master.startDate,
    endDate: master.endDate,
    extraGroupIds: master.extraGroups.map((entry) => entry.studentGroupId),
    studentIds: master.participants.map((entry) => entry.studentId),
  }));
  const { count } = await tx.publishedLesson.createMany({ data });
  return count;
}
