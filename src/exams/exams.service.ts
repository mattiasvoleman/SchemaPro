import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import { markedIds } from '../users/person-protections';
import { loadGroupFacts } from '../publication/activity-replacements';
import { asDay, clock, day } from '../publication/cancellation-core';
import { badExam, conflictingExam, EXAM_GROUPS, EXAM_IS_PLANNED, EXAM_REPLACEMENT_SUBJECT_COUNTS, EXAM_ROOM, EXAM_SUBJECT, EXAM_WINDOW, missingExam } from './exam-errors';
import { datesBetween, isCalendarDate } from './exam-plan';
import type { CreateExamDto, ExamDescriptionDto, ExamSettingsDto } from './dto/exam.dto';

/** The school's decisions, as a page reads them. */
export interface ExamSettingsView {
  enabled: boolean;
  maxPerClassPerDay: number;
  maxPerClassPerWeek: number;
  writersPerInvigilator: number;
  turnoverMinutes: number;
  replacementSubject: { id: string; name: string } | null;
}

export const DEFAULT_SETTINGS: Omit<ExamSettingsView, 'replacementSubject'> = {
  enabled: false,
  maxPerClassPerDay: 1,
  maxPerClassPerWeek: 3,
  writersPerInvigilator: 30,
  turnoverMinutes: 10,
};

export interface ExamRoomView {
  roomId: string;
  name: string;
  code: string | null;
  capacity: number | null;
  /** Null: not a skrivsal. */
  seats: number | null;
}

export interface ExamSittingView {
  roomId: string;
  roomName: string;
  writers: number;
  /** The invigilators the school may name; a teacher with a protected identity is on no list. */
  invigilators: Array<{ teacherId: string; name: string }>;
}

export interface ExamPlanView {
  activityId: string;
  date: string;
  start: string;
  end: string;
  sittings: ExamSittingView[];
}

export interface ExamView {
  id: string;
  academicYearId: string;
  subjectId: string;
  subjectName: string;
  name: string;
  lengthMinutes: number;
  writers: number;
  windowKind: 'WEEK' | 'FIXED';
  windowFrom: string;
  windowTo: string;
  fixedStart: string | null;
  earliestStart: string | null;
  latestEnd: string | null;
  groups: Array<{ id: string; name: string }>;
  /** The row's updatedAt: a proposal carries it back so that an exam changed since is not applied. */
  version: string;
  plan: ExamPlanView | null;
  /** Why the last run left it out, with the figures. */
  lastReason: { code: string; params: Record<string, string | number>; at: string } | null;
}

export interface InvigilatorCounterRow {
  teacherId: string;
  name: string;
  passes: number;
  minutes: number;
}

/** An exam row as the views and the planner read it. */
export const EXAM_SELECT = {
  id: true,
  academicYearId: true,
  subjectId: true,
  name: true,
  lengthMinutes: true,
  writers: true,
  windowKind: true,
  windowFrom: true,
  windowTo: true,
  fixedStart: true,
  earliestStart: true,
  latestEnd: true,
  activityId: true,
  lastReason: true,
  lastReasonParams: true,
  lastPlannedAt: true,
  updatedAt: true,
  groups: { select: { studentGroupId: true } },
  sittings: { select: { roomId: true, writers: true, bookingId: true, invigilators: { select: { teacherId: true } } } },
  activity: {
    select: {
      id: true,
      removedAt: true,
      batch: { select: { fromDate: true, startTime: true, endTime: true, reversedAt: true } },
    },
  },
} as const;

export type ExamRow = {
  id: string;
  academicYearId: string;
  subjectId: string;
  name: string;
  lengthMinutes: number;
  writers: number;
  windowKind: string;
  windowFrom: Date;
  windowTo: Date;
  fixedStart: Date | null;
  earliestStart: Date | null;
  latestEnd: Date | null;
  activityId: string | null;
  lastReason: string | null;
  lastReasonParams: unknown;
  lastPlannedAt: Date | null;
  updatedAt: Date;
  groups: Array<{ studentGroupId: string }>;
  sittings: Array<{ roomId: string; writers: number; bookingId: string | null; invigilators: Array<{ teacherId: string }> }>;
  activity: {
    id: string;
    removedAt: Date | null;
    batch: { fromDate: Date; startTime: Date | null; endTime: Date | null; reversedAt: Date | null };
  } | null;
};

