import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { profileWrites } from '../auth/admin-areas';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { calendarLessonRosters } from '../calendar/lesson-roster';
import { requireSchoolId, requireUserId } from '../common/utils/request-context';
import { asDay, dayDate, schoolTimezone, shiftDay } from '../cover/cover-context';
import { PrismaService } from '../database/prisma.service';
import { isRealDay, schoolClock } from '../family/family-schedule.service';
import {
  HOMEWORK_MAX,
  NOTE_MAX,
  TOPIC_MAX,
  type LessonLogRangeQueryDto,
  type PutLessonLogDto,
  type PutSubstituteNoteDto,
} from './dto/lesson-log.dto';

/**
 * LEKTIONSLOGG (20261203090000): a lesson's topic and homework, which the
 * pupils on it and their guardians see, and a note to its substitute, which
 * only the lesson's teachers see.
 *
 * Who may do what is the database's: app.lesson_teacher_role(lesson) says
 * whether the calling teacher is the lesson's own (REGULAR), only its
 * substitute (SUBSTITUTE) or neither, and the write arms ask the same
 * function. This service asks it first only to answer a 403 that says why,
 * and to tell the page which fields it may edit.
 *
 *   the lesson's own teacher  writes the log and the note, reads both
 *   its substitute            writes the log (they taught it), reads the note
 *   another teacher           reads the log (the klassbok is everyone's)
 *   an administrator          reads the log, and writes it when the profile
 *                             writes DRIFT (rektor removing what should not
 *                             stand), as the RolesGuard has already held;
 *                             never the note, which the database gives no
 *                             administrator (they learn that one exists,
 *                             substitute-noted.ts)
 *   a pupil, a guardian       the log of their own lessons, never the note
 *                             (the family's week, family-schedule.service.ts,
 *                             and listForCaller here)
 *
 * Nothing here is written to the läslogg. A log is the teacher's text about a
 * lesson, written for the class, and names nobody in its fields; a note is a
 * colleague's free text to a colleague, which may mention a pupil but has no
 * field that says whom, so no subject to record against — who may read it
 * at all is what bounds it. The family's read of the log is part of the
 * family's week, which is recorded (SCHEDULE) where it is read. See
 * src/access-log/access-log.ts, NOT RECORDED.
 *
 * Nobody is told that a log or a note was written, and nothing can be
 * answered: messages between school and home stay in the lärplattform.
 */

export type LessonTeacherRole = 'REGULAR' | 'SUBSTITUTE';
/** How the caller stands to the lesson, as the page needs it. */
export type LessonCallerRole = LessonTeacherRole | 'COLLEAGUE' | 'ADMIN';

export interface LessonLogText {
  topic: string | null;
  homework: string | null;
  /** The name of whoever wrote it last; null when that person is gone. */
  writtenBy: string | null;
  updatedAt: string;
}

export interface SubstituteNoteText {
  body: string;
  writtenBy: string | null;
  updatedAt: string;
}

export interface LessonLogLessonView {
  lesson: {
    id: string;
    date: string;
    start: string;
    end: string;
    status: string;
    subject: string;
    subjectColor: string | null;
    /** The lesson's own group first, then the groups joined to it. */
    groups: string[];
    room: string | null;
    teachers: { name: string; role: string }[];
  };
  role: LessonCallerRole;
  may: { writeLog: boolean; readNote: boolean; writeNote: boolean };
  log: LessonLogText | null;
  /** Null when there is none, and when the caller may not read it (may.readNote). */
  note: SubstituteNoteText | null;
}

export interface LessonLogEntry {
  lessonId: string;
  topic: string | null;
  homework: string | null;
  /** A teacher's own lessons only: the note to the substitute, null when there is none. Absent for a pupil. */
  substituteNote?: string | null;
}

/**
 * A lesson the caller handed over: a cover decision on it was made for the
 * caller's absence, which removed the caller from it. Read from the caller's
 * own TeacherAbsenceCovers, so the absent teacher can still reach the lesson
 * to leave or correct the note. No substitute and no reason in it.
 */
export interface HandedOverLesson {
  lessonId: string;
  date: string;
  startsAt: string;
  endsAt: string;
  subjectId: string;
  studentGroupId: string;
  roomId: string | null;
  status: string;
  decision: string;
  /** Whether the caller has left the substitute a note. */
  noted: boolean;
}

