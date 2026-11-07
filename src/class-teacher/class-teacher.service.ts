import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId, requireUserId } from '../common/utils/request-context';
import { parseDateString, parseTimeString, toWallClock } from '../common/utils/time';
import { isoWeekday, iterateDates } from '../calendar/publish-days';
import { schoolTimezone } from '../cover/cover-context';
import { sqlStateOf } from '../cover/cover-errors';
import { localMinutes } from './dated-conflicts';
import {
  ClassTeacherEngine,
  askFrame,
  frameInputOf,
  lessonState,
  toChangeView,
  type ChangeRow,
  type FrameInput,
} from './class-teacher-engine';
import { appointerGone, frameRefusal, rethrowClassTeacherError, staleLesson } from './class-teacher-errors';
import {
  CODES,
  isOccasionKind,
  type ChangeKind,
  type ChangeView,
  type FrameReason,
  type PublishOutcome,
  type Verdict,
} from './class-teacher.types';
import type { ChangeTargetDto, CreateChangeDto, PreviewChangeDto, PublishDto, UpdateChangeDto, WeekQueryDto } from './dto/class-teacher.dto';

export interface MineView {
  classes: Array<{ id: string; name: string; academicYearId: string }>;
  /** Whether a klasslärare of this school publishes their own class's drafts. */
  selfPublish: boolean;
}

export interface OccasionView {
  id: string;
  date: string;
  start: string;
  end: string;
  status: string;
  subjectId: string;
  subjectName: string;
  className: string;
  roomId: string | null;
  /** The klasslärare teaches it; of a colleague's lesson nothing but "not yours" is said. */
  mine: boolean;
  version: string;
  refusal: FrameReason | null;
  draftId: string | null;
}

export interface TemplateLessonView {
  id: string;
  dayOfWeek: number;
  start: string;
  end: string;
  subjectId: string;
  subjectName: string;
  className: string;
  roomId: string | null;
  recurrence: string;
  mine: boolean;
  version: string;
  refusal: FrameReason | null;
  draftId: string | null;
}

export interface WeekView {
  classId: string;
  className: string;
  academicYearId: string;
  weekStart: string;
  days: string[];
  openTimes: Array<{ dayOfWeek: number; start: string; end: string }>;
  occasions: OccasionView[];
  template: TemplateLessonView[];
  drafts: ChangeView[];
  rooms: Array<{ id: string; name: string; refusal: FrameReason | null }>;
  selfPublish: boolean;
}

export interface PreviewView {
  verdict: Verdict;
}