/** The exam is laid: its activity stands, neither removed nor with its avbokning reversed. */
export function isPlanned(row: Pick<ExamRow, 'activity'>): boolean {
  return row.activity !== null && row.activity.removedAt === null && row.activity.batch.reversedAt === null;
}

/**
 * PROVPLANERING's records: the school's decisions, the rooms it lets exams be
 * written in, the exams themselves, and the counter of who has kept watch.
 * The planner that lays them is exam-planner.service.ts. Admin only, area
 * DRIFT (the controller): an exam is an activity, and an activity is Drift's.
 */
@Injectable()
export class ExamsService {
  private readonly logger = new Logger(ExamsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async settings(user: AuthenticatedUser): Promise<ExamSettingsView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, (tx) => readSettings(tx, schoolId));
  }

  async updateSettings(dto: ExamSettingsDto, user: AuthenticatedUser): Promise<ExamSettingsView> {
    const schoolId = requireSchoolId(user);
    if (dto.maxPerClassPerWeek < dto.maxPerClassPerDay) {
      throw badExam('EXAM_CAPS', 'maxPerClassPerWeek: en vecka rymmer minst lika många prov som en dag.');
    }
    return this.prisma.withRls(user, async (tx) => {
      if (dto.replacementSubjectId) {
        const subject = await tx.subject.findUnique({
          where: { id: dto.replacementSubjectId },
          select: { name: true, countsTowardTimplan: true },
        });
        if (!subject) throw badExam(EXAM_SUBJECT, 'replacementSubjectId: ämnet finns inte.');
        if (subject.countsTowardTimplan) {
          throw badExam(
            EXAM_REPLACEMENT_SUBJECT_COUNTS,
            `replacementSubjectId: ${subject.name} räknas mot timplanen, så provets minuter skulle räknas två gånger. Välj ett ämne som inte räknas, till exempel "Prov".`,
          );
        }
      }
      const data = {
        enabled: dto.enabled,
        maxPerClassPerDay: dto.maxPerClassPerDay,
        maxPerClassPerWeek: dto.maxPerClassPerWeek,
        writersPerInvigilator: dto.writersPerInvigilator,
        turnoverMinutes: dto.turnoverMinutes,
        replacementSubjectId: dto.replacementSubjectId ?? null,
        updatedAt: new Date(),
      };
      await tx.examPlanSettings.upsert({ where: { schoolId }, create: { schoolId, ...data }, update: data });
      return readSettings(tx, schoolId);
    });
  }

  /** Every room of the school, with the seats an exam has there when it is a skrivsal. */
  async rooms(user: AuthenticatedUser): Promise<ExamRoomView[]> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const [rooms, marks] = await Promise.all([
        tx.room.findMany({ select: { id: true, name: true, code: true, capacity: true } }),
        tx.examRoom.findMany({ select: { roomId: true, seats: true } }),
      ]);
      const seats = new Map(marks.map((mark) => [mark.roomId, mark.seats]));
      return rooms
        .map((room) => ({ roomId: room.id, name: room.name, code: room.code ?? null, capacity: room.capacity ?? null, seats: seats.get(room.id) ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name, 'sv') || a.roomId.localeCompare(b.roomId));
    });
  }

  async markRoom(roomId: string, seats: number, user: AuthenticatedUser): Promise<ExamRoomView[]> {
    const schoolId = requireSchoolId(user);
    await this.prisma.withRls(user, async (tx) => {
      const room = await tx.room.findUnique({ where: { id: roomId }, select: { id: true, name: true, capacity: true } });
      if (!room) throw badExam(EXAM_ROOM, 'Salen finns inte.');
      // A skrivsal seats at most what the room holds (fewer when the desks stand apart): the planner fills it to `seats`.
      if (typeof room.capacity === 'number' && seats > room.capacity) {
        throw badExam(EXAM_ROOM, `seats: ${room.name} rymmer ${room.capacity}, så ett prov kan ha högst så många platser där.`, { capacity: room.capacity });
      }
      await tx.examRoom.upsert({ where: { roomId }, create: { roomId, schoolId, seats }, update: { seats } });
    });
    return this.rooms(user);
  }

  async unmarkRoom(roomId: string, user: AuthenticatedUser): Promise<ExamRoomView[]> {
    requireSchoolId(user);
    await this.prisma.withRls(user, (tx) => tx.examRoom.deleteMany({ where: { roomId } }));
    return this.rooms(user);
  }

  async list(academicYearId: string, user: AuthenticatedUser): Promise<ExamView[]> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const rows = (await tx.exam.findMany({
        where: { academicYearId },
        orderBy: [{ windowFrom: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: EXAM_SELECT,
      })) as ExamRow[];
      return viewsOf(tx, schoolId, rows);
    });
  }

  async create(dto: CreateExamDto, user: AuthenticatedUser): Promise<ExamView> {
    const schoolId = requireSchoolId(user);
    const row = await this.prisma.withRls(user, async (tx) => {
      const data = await checkedExam(tx, dto.academicYearId, dto);
      const created = await tx.exam.create({
        data: {
          schoolId,
          academicYearId: dto.academicYearId,
          ...data.columns,
          createdByUserId: user.userId ?? null,
        },
        select: { id: true },
      });
      // Flat, not nested: a nested create drops the school from a composite key at run time.
      await tx.examGroup.createMany({ data: data.groupIds.map((studentGroupId) => ({ examId: created.id, studentGroupId, schoolId })) });
      return created.id;
    });
    this.logger.log(`Exam created [exam=${row}]`);
    return this.one(row, user);
  }

  async update(id: string, dto: ExamDescriptionDto, user: AuthenticatedUser): Promise<ExamView> {
    const schoolId = requireSchoolId(user);
    await this.prisma.withRls(user, async (tx) => {
      // Locked before it is read: a tillämpning that is writing the exam's plan at this moment finishes first,
      // and this then finds the exam laid. The one that comes after finds this change in the version.
      await lockExam(tx, id);
      const row = await readOne(tx, id);
      if (isPlanned(row)) {
        throw conflictingExam(EXAM_IS_PLANNED, 'Provet är lagt: ta bort planeringen först, ändra sedan provet.');
      }
      await clearLeftovers(tx, [row]);
      const data = await checkedExam(tx, row.academicYearId, dto);
      await tx.exam.update({
        where: { id },
        data: {
          ...data.columns,
          // What the last run said was about the exam as it was.
          lastReason: null,
          lastReasonParams: Prisma.DbNull,
          lastPlannedAt: null,
          updatedAt: new Date(),
        },
      });
      await tx.examGroup.deleteMany({ where: { examId: id } });
      await tx.examGroup.createMany({ data: data.groupIds.map((studentGroupId) => ({ examId: id, studentGroupId, schoolId })) });
    });
    return this.one(id, user);
  }

  async remove(id: string, user: AuthenticatedUser): Promise<{ removed: true }> {
    requireSchoolId(user);
    await this.prisma.withRls(user, async (tx) => {
      await lockExam(tx, id);
      const row = await readOne(tx, id);
      if (isPlanned(row)) {
        throw conflictingExam(EXAM_IS_PLANNED, 'Provet är lagt: ta bort planeringen först, ta sedan bort provet.');
      }
      await clearLeftovers(tx, [row]);
      await tx.exam.delete({ where: { id } });
    });
    return { removed: true };
  }

  /** How many passes and minutes of watch each teacher has this year, from the exams that stand. */
  async counter(academicYearId: string, user: AuthenticatedUser): Promise<InvigilatorCounterRow[]> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const held = await markedIds(tx, schoolId);
      const [teachers, minutes] = await Promise.all([
        tx.user.findMany({ where: { role: 'TEACHER', isActive: true }, select: { id: true, firstName: true, lastName: true } }),
        watchMinutes(tx, academicYearId),
      ]);
      return teachers
        .filter((teacher) => !held.has(teacher.id))
        .map((teacher) => ({
          teacherId: teacher.id,
          name: `${teacher.firstName} ${teacher.lastName}`,
          passes: minutes.get(teacher.id)?.passes ?? 0,
          minutes: minutes.get(teacher.id)?.minutes ?? 0,
        }))
        .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name, 'sv') || a.teacherId.localeCompare(b.teacherId));
    });
  }

  private one(id: string, user: AuthenticatedUser): Promise<ExamView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => (await viewsOf(tx, schoolId, [await readOne(tx, id)]))[0]);
  }
}