export const LESSON_NOT_FOUND = 'LESSON_NOT_FOUND';
export const LESSON_LOG_NOT_YOURS = 'LESSON_LOG_NOT_YOURS';
export const SUBSTITUTE_NOTE_NOT_YOURS = 'SUBSTITUTE_NOTE_NOT_YOURS';
export const LESSON_LOG_STALE = 'LESSON_LOG_STALE';
export const SUBSTITUTE_NOTE_STALE = 'SUBSTITUTE_NOTE_STALE';
export const LESSON_LOG_TOPIC_ONE_LINE = 'LESSON_LOG_TOPIC_ONE_LINE';
export const LESSON_LOG_TOO_LONG = 'LESSON_LOG_TOO_LONG';
export const LESSON_LOG_RANGE = 'LESSON_LOG_RANGE';

/** The longest range a caller lists at once: six weeks, past "Mina vikariepass"'s four. */
export const RANGE_MAX_DAYS = 42;

const lessonNotFound = () => new NotFoundException({ message: 'Lektionen finns inte.', code: LESSON_NOT_FOUND });

/** Trimmed, and null for nothing: what the CHECKs take. */
function text(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.replace(/\r\n?/g, '\n').replace(/^[ \t\n]+|[ \t\n]+$/g, '');
  return trimmed === '' ? null : trimmed;
}

function tooLong(field: string, max: number): BadRequestException {
  return new BadRequestException({ message: `${field}: högst ${max} tecken.`, code: LESSON_LOG_TOO_LONG, params: { field, max } });
}

export const LESSON_LOG_BASIS = 'LESSON_LOG_BASIS';

/**
 * The basis as an instant to compare, null for "there was none", undefined
 * for "check nothing". One the DTO let through and Date cannot read is a
 * 400, never a RangeError's 500.
 */
function basisOf(basis: string | null | undefined): string | null | undefined {
  if (basis === undefined || basis === null) return basis;
  const parsed = Date.parse(basis);
  if (Number.isNaN(parsed)) {
    throw new BadRequestException({ message: 'basis: när texten ändrades senast, eller null.', code: LESSON_LOG_BASIS });
  }
  return new Date(parsed).toISOString();
}

/** Characters, as char_length counts them: a code point each. */
const length = (value: string): number => [...value].length;

/** A range of real days, from ≤ to, at most `max` days; the field named when not. */
export function assertRange(from: string, to: string, max: number, code: string): void {
  if (!isRealDay(from)) throw new BadRequestException({ message: 'from: ett datum som finns, ÅÅÅÅ-MM-DD.', code });
  if (!isRealDay(to)) throw new BadRequestException({ message: 'to: ett datum som finns, ÅÅÅÅ-MM-DD.', code });
  if (to < from) throw new BadRequestException({ message: 'to: inte före from.', code });
  if (shiftDay(from, max - 1) < to) {
    throw new BadRequestException({ message: `Högst ${max} dagar åt gången.`, code, params: { max } });
  }
}

const nameOf = (user: { firstName: string; lastName: string } | null | undefined): string | null =>
  user ? `${user.firstName} ${user.lastName}`.trim() : null;

const LESSON_SELECT = {
  id: true,
  date: true,
  startsAt: true,
  endsAt: true,
  status: true,
  subject: { select: { name: true, color: true } },
  studentGroup: { select: { name: true } },
  extraGroups: { select: { studentGroup: { select: { name: true } } } },
  room: { select: { name: true } },
  teachers: {
    select: { role: true, teacher: { select: { firstName: true, lastName: true } } },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
  },
} satisfies Prisma.CalendarLessonSelect;

const WRITER = { select: { firstName: true, lastName: true } } as const;