const addDays = (date: string, days: number): string => {
  const moved = new Date(`${date}T00:00:00.000Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
};

/** The Monday of the week a date is in. */
export const mondayOf = (date: string): string => addDays(date, 1 - isoWeekday(date));

const clockOf = (instant: Date, timezone: string): string => {
  const minutes = localMinutes(instant, timezone);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};

/**
 * KLASSLÄRARENS SCHEMA, the klasslärare's side: their classes, a week of one
 * class with the frame's verdict on every lesson, and the drafts.
 *
 * WHO ACTS. The klasslärare's own claims read the calendar and the drafts and
 * write a draft (row security holds each to the class and the frame). What
 * needs the whole school's timetable, the check against clashes, and what
 * writes it, the publication, run as the administrator the appointment names
 * (app.class_teacher_actor), as the cover board places a vikarie as the
 * administrator who sent the request. The database says who that is, and only
 * to the klasslärare of the class.
 */
@Injectable()
export class ClassTeacherService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: ClassTeacherEngine,
  ) {}

  // ---------------------------------------------------------------------
  // Who and which
  // ---------------------------------------------------------------------

  async mine(user: AuthenticatedUser): Promise<MineView> {
    const me = requireUserId(user);
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const appointments = await tx.classTeacherAppointment.findMany({ where: { userId: me }, select: { studentGroupId: true } });
      const groups = await tx.studentGroup.findMany({
        where: { id: { in: appointments.map((row) => row.studentGroupId) } },
        select: { id: true, name: true, academicYearId: true },
        orderBy: { name: 'asc' },
      });
      const settings = await tx.classTeacherSettings.findUnique({ where: { schoolId } });
      return { classes: groups, selfPublish: settings?.selfPublish ?? false };
    });
  }

  /** The principal the klasslärare's checks and publication run as; 403 and 409 as the database says. */
  async actorOf(user: AuthenticatedUser, classId: string): Promise<AuthenticatedUser> {
    const schoolId = requireSchoolId(user);
    const rows = await this.prisma
      .withRls(user, (tx) =>
        tx.$queryRaw<{ userId: string; authId: string; adminProfile: AuthenticatedUser['adminProfile'] | null; hrRead: boolean }[]>(
          Prisma.sql`SELECT "userId", "authId", "adminProfile", "hrRead" FROM app.class_teacher_actor(${classId}::uuid)`,
        ),
      )
      .catch((error: unknown) => {
        const state = sqlStateOf(error);
        if (state === 'CT403') throw frameRefusal('NOT_APPOINTED');
        if (state === 'CT422') throw appointerGone();
        throw error;
      });
    const row = rows[0];
    if (!row) throw appointerGone();
    return {
      authId: row.authId,
      role: Role.SCHOOL_ADMIN,
      userId: row.userId,
      schoolId,
      ...(row.adminProfile ? { adminProfile: row.adminProfile, hrRead: row.hrRead } : {}),
      ...(user.closedSchools ? { closedSchools: user.closedSchools } : {}),
      ...(user.channel ? { channel: user.channel } : {}),
    };
  }

  private async requireAppointed(tx: PrismaClient, user: AuthenticatedUser, classId: string): Promise<void> {
    const row = await tx.classTeacherAppointment.findFirst({
      where: { studentGroupId: classId, userId: requireUserId(user) },
      select: { id: true },
    });
    if (!row) throw frameRefusal('NOT_APPOINTED');
  }

  // ---------------------------------------------------------------------
  // A week
  // ---------------------------------------------------------------------

  async week(classId: string, query: WeekQueryDto, user: AuthenticatedUser): Promise<WeekView> {
    const me = requireUserId(user);
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      await this.requireAppointed(tx, user, classId);
      const timezone = await schoolTimezone(tx, schoolId);
      const group = await tx.studentGroup.findUnique({ where: { id: classId }, select: { id: true, name: true, academicYearId: true } });
      if (!group) throw frameRefusal('LESSON_GONE');
      const today = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
      const weekStart = mondayOf(query.from ?? today);
      const days = [...iterateDates(weekStart, addDays(weekStart, 4))];

      const [settings, openRows, drafts, rooms, masters, states] = await Promise.all([
        tx.classTeacherSettings.findUnique({ where: { schoolId } }),
        tx.classTeacherOpenTime.findMany({
          where: { academicYearId: group.academicYearId, OR: [{ studentGroupId: null }, { studentGroupId: classId }] },
          orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
        }),
        tx.classTeacherChange.findMany({ where: { studentGroupId: classId, status: 'DRAFT' }, orderBy: { createdAt: 'asc' } }),
        tx.$queryRaw<{ id: string; name: string; refusal: FrameReason | null }[]>(
          Prisma.sql`SELECT r."id", r."name", app.class_teacher_room_refusal(r."id") AS "refusal" FROM "Rooms" r ORDER BY r."name"`,
        ),
        tx.$queryRaw<
          Array<{
            id: string;
            studentGroupId: string;
            subjectId: string;
            dayOfWeek: number;
            startTime: Date;
            endTime: Date;
            roomId: string | null;
            teacherId: string | null;
            recurrence: string;
            version: string;
            refusal: FrameReason | null;
          }>
        >(Prisma.sql`SELECT * FROM app.class_teacher_master_lessons(${classId}::uuid)`),
        tx.$queryRaw<{ calendarLessonId: string; version: string; refusal: FrameReason | null }[]>(
          Prisma.sql`SELECT * FROM app.class_teacher_calendar_states(${classId}::uuid, ${days[0]}::date, ${days[4]}::date)`,
        ),
      ]);

      const lessons = await tx.calendarLesson.findMany({
        where: { id: { in: states.map((row) => row.calendarLessonId) } },
        select: {
          id: true,
          date: true,
          startsAt: true,
          endsAt: true,
          status: true,
          roomId: true,
          subjectId: true,
          subject: { select: { name: true } },
          studentGroup: { select: { name: true } },
          teachers: { select: { teacherId: true } },
        },
        orderBy: [{ startsAt: 'asc' }],
      });
      const stateOf = new Map(states.map((row) => [row.calendarLessonId, row]));
      const draftOf = new Map<string, string>();
      for (const draft of drafts) {
        if (draft.calendarLessonId) draftOf.set(draft.calendarLessonId, draft.id);
        if (draft.masterLessonId) draftOf.set(draft.masterLessonId, draft.id);
      }
      const subjects = await tx.subject.findMany({
        where: { id: { in: masters.map((row) => row.subjectId) } },
        select: { id: true, name: true },
      });
      const subjectName = new Map(subjects.map((row) => [row.id, row.name]));
      const groups = await tx.studentGroup.findMany({
        where: { id: { in: masters.map((row) => row.studentGroupId) } },
        select: { id: true, name: true },
      });
      const groupName = new Map(groups.map((row) => [row.id, row.name]));

      return {
        classId,
        className: group.name,
        academicYearId: group.academicYearId,
        weekStart,
        days,
        openTimes: openRows.map((row) => ({ dayOfWeek: row.dayOfWeek, start: toWallClock(row.startTime), end: toWallClock(row.endTime) })),
        occasions: lessons.map((lesson) => {
          const state = stateOf.get(lesson.id)!;
          return {
            id: lesson.id,
            date: lesson.date.toISOString().slice(0, 10),
            start: clockOf(lesson.startsAt, timezone),
            end: clockOf(lesson.endsAt, timezone),
            status: lesson.status,
            subjectId: lesson.subjectId,
            subjectName: lesson.subject.name,
            className: lesson.studentGroup.name,
            roomId: lesson.roomId,
            mine: lesson.teachers.some((row) => row.teacherId === me),
            version: state.version,
            refusal: state.refusal,
            draftId: draftOf.get(lesson.id) ?? null,
          };
        }),
        template: masters.map((lesson) => ({
          id: lesson.id,
          dayOfWeek: lesson.dayOfWeek,
          start: toWallClock(lesson.startTime),
          end: toWallClock(lesson.endTime),
          subjectId: lesson.subjectId,
          subjectName: subjectName.get(lesson.subjectId) ?? '',
          className: groupName.get(lesson.studentGroupId) ?? '',
          roomId: lesson.roomId,
          recurrence: lesson.recurrence,
          mine: lesson.teacherId === me,
          version: lesson.version,
          refusal: lesson.refusal,
          draftId: draftOf.get(lesson.id) ?? null,
        })),
        drafts: drafts.map(toChangeView),
        rooms,
        selfPublish: settings?.selfPublish ?? false,
      };
    });
  }

  // ---------------------------------------------------------------------
  // The drafts
  // ---------------------------------------------------------------------

  /** A new draft. The frame is asked first, to name the reason; the database asks it again as row security. */
  async create(classId: string, dto: CreateChangeDto, user: AuthenticatedUser): Promise<ChangeView> {
    const me = requireUserId(user);
    const schoolId = requireSchoolId(user);
    assertShape(dto.kind, dto, true);
    try {
      const created = await this.prisma.withRls(user, async (tx) => {
        await this.requireAppointed(tx, user, classId);
        const group = await tx.studentGroup.findUnique({ where: { id: classId }, select: { academicYearId: true } });
        if (!group) throw frameRefusal('LESSON_GONE');
        const input: FrameInput = {
          teacherId: me,
          studentGroupId: classId,
          kind: dto.kind,
          masterLessonId: dto.masterLessonId ?? null,
          calendarLessonId: dto.calendarLessonId ?? null,
          targetDate: dto.targetDate ?? null,
          targetDayOfWeek: dto.targetDayOfWeek ?? null,
          targetStart: dto.targetStart ?? null,
          targetEnd: dto.targetEnd ?? null,
          targetRoomId: dto.targetRoomId ?? null,
          keepEnd: dto.keepEnd ?? null,
        };
        const refusal = await askFrame(tx, input, true);
        if (refusal) throw frameRefusal(refusal);
        const occasion = isOccasionKind(dto.kind);
        const lessonId = (occasion ? dto.calendarLessonId : dto.masterLessonId)!;
        const state = await lessonState(tx, occasion ? 'calendar' : 'master', lessonId);
        if (!state) throw frameRefusal('LESSON_GONE');
        if (state.version !== dto.baseVersion) throw staleLesson({ current: state });
        return tx.classTeacherChange.create({
          data: {
            schoolId,
            academicYearId: group.academicYearId,
            studentGroupId: classId,
            authorId: me,
            kind: dto.kind,
            masterLessonId: dto.masterLessonId ?? null,
            calendarLessonId: dto.calendarLessonId ?? null,
            targetDate: dto.targetDate ? parseDateString(dto.targetDate) : null,
            targetDayOfWeek: dto.targetDayOfWeek ?? null,
            targetStart: dto.targetStart ? parseTimeString(dto.targetStart) : null,
            targetEnd: dto.targetEnd ? parseTimeString(dto.targetEnd) : null,
            targetRoomId: dto.targetRoomId ?? null,
            keepEnd: dto.keepEnd ? parseTimeString(dto.keepEnd) : null,
            note: dto.note ?? null,
            baseVersion: dto.baseVersion,
            baseSnapshot: {},
          },
        });
      });
      return toChangeView(created);
    } catch (error) {
      if (sqlStateOf(error) === '23505' || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
        const existing = await this.prisma.withRls(user, (tx) =>
          tx.classTeacherChange.findFirst({
            where: {
              studentGroupId: classId,
              status: 'DRAFT',
              ...(dto.calendarLessonId ? { calendarLessonId: dto.calendarLessonId } : { masterLessonId: dto.masterLessonId }),
            },
          }),
        );
        throw new ConflictException({
          message: 'Det finns redan ett utkast för lektionen. Öppna det i stället.',
          code: CODES.DRAFT_EXISTS,
          ...(existing ? { existing: toChangeView(existing) } : {}),
        });
      }
      return rethrowClassTeacherError(error);
    }
  }

  /** Edits a waiting draft the writer has read at `dto.rev`; anyone else's change in between is a 409 with the draft as it stands. */
  async update(classId: string, changeId: string, dto: UpdateChangeDto, user: AuthenticatedUser): Promise<ChangeView> {
    try {
      const outcome = await this.prisma.withRls(user, async (tx) => {
        await this.requireAppointed(tx, user, classId);
        const current = await tx.classTeacherChange.findFirst({ where: { id: changeId, studentGroupId: classId } });
        if (!current) throw new NotFoundException({ message: 'Utkastet finns inte.', code: CODES.GONE });
        if (current.status !== 'DRAFT' || current.rev !== dto.rev) return { conflict: toChangeView(current) } as const;
        const merged = { ...current, ...mergedOf(dto) } as unknown as ChangeRow;
        const refusal = await askFrame(tx, frameInputOf(merged), false);
        if (refusal) throw frameRefusal(refusal);
        const written = await tx.classTeacherChange.updateMany({
          where: { id: changeId, rev: dto.rev, status: 'DRAFT' },
          data: patchOf(dto),
        });
        const after = await tx.classTeacherChange.findUnique({ where: { id: changeId } });
        if (written.count === 0 || !after) return { conflict: after ? toChangeView(after) : toChangeView(current) } as const;
        return { done: toChangeView(after) } as const;
      });
      if ('conflict' in outcome) {
        throw new ConflictException({
          message: 'Utkastet har ändrats av någon annan. Läs om det och försök igen.',
          code: CODES.REV,
          current: outcome.conflict,
        });
      }
      return outcome.done;
    } catch (error) {
      return rethrowClassTeacherError(error);
    }
  }

  async discard(classId: string, changeId: string, rev: number, user: AuthenticatedUser): Promise<void> {
    try {
      const conflict = await this.prisma.withRls(user, async (tx) => {
        await this.requireAppointed(tx, user, classId);
        const removed = await tx.classTeacherChange.deleteMany({ where: { id: changeId, studentGroupId: classId, rev, status: 'DRAFT' } });
        if (removed.count === 1) return null;
        const current = await tx.classTeacherChange.findFirst({ where: { id: changeId, studentGroupId: classId } });
        if (!current) throw new NotFoundException({ message: 'Utkastet finns inte.', code: CODES.GONE });
        return toChangeView(current);
      });
      if (conflict) {
        throw new ConflictException({
          message: 'Utkastet har ändrats av någon annan. Läs om det och försök igen.',
          code: CODES.REV,
          current: conflict,
        });
      }
    } catch (error) {
      return rethrowClassTeacherError(error);
    }
  }

  // ---------------------------------------------------------------------
  // The live check, and publication
  // ---------------------------------------------------------------------

  /** Every waiting draft of the class, judged as publication would judge it. */
  async check(classId: string, user: AuthenticatedUser): Promise<Array<{ change: ChangeView; verdict: Verdict }>> {
    try {
      const actor = await this.actorOf(user, classId);
      return await this.prisma.withRls(actor, async (tx) => {
        const drafts = await tx.classTeacherChange.findMany({ where: { studentGroupId: classId, status: 'DRAFT' }, orderBy: { createdAt: 'asc' } });
        const out: Array<{ change: ChangeView; verdict: Verdict }> = [];
        for (const draft of drafts) out.push({ change: toChangeView(draft), verdict: await this.engine.evaluate(tx, draft) });
        return out;
      });
    } catch (error) {
      return rethrowClassTeacherError(error);
    }
  }

  /** A change tried and not written: the frame, then the clashes, as the editor would say them while the klasslärare drags. */
  async preview(classId: string, dto: PreviewChangeDto, user: AuthenticatedUser): Promise<PreviewView> {
    const me = requireUserId(user);
    const schoolId = requireSchoolId(user);
    assertShape(dto.kind, dto, false);
    try {
      const actor = await this.actorOf(user, classId);
      const verdict = await this.prisma.withRls(actor, async (tx) => {
        const occasion = isOccasionKind(dto.kind);
        const lessonId = (occasion ? dto.calendarLessonId : dto.masterLessonId)!;
        const state = await lessonState(tx, occasion ? 'calendar' : 'master', lessonId);
        if (!state) return { state: 'GONE' } as Verdict;
        const group = await tx.studentGroup.findUnique({ where: { id: classId }, select: { academicYearId: true } });
        const now = new Date();
        const draft = {
          id: '00000000-0000-4000-8000-000000000000',
          schoolId,
          academicYearId: group?.academicYearId ?? '',
          studentGroupId: classId,
          authorId: me,
          kind: dto.kind,
          status: 'DRAFT',
          masterLessonId: dto.masterLessonId ?? null,
          calendarLessonId: dto.calendarLessonId ?? null,
          date: null,
          targetDate: dto.targetDate ? parseDateString(dto.targetDate) : null,
          targetDayOfWeek: dto.targetDayOfWeek ?? null,
          targetStart: dto.targetStart ? parseTimeString(dto.targetStart) : null,
          targetEnd: dto.targetEnd ? parseTimeString(dto.targetEnd) : null,
          targetRoomId: dto.targetRoomId ?? null,
          keepEnd: dto.keepEnd ? parseTimeString(dto.keepEnd) : null,
          note: dto.note ?? null,
          baseVersion: state.version,
          baseSnapshot: state.snapshot as Prisma.JsonValue,
          rev: 1,
          publishedAt: null,
          publishedByUserId: null,
          createdAt: now,
          updatedAt: now,
        } as ChangeRow;
        return this.engine.evaluate(tx, draft, { creating: true });
      });
      return { verdict };
    } catch (error) {
      return rethrowClassTeacherError(error);
    }
  }

  /** The klasslärare publishes their own class, when the school lets them (ClassTeacherSettings.selfPublish). */
  async publish(classId: string, dto: PublishDto, user: AuthenticatedUser): Promise<{ outcomes: PublishOutcome[] }> {
    const schoolId = requireSchoolId(user);
    try {
      const allowed = await this.prisma.withRls(user, async (tx) => {
        await this.requireAppointed(tx, user, classId);
        const settings = await tx.classTeacherSettings.findUnique({ where: { schoolId } });
        return settings?.selfPublish === true;
      });
      if (!allowed) {
        throw new ForbiddenException({
          message: 'Skolan har inte låtit klasslärare publicera. Schemaläggaren publicerar dina utkast.',
          code: CODES.PUBLISH_OFF,
        });
      }
      const actor = await this.actorOf(user, classId);
      return { outcomes: await this.engine.publishClass(actor, classId, dto.changeIds) };
    } catch (error) {
      return rethrowClassTeacherError(error);
    }
  }
}

/** The same patch as plain values, to ask the frame about the draft as it would stand. */
function mergedOf(dto: ChangeTargetDto): Partial<ChangeRow> {
  return {
    ...(dto.targetDate !== undefined ? { targetDate: parseDateString(dto.targetDate) } : {}),
    ...(dto.targetDayOfWeek !== undefined ? { targetDayOfWeek: dto.targetDayOfWeek } : {}),
    ...(dto.targetStart !== undefined ? { targetStart: parseTimeString(dto.targetStart) } : {}),
    ...(dto.targetEnd !== undefined ? { targetEnd: parseTimeString(dto.targetEnd) } : {}),
    ...(dto.targetRoomId !== undefined ? { targetRoomId: dto.targetRoomId } : {}),
    ...(dto.keepEnd !== undefined ? { keepEnd: parseTimeString(dto.keepEnd) } : {}),
    ...(dto.note !== undefined ? { note: dto.note } : {}),
  };
}

/** The columns a patch sets, as the client stated them: `undefined` leaves a column, `null` clears the room. */
function patchOf(dto: ChangeTargetDto): Prisma.ClassTeacherChangeUncheckedUpdateManyInput {
  return {
    ...(dto.targetDate !== undefined ? { targetDate: parseDateString(dto.targetDate) } : {}),
    ...(dto.targetDayOfWeek !== undefined ? { targetDayOfWeek: dto.targetDayOfWeek } : {}),
    ...(dto.targetStart !== undefined ? { targetStart: parseTimeString(dto.targetStart) } : {}),
    ...(dto.targetEnd !== undefined ? { targetEnd: parseTimeString(dto.targetEnd) } : {}),
    ...(dto.targetRoomId !== undefined ? { targetRoomId: dto.targetRoomId } : {}),
    ...(dto.keepEnd !== undefined ? { keepEnd: parseTimeString(dto.keepEnd) } : {}),
    ...(dto.note !== undefined ? { note: dto.note } : {}),
  };
}

/** The fields each kind uses and none of the others'; the database's CHECK says the same, this says it first and in words. */
export function assertShape(
  kind: ChangeKind,
  dto: ChangeTargetDto & { masterLessonId?: string; calendarLessonId?: string },
  needsVersion: boolean,
): void {
  const occasion = isOccasionKind(kind);
  if (occasion && (!dto.calendarLessonId || dto.masterLessonId)) {
    throw new BadRequestException({ message: 'Ett undantag pekar på en lektion ett visst datum.', code: 'CLASS_TEACHER_INVALID' });
  }
  if (!occasion && (!dto.masterLessonId || dto.calendarLessonId)) {
    throw new BadRequestException({ message: 'En ändring av mallen pekar på en lektion i klassens schema.', code: 'CLASS_TEACHER_INVALID' });
  }
  const has = (value: unknown): boolean => value !== undefined && value !== null;
  const wrong = (message: string): never => {
    throw new BadRequestException({ message, code: 'CLASS_TEACHER_INVALID' });
  };
  switch (kind) {
    case 'OCCASION_MOVE':
      if (!has(dto.targetDate) || !has(dto.targetStart) || !has(dto.targetEnd)) wrong('Flytten anger dag och tid.');
      if (has(dto.targetDayOfWeek) || has(dto.keepEnd)) wrong('Flytten för ett datum anger inte veckodag eller delning.');
      break;
    case 'OCCASION_CANCEL':
      if (has(dto.targetDate) || has(dto.targetStart) || has(dto.targetEnd) || has(dto.targetRoomId) || has(dto.targetDayOfWeek) || has(dto.keepEnd)) {
        wrong('Att ställa in en lektion anger ingen ny tid eller sal.');
      }
      break;
    case 'OCCASION_ROOM':
      if (!has(dto.targetRoomId)) wrong('Salbytet anger salen.');
      if (has(dto.targetDate) || has(dto.targetStart) || has(dto.targetEnd) || has(dto.targetDayOfWeek) || has(dto.keepEnd)) {
        wrong('Salbytet för ett datum anger ingen ny tid.');
      }
      break;
    case 'TEMPLATE_MOVE':
      if (!has(dto.targetDayOfWeek) || !has(dto.targetStart) || !has(dto.targetEnd)) wrong('Ändringen anger veckodag och tid.');
      if (has(dto.targetDate) || has(dto.keepEnd)) wrong('Att flytta en lektion i mallen anger varken datum eller delning.');
      break;
    case 'TEMPLATE_SPLIT':
      if (!has(dto.targetDayOfWeek) || !has(dto.targetStart) || !has(dto.targetEnd) || !has(dto.keepEnd)) {
        wrong('Delningen anger var första delen slutar och var den andra ligger.');
      }
      if (has(dto.targetDate)) wrong('Delningen av mallen anger inget datum.');
      break;
  }
  if (needsVersion && !(dto as { baseVersion?: string }).baseVersion) wrong('Utkastet anger vilken version av lektionen det bygger på.');
}