// ---------------------------------------------------------------------------

export async function readSettings(tx: PrismaClient, schoolId: string): Promise<ExamSettingsView> {
  const row = await tx.examPlanSettings.findUnique({ where: { schoolId } });
  if (!row) return { ...DEFAULT_SETTINGS, replacementSubject: null };
  const subject = row.replacementSubjectId
    ? await tx.subject.findUnique({ where: { id: row.replacementSubjectId }, select: { id: true, name: true } })
    : null;
  return {
    enabled: row.enabled,
    maxPerClassPerDay: row.maxPerClassPerDay,
    maxPerClassPerWeek: row.maxPerClassPerWeek,
    writersPerInvigilator: row.writersPerInvigilator,
    turnoverMinutes: row.turnoverMinutes,
    replacementSubject: subject,
  };
}

export async function readOne(tx: PrismaClient, id: string): Promise<ExamRow> {
  const row = (await tx.exam.findUnique({ where: { id }, select: EXAM_SELECT })) as ExamRow | null;
  if (!row) throw missingExam();
  return row;
}

/**
 * The exam's row, locked until the transaction ends. A change and a removal read
 * whether the exam is laid and write on what they read; without the lock the
 * answer can be out of date by the time they write.
 */
export async function lockExam(tx: PrismaClient, id: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Exams" WHERE "id" = ${id}::uuid FOR UPDATE`;
}