/** One writer of a lesson's log, and of its note, at a time: the basis check and the write are then one step. */
async function lockLessonText(tx: PrismaClient, kind: 'log' | 'note', lessonId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`LessonLog:${kind}:${lessonId}`}, 0))`);
}

@Injectable()
export class LessonLogService {
  constructor(private readonly prisma: PrismaService) {}

  /** The caller's standing on a lesson, as app.lesson_teacher_role answers it for a teacher. */
  async teacherRole(tx: PrismaClient, lessonId: string): Promise<LessonTeacherRole | null> {
    const rows = await tx.$queryRaw<{ role: string | null }[]>(
      Prisma.sql`SELECT app.lesson_teacher_role(${lessonId}::uuid) AS role`,
    );
    const role = rows?.[0]?.role ?? null;
    return role === 'REGULAR' || role === 'SUBSTITUTE' ? role : null;
  }

  private async callerRole(tx: PrismaClient, lessonId: string, user: AuthenticatedUser): Promise<LessonCallerRole> {
    if (user.role === Role.SCHOOL_ADMIN) return 'ADMIN';
    return (await this.teacherRole(tx, lessonId)) ?? 'COLLEAGUE';
  }

  private mayOf(role: LessonCallerRole, user: AuthenticatedUser): LessonLogLessonView['may'] {
    const drift = role === 'ADMIN' && profileWrites(user.adminProfile, 'DRIFT');
    return {
      writeLog: drift || role === 'REGULAR' || role === 'SUBSTITUTE',
      readNote: role === 'REGULAR' || role === 'SUBSTITUTE',
      writeNote: role === 'REGULAR',
    };
  }

  /** GET lessons/:id: the lesson, its log, the note when the caller may read it, and what the caller may change. */
  async lesson(lessonId: string, user: AuthenticatedUser): Promise<LessonLogLessonView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const lesson = await tx.calendarLesson.findUnique({ where: { id: lessonId }, select: LESSON_SELECT });
      if (!lesson) throw lessonNotFound();
      const role = await this.callerRole(tx, lessonId, user);
      const may = this.mayOf(role, user);
      const timezone = await schoolTimezone(tx, schoolId);
      const [log, note] = await Promise.all([
        tx.lessonLog.findUnique({
          where: { calendarLessonId: lessonId },
          select: { topic: true, homework: true, updatedAt: true, writtenBy: WRITER },
        }),
        may.readNote
          ? tx.lessonSubstituteNote.findUnique({
              where: { calendarLessonId: lessonId },
              select: { body: true, updatedAt: true, writtenBy: WRITER },
            })
          : Promise.resolve(null),
      ]);
      return {
        lesson: {
          id: lesson.id,
          date: asDay(lesson.date),
          start: schoolClock(lesson.startsAt, timezone),
          end: schoolClock(lesson.endsAt, timezone),
          status: lesson.status,
          subject: lesson.subject.name,
          subjectColor: lesson.subject.color ?? null,
          groups: [lesson.studentGroup.name, ...lesson.extraGroups.map((row) => row.studentGroup.name)],
          room: lesson.room?.name ?? null,
          teachers: lesson.teachers.map((row) => ({ name: nameOf(row.teacher) ?? '', role: row.role })),
        },
        role,
        may,
        log: log ? this.logText(log) : null,
        note: note ? this.noteText(note) : null,
      };
    });
  }

  /** PUT lessons/:id: the whole log; both fields empty removes it. Answers the log as it now stands. */
  async putLog(lessonId: string, dto: PutLessonLogDto, user: AuthenticatedUser): Promise<{ log: LessonLogText | null }> {
    const schoolId = requireSchoolId(user);
    // Who wrote it is the database's to stamp (app.lesson_text_written_by),
    // from the same claims; a caller with no user writes nothing.
    requireUserId(user);
    const topic = text(dto.topic);
    const homework = text(dto.homework);
    if (topic !== null && /[\r\n]/.test(topic)) {
      throw new BadRequestException({ message: 'topic: en rad.', code: LESSON_LOG_TOPIC_ONE_LINE });
    }
    if (topic !== null && length(topic) > TOPIC_MAX) throw tooLong('topic', TOPIC_MAX);
    if (homework !== null && length(homework) > HOMEWORK_MAX) throw tooLong('homework', HOMEWORK_MAX);
    const basis = basisOf(dto.basis);

    return this.prisma.withRls(user, async (tx) => {
      const lesson = await tx.calendarLesson.findUnique({ where: { id: lessonId }, select: { id: true } });
      if (!lesson) throw lessonNotFound();
      if (user.role === Role.TEACHER && (await this.teacherRole(tx, lessonId)) === null) {
        throw new ForbiddenException({
          message: 'Bara lektionens lärare och dess vikarie skriver lektionens logg.',
          code: LESSON_LOG_NOT_YOURS,
        });
      }
      await lockLessonText(tx, 'log', lessonId);
      const current = await tx.lessonLog.findUnique({
        where: { calendarLessonId: lessonId },
        select: { id: true, updatedAt: true },
      });
      if (basis !== undefined && (current?.updatedAt.toISOString() ?? null) !== basis) {
        throw new ConflictException({
          message: 'Någon annan har ändrat loggen sedan du öppnade den.',
          code: LESSON_LOG_STALE,
        });
      }
      if (topic === null && homework === null) {
        if (current) await tx.lessonLog.delete({ where: { id: current.id } });
        return { log: null };
      }
      const select = { topic: true, homework: true, updatedAt: true, writtenBy: WRITER } as const;
      const row = current
        ? await tx.lessonLog.update({ where: { id: current.id }, data: { topic, homework }, select })
        : await tx.lessonLog.create({ data: { schoolId, calendarLessonId: lessonId, topic, homework }, select });
      return { log: this.logText(row) };
    });
  }

  /** PUT lessons/:id/substitute-note: the note; empty removes it. Answers the note as it now stands. */
  async putNote(lessonId: string, dto: PutSubstituteNoteDto, user: AuthenticatedUser): Promise<{ note: SubstituteNoteText | null }> {
    const schoolId = requireSchoolId(user);
    requireUserId(user);
    const body = text(dto.body);
    if (body !== null && length(body) > NOTE_MAX) throw tooLong('body', NOTE_MAX);
    const basis = basisOf(dto.basis);

    return this.prisma.withRls(user, async (tx) => {
      const lesson = await tx.calendarLesson.findUnique({ where: { id: lessonId }, select: { id: true } });
      if (!lesson) throw lessonNotFound();
      if ((await this.teacherRole(tx, lessonId)) !== 'REGULAR') {
        throw new ForbiddenException({
          message: 'Bara lektionens egen lärare skriver notisen till vikarien.',
          code: SUBSTITUTE_NOTE_NOT_YOURS,
        });
      }
      await lockLessonText(tx, 'note', lessonId);
      const current = await tx.lessonSubstituteNote.findUnique({
        where: { calendarLessonId: lessonId },
        select: { id: true, updatedAt: true },
      });
      if (basis !== undefined && (current?.updatedAt.toISOString() ?? null) !== basis) {
        throw new ConflictException({
          message: 'Någon annan har ändrat notisen sedan du öppnade den.',
          code: SUBSTITUTE_NOTE_STALE,
        });
      }
      if (body === null) {
        if (current) await tx.lessonSubstituteNote.delete({ where: { id: current.id } });
        return { note: null };
      }
      const select = { body: true, updatedAt: true, writtenBy: WRITER } as const;
      const row = current
        ? await tx.lessonSubstituteNote.update({ where: { id: current.id }, data: { body }, select })
        : await tx.lessonSubstituteNote.create({ data: { schoolId, calendarLessonId: lessonId, body }, select });
      return { note: this.noteText(row) };
    });
  }

  /**
   * GET ?from&to: the logs of the caller's own lessons over a range.
   *
   * A pupil's: the lessons they can read whose roster names them, by the one
   * roster reader (src/calendar/lesson-roster.ts), so a later phase that
   * changes who attends a lesson changes this list with the register's. Their
   * own, so not in the läslogg.
   *
   * A teacher's: the lessons they are on (CalendarLessonTeachers, the rows
   * their week draws), each with its note to the substitute, which they may
   * read on every one of them: the week marks the lessons that have one, and
   * Mina vikariepass shows it.
   */
  async listForCaller(query: LessonLogRangeQueryDto, user: AuthenticatedUser): Promise<{ entries: LessonLogEntry[] }> {
    requireSchoolId(user);
    const me = requireUserId(user);
    assertRange(query.from, query.to, RANGE_MAX_DAYS, LESSON_LOG_RANGE);
    const dates = { gte: dayDate(query.from), lte: dayDate(query.to) };

    return this.prisma.withRls(user, async (tx) => {
      if (user.role === Role.STUDENT) {
        const lessons =
          (await tx.calendarLesson.findMany({
            where: { date: dates },
            select: { id: true, studentGroupId: true, extraGroups: { select: { studentGroupId: true } } },
          })) ?? [];
        const rosters = await calendarLessonRosters(tx, lessons, { pupils: 'ACTIVE', among: [me] });
        const mine = lessons.filter((lesson) => rosters.get(lesson.id)?.has(me)).map((lesson) => lesson.id);
        if (mine.length === 0) return { entries: [] };
        const logs = await tx.lessonLog.findMany({
          where: { calendarLessonId: { in: mine } },
          select: { calendarLessonId: true, topic: true, homework: true },
          orderBy: { calendarLessonId: 'asc' },
        });
        return {
          entries: logs.map((log) => ({ lessonId: log.calendarLessonId, topic: log.topic, homework: log.homework })),
        };
      }

      const taught = (
        (await tx.calendarLessonTeacher.findMany({
          where: { teacherId: me, calendarLesson: { date: dates } },
          select: { calendarLessonId: true },
        })) ?? []
      ).map((row) => row.calendarLessonId);
      if (taught.length === 0) return { entries: [] };
      const [logs, notes] = await Promise.all([
        tx.lessonLog.findMany({
          where: { calendarLessonId: { in: taught } },
          select: { calendarLessonId: true, topic: true, homework: true },
        }),
        tx.lessonSubstituteNote.findMany({
          where: { calendarLessonId: { in: taught } },
          select: { calendarLessonId: true, body: true },
        }),
      ]);
      const logOf = new Map(logs.map((log) => [log.calendarLessonId, log]));
      const noteOf = new Map(notes.map((note) => [note.calendarLessonId, note.body]));
      return {
        entries: [...new Set([...logOf.keys(), ...noteOf.keys()])].sort().map((lessonId) => ({
          lessonId,
          topic: logOf.get(lessonId)?.topic ?? null,
          homework: logOf.get(lessonId)?.homework ?? null,
          substituteNote: noteOf.get(lessonId) ?? null,
        })),
      };
    });
  }

  /**
   * GET handed-over?from&to: the lessons the calling teacher handed over in a
   * range — every lesson a cover decision was made on for their absence —
   * with whether they left the substitute a note. Booking a substitute takes
   * the absent teacher off the lesson, and with it out of their week; this is
   * how they still reach it (app.lesson_teacher_role counts them REGULAR).
   * Their own absence's decisions (teacher_absence_covers_own_select), so not
   * in the läslogg; the substitute is not named.
   */
  async handedOver(query: LessonLogRangeQueryDto, user: AuthenticatedUser): Promise<{ lessons: HandedOverLesson[] }> {
    requireSchoolId(user);
    const me = requireUserId(user);
    assertRange(query.from, query.to, RANGE_MAX_DAYS, LESSON_LOG_RANGE);
    const dates = { gte: dayDate(query.from), lte: dayDate(query.to) };
    return this.prisma.withRls(user, async (tx) => {
      // The caller's absences that reach into the range (a decision's lesson
      // lies inside its absence), then their decisions, then those lessons in
      // the range: three indexed reads, however long the läsår.
      const absences =
        (await tx.teacherAbsence.findMany({
          where: {
            userId: me,
            startsAt: { lt: dayDate(shiftDay(query.to, 2)) },
            endsAt: { gt: dayDate(shiftDay(query.from, -1)) },
          },
          select: { id: true },
        })) ?? [];
      if (absences.length === 0) return { lessons: [] };
      const covers =
        (await tx.teacherAbsenceCover.findMany({
          where: { absentTeacherId: me, absenceId: { in: absences.map((absence) => absence.id) } },
          select: { calendarLessonId: true, decision: true },
        })) ?? [];
      // One lesson may carry decisions for two of the caller's absences; one row each lesson.
      const decisionOf = new Map(covers.map((cover) => [cover.calendarLessonId, cover.decision as string]));
      if (decisionOf.size === 0) return { lessons: [] };
      const [lessons, notes] = await Promise.all([
        tx.calendarLesson.findMany({
          where: { id: { in: [...decisionOf.keys()] }, date: dates },
          select: { id: true, date: true, startsAt: true, endsAt: true, subjectId: true, studentGroupId: true, roomId: true, status: true },
          orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        }),
        tx.lessonSubstituteNote.findMany({
          where: { calendarLessonId: { in: [...decisionOf.keys()] } },
          select: { calendarLessonId: true },
        }),
      ]);
      const noted = new Set((notes ?? []).map((note) => note.calendarLessonId));
      return {
        lessons: (lessons ?? []).map((lesson) => ({
          lessonId: lesson.id,
          date: asDay(lesson.date),
          startsAt: lesson.startsAt.toISOString(),
          endsAt: lesson.endsAt.toISOString(),
          subjectId: lesson.subjectId,
          studentGroupId: lesson.studentGroupId,
          roomId: lesson.roomId,
          status: lesson.status,
          decision: decisionOf.get(lesson.id)!,
          noted: noted.has(lesson.id),
        })),
      };
    });
  }

  private logText(row: {
    topic: string | null;
    homework: string | null;
    updatedAt: Date;
    writtenBy: { firstName: string; lastName: string } | null;
  }): LessonLogText {
    return { topic: row.topic, homework: row.homework, writtenBy: nameOf(row.writtenBy), updatedAt: row.updatedAt.toISOString() };
  }

  private noteText(row: { body: string; updatedAt: Date; writtenBy: { firstName: string; lastName: string } | null }): SubstituteNoteText {
    return { body: row.body, writtenBy: nameOf(row.writtenBy), updatedAt: row.updatedAt.toISOString() };
  }
}