/**
 * The exam as it was read, for a write that must not land on a changed one. The
 * version is a timestamp the database holds to the microsecond and a Date holds to
 * the millisecond: the range is the whole millisecond, so that a value written
 * with more digits than JavaScript keeps is still the same version.
 */
export function versionIs(updatedAt: Date): { gte: Date; lt: Date } {
  return { gte: updatedAt, lt: new Date(updatedAt.getTime() + 1) };
}

const wall = (value: Date | null): string | null => clock(value);

/** The checks a description needs before it is written, and the columns it becomes. */
async function checkedExam(tx: PrismaClient, academicYearId: string, dto: ExamDescriptionDto) {
  for (const [field, value] of [['windowFrom', dto.windowFrom], ['windowTo', dto.windowTo]] as const) {
    if (!isCalendarDate(value)) throw badExam(EXAM_WINDOW, `${field}: en dag som finns i kalendern, YYYY-MM-DD.`);
  }
  const year = await tx.academicYear.findUnique({ where: { id: academicYearId }, select: { id: true, startDate: true, endDate: true } });
  if (!year) throw badExam(EXAM_WINDOW, 'academicYearId: läsåret finns inte.');
  const subject = await tx.subject.findUnique({ where: { id: dto.subjectId }, select: { name: true, countsTowardTimplan: true } });
  if (!subject) throw badExam(EXAM_SUBJECT, 'subjectId: ämnet finns inte.');
  if (!subject.countsTowardTimplan) {
    throw badExam(
      EXAM_SUBJECT,
      `subjectId: ${subject.name} räknas inte mot timplanen, så provets minuter når ingen elev. Välj provets ämne.`,
    );
  }
  const groupIds = [...new Set(dto.groupIds)];
  const groups = await loadGroupFacts(tx, academicYearId);
  const known = new Set(groups.map((group) => group.id));
  const unknown = groupIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw badExam(EXAM_GROUPS, 'groupIds: en klass eller grupp finns inte i läsåret.');
  }
  if (dto.windowTo < dto.windowFrom || datesBetween(dto.windowFrom, dto.windowTo).length > 31) {
    throw badExam(EXAM_WINDOW, 'windowTo: fönstret börjar före sitt slut och rymmer högst 31 dagar.');
  }
  if (dto.windowFrom < asDay(year.startDate) || dto.windowTo > asDay(year.endDate)) {
    throw badExam(EXAM_WINDOW, 'windowFrom: fönstret ligger inom läsåret.');
  }
  if (dto.windowKind === 'FIXED') {
    if (dto.windowFrom !== dto.windowTo || !dto.fixedStart || dto.earliestStart || dto.latestEnd) {
      throw badExam(EXAM_WINDOW, 'windowKind: ett fast prov har ett datum och en starttid, och inga dagliga gränser.');
    }
  } else if (dto.fixedStart) {
    throw badExam(EXAM_WINDOW, 'fixedStart: bara ett fast prov har en starttid.');
  }
  if (dto.earliestStart && dto.latestEnd && dto.earliestStart >= dto.latestEnd) {
    throw badExam(EXAM_WINDOW, 'latestEnd: de dagliga gränserna ligger i ordning.');
  }
  const time = (value: string | undefined) => (value ? new Date(`1970-01-01T${value}:00.000Z`) : null);
  return {
    groupIds,
    columns: {
      subjectId: dto.subjectId,
      name: dto.name.trim(),
      lengthMinutes: dto.lengthMinutes,
      writers: dto.writers,
      windowKind: dto.windowKind,
      windowFrom: day(dto.windowFrom),
      windowTo: day(dto.windowTo),
      fixedStart: time(dto.fixedStart),
      earliestStart: time(dto.earliestStart),
      latestEnd: time(dto.latestEnd),
    },
  };
}

/**
 * What a laid exam leaves when its activity is gone (removed on the activities
 * page, or its avbokning reversed): the room bookings are cancelled and the
 * sittings deleted with their invigilators, so that the rooms are free and the
 * exam reads as not laid. Idempotent; the planner and every change of an exam
 * run it first.
 */
export async function clearLeftovers(tx: PrismaClient, rows: ReadonlyArray<ExamRow>): Promise<void> {
  const dead = rows.filter((row) => !isPlanned(row) && (row.sittings.length > 0 || row.activityId !== null));
  if (dead.length === 0) return;
  const bookings = dead.flatMap((row) => row.sittings.map((sitting) => sitting.bookingId)).filter((id): id is string => id !== null);
  if (bookings.length > 0) {
    await tx.roomBooking.updateMany({ where: { id: { in: bookings }, status: { in: ['PENDING', 'APPROVED'] } }, data: { status: 'CANCELLED' } });
  }
  await tx.examSitting.deleteMany({ where: { examId: { in: dead.map((row) => row.id) } } });
  // The version is kept (updatedAt is given): what is cleared is not something the administrator changed, and a proposal
  // made from the exam as it was read must still be the exam's version when it is applied.
  for (const row of dead) {
    if (row.activityId !== null) {
      await tx.exam.updateMany({ where: { id: row.id, activityId: { not: null } }, data: { activityId: null, updatedAt: row.updatedAt } });
    }
  }
}

/** Minutes and passes of watch per teacher in a year, from the exams that stand. */
export async function watchMinutes(tx: PrismaClient, academicYearId: string): Promise<Map<string, { passes: number; minutes: number }>> {
  const rows = await tx.examInvigilator.findMany({
    where: { sitting: { is: { exam: { is: { academicYearId, activity: { is: { removedAt: null, batch: { is: { reversedAt: null } } } } } } } } },
    select: { teacherId: true, sitting: { select: { exam: { select: { lengthMinutes: true } } } } },
  });
  const out = new Map<string, { passes: number; minutes: number }>();
  for (const row of rows) {
    const entry = out.get(row.teacherId) ?? { passes: 0, minutes: 0 };
    entry.passes += 1;
    entry.minutes += row.sitting.exam.lengthMinutes;
    out.set(row.teacherId, entry);
  }
  return out;
}

/** The views of exam rows: names put to the ids, the plan read off the activity, protected teachers left out. */
export async function viewsOf(tx: PrismaClient, schoolId: string, rows: ReadonlyArray<ExamRow>): Promise<ExamView[]> {
  if (rows.length === 0) return [];
  const groupIds = [...new Set(rows.flatMap((row) => row.groups.map((group) => group.studentGroupId)))];
  const subjectIds = [...new Set(rows.map((row) => row.subjectId))];
  const roomIds = [...new Set(rows.flatMap((row) => row.sittings.map((sitting) => sitting.roomId)))];
  const teacherIds = [...new Set(rows.flatMap((row) => row.sittings.flatMap((sitting) => sitting.invigilators.map((one) => one.teacherId))))];
  const [groups, subjects, rooms, teachers] = await Promise.all([
    tx.studentGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true } }),
    tx.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } }),
    tx.room.findMany({ where: { id: { in: roomIds } }, select: { id: true, name: true } }),
    tx.user.findMany({ where: { id: { in: teacherIds } }, select: { id: true, firstName: true, lastName: true } }),
  ]);
  const marked = teacherIds.length > 0 ? await markedIds(tx, schoolId) : new Set<string>();
  const groupName = new Map(groups.map((group) => [group.id, group.name]));
  const subjectName = new Map(subjects.map((subject) => [subject.id, subject.name]));
  const roomName = new Map(rooms.map((room) => [room.id, room.name]));
  const teacherName = new Map(teachers.map((teacher) => [teacher.id, `${teacher.firstName} ${teacher.lastName}`]));
  return rows.map((row): ExamView => {
    const planned = isPlanned(row);
    const batch = row.activity?.batch;
    const plan: ExamPlanView | null =
      planned && batch && batch.startTime
        ? {
            activityId: row.activity!.id,
            date: asDay(batch.fromDate),
            start: wall(batch.startTime) ?? '',
            end: wall(batch.endTime) ?? '',
            sittings: row.sittings
              .map((sitting) => ({
                roomId: sitting.roomId,
                roomName: roomName.get(sitting.roomId) ?? '',
                writers: sitting.writers,
                invigilators: sitting.invigilators
                  .filter((one) => !marked.has(one.teacherId))
                  .map((one) => ({ teacherId: one.teacherId, name: teacherName.get(one.teacherId) ?? '' }))
                  .sort((a, b) => a.name.localeCompare(b.name, 'sv') || a.teacherId.localeCompare(b.teacherId)),
              }))
              .sort((a, b) => a.roomName.localeCompare(b.roomName, 'sv') || a.roomId.localeCompare(b.roomId)),
          }
        : null;
    const params = row.lastReasonParams && typeof row.lastReasonParams === 'object' ? (row.lastReasonParams as Record<string, string | number>) : {};
    return {
      id: row.id,
      academicYearId: row.academicYearId,
      subjectId: row.subjectId,
      subjectName: subjectName.get(row.subjectId) ?? '',
      name: row.name,
      lengthMinutes: row.lengthMinutes,
      writers: row.writers,
      windowKind: row.windowKind as 'WEEK' | 'FIXED',
      windowFrom: asDay(row.windowFrom),
      windowTo: asDay(row.windowTo),
      fixedStart: wall(row.fixedStart),
      earliestStart: wall(row.earliestStart),
      latestEnd: wall(row.latestEnd),
      groups: row.groups
        .filter((group) => groupName.has(group.studentGroupId))
        .map((group) => ({ id: group.studentGroupId, name: groupName.get(group.studentGroupId)! }))
        .sort((a, b) => a.name.localeCompare(b.name, 'sv') || a.id.localeCompare(b.id)),
      version: row.updatedAt.toISOString(),
      plan,
      lastReason: row.lastReason && !planned ? { code: row.lastReason, params, at: row.lastPlannedAt?.toISOString() ?? '' } : null,
    };
  });
}
