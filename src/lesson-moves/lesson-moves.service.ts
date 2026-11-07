import { ConflictException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { recordRead } from '../access-log/access-log';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { calendarLessonRosters } from '../calendar/lesson-roster';
import { requireSchoolId } from '../common/utils/request-context';
import { schoolTimezone } from '../cover/cover-context';
import { sqlStateOf } from '../cover/cover-errors';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  LESSON_MOVE_ALREADY_ON_TARGET,
  LESSON_MOVE_LESSON_NOT_FOUND,
  LESSON_MOVE_NOT_A_PUPIL,
  LESSON_MOVE_NOT_ALLOWED,
  LESSON_MOVE_NOT_FOUND,
  LESSON_MOVE_PUPIL_DOUBLE_BOOKED,
  LESSON_MOVE_PUPIL_NOT_ON_LESSON,
  SQLSTATE_TO_CODE,
  conflictCodeOf,
  crowdedWarning,
  doubleBooks,
  overlaps,
  refusalOf,
  type MoveLesson,
  type MoveRefusal,
  type MoveSide,
  type MoveWarning,
} from './lesson-move-rules';
import { moveEmail, moveMeta } from './lesson-move-notices';

/** What a lesson is called in the lists: its subject, its class or group, its time on the school's clock, its room. */
export interface MoveLessonView {
  id: string;
  subject: string;
  className: string;
  start: string;
  end: string;
  room: string | null;
}

export interface MoveCandidate extends MoveLessonView {
  /** The pupils who would be on the lesson without this one. */
  headcount: number;
  roomCapacity: number | null;
  /** Why the pupil cannot be moved here, with the lesson that is the reason; null when they can. */
  refusal: MoveRefusal | null;
  /** What to tell the teacher without refusing. */
  warnings: MoveWarning[];
}

export interface MoveCandidates {
  /** The lesson the pupil would leave (the one they started on, when a move has put them elsewhere). */
  from: MoveLessonView;
  candidates: MoveCandidate[];
}

export interface MoveResult {
  /** False when the pupil was sent back to the lesson they started on, which undoes the move. */
  moved: boolean;
  moveId: string | null;
  warnings: MoveWarning[];
}

export interface LessonMoveView {
  moveId: string;
  studentId: string;
  studentName: string;
  /** Where the pupil went (a departure) or where they came from (an arrival). */
  other: MoveLessonView;
  movedByName: string | null;
  createdAt: string;
}

export interface LessonMovesView {
  departures: LessonMoveView[];
  arrivals: LessonMoveView[];
}

/** A pupil of a lesson the caller may move, by name: for the dialog's list. */
export interface MovablePupil {
  id: string;
  firstName: string;
  lastName: string;
  /** True when the pupil is on the lesson because a move put them there: they can be sent on or back. */
  arrived: boolean;
}

const LESSON_SELECT = {
  id: true,
  schoolId: true,
  date: true,
  startsAt: true,
  endsAt: true,
  status: true,
  cancelCause: true,
  subjectId: true,
  studentGroupId: true,
  subject: { select: { name: true } },
  studentGroup: { select: { name: true } },
  room: { select: { name: true, capacity: true } },
  extraGroups: { select: { studentGroupId: true } },
} satisfies Prisma.CalendarLessonSelect;

type LessonRow = Prisma.CalendarLessonGetPayload<{ select: typeof LESSON_SELECT }>;

const asLesson = (row: LessonRow): MoveLesson => ({
  id: row.id,
  status: row.status,
  cancelCause: row.cancelCause,
  startsAt: row.startsAt,
  endsAt: row.endsAt,
});

/** HH:MM on the school's clock. */
function clock(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant);
}

const viewOf = (row: LessonRow, timezone: string): MoveLessonView => ({
  id: row.id,
  subject: row.subject.name,
  className: row.studentGroup.name,
  start: clock(row.startsAt, timezone),
  end: clock(row.endsAt, timezone),
  room: row.room?.name ?? null,
});

/**
 * Elevens lektion för dagen: a teacher, a mentor or an administrator moves one
 * pupil, for one date, from a lesson to a parallel one.
 *
 * WHO ASKS WHAT. The gateway answers the teacher with the reason: the pupil is
 * on the lesson they say (the one roster reader, calendar/lesson-roster.ts),
 * the target is held and overlaps the lesson the pupil started on, the pupil is
 * not already on it and does not meet another of their own lessons there, and
 * a full room is a warning. The database's door (app.lesson_pupil_move) asks the
 * rest and is the only writer: whether this login may (Drift; a teacher of one
 * of the lessons; the pupil's mentor that day), the two lessons locked in id
 * order against a register that is being saved, the mark on the source set
 * aside, the arrival written. A race that passes the gateway is refused there
 * with the same code.
 *
 * Nothing here touches the template (MasterLesson): a move belongs to the two
 * dated lessons and falls with either.
 */
@Injectable()
export class LessonMovesService {
  private readonly logger = new Logger(LessonMovesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * The lessons a pupil can be moved to from `lessonId`, with the reason for
   * each that they cannot, the headcount and the room's capacity. The register
   * asks this when a teacher chooses "Flytta".
   */
  async candidates(lessonId: string, studentId: string, user: AuthenticatedUser): Promise<MoveCandidates> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const context = await this.contextOf(tx, lessonId, studentId, user);
      const { origin, current } = context;
      const timezone = await schoolTimezone(tx, origin.schoolId);

      // The day's lessons, once: the candidates are those that overlap the one the pupil started on, and the
      // pupil's own other lessons (for the double booking) come from the same list.
      const day = await tx.calendarLesson.findMany({
        where: { schoolId: origin.schoolId, date: origin.date },
        select: LESSON_SELECT,
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        take: 2000,
      });
      const now = new Date();
      const overlapping = day.filter((row) => row.id !== origin.id && row.id !== current.id && overlaps(asLesson(row), asLesson(origin)));

      const pupilRosters = await calendarLessonRosters(tx, day, { pupils: 'ACTIVE', among: [studentId] });
      const pupilLessons = day.filter((row) => pupilRosters.get(row.id)?.has(studentId)).map(asLesson);
      const headcounts = overlapping.length === 0 ? new Map<string, Set<string>>() : await calendarLessonRosters(tx, overlapping, { pupils: 'ACTIVE' });
      const except = new Set([origin.id, current.id]);

      const candidates = overlapping.map((row): MoveCandidate => {
        const target = asLesson(row);
        const headcount = headcounts.get(row.id)?.size ?? 0;
        let refusal: MoveRefusal | null = refusalOf(asLesson(origin), target, now);
        if (!refusal && pupilRosters.get(row.id)?.has(studentId)) refusal = { code: LESSON_MOVE_ALREADY_ON_TARGET };
        if (!refusal && doubleBooks(target, pupilLessons, except)) refusal = { code: LESSON_MOVE_PUPIL_DOUBLE_BOOKED };
        const warning = refusal ? null : crowdedWarning(headcount, row.room?.capacity ?? null);
        return {
          ...viewOf(row, timezone),
          headcount,
          roomCapacity: row.room?.capacity ?? null,
          refusal,
          warnings: warning ? [warning] : [],
        };
      });
      // The ones the pupil can go to first, each group by the clock.
      candidates.sort((a, b) => Number(a.refusal !== null) - Number(b.refusal !== null) || a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
      return { from: viewOf(origin, timezone), candidates };
    });
  }

  /** Moves `studentId` off `fromLessonId` onto `toLessonId`, or back to where they started. */
  async move(studentId: string, fromLessonId: string, toLessonId: string, user: AuthenticatedUser): Promise<MoveResult> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const context = await this.contextOf(tx, fromLessonId, studentId, user, toLessonId);
      const { origin, current } = context;
      const target = await this.lessonOf(tx, toLessonId);
      const backToStart = context.prev !== null && target.id === origin.id;

      const warnings: MoveWarning[] = [];
      if (!backToStart) {
        const refusal = refusalOf(asLesson(origin), asLesson(target), new Date());
        if (refusal) throw refusalError(refusal);
        const day = await tx.calendarLesson.findMany({
          where: { schoolId, date: origin.date, id: { not: target.id } },
          select: LESSON_SELECT,
          take: 2000,
        });
        const mine = await calendarLessonRosters(tx, [...day, target], { pupils: 'ACTIVE', among: [studentId] });
        if (mine.get(target.id)?.has(studentId)) throw refusalError({ code: LESSON_MOVE_ALREADY_ON_TARGET });
        const pupilLessons = day.filter((row) => mine.get(row.id)?.has(studentId)).map(asLesson);
        if (doubleBooks(asLesson(target), pupilLessons, new Set([origin.id, current.id]))) {
          throw refusalError({ code: LESSON_MOVE_PUPIL_DOUBLE_BOOKED });
        }
        const headcount = (await calendarLessonRosters(tx, [target], { pupils: 'ACTIVE' })).get(target.id)?.size ?? 0;
        const crowded = crowdedWarning(headcount, target.room?.capacity ?? null);
        if (crowded) warnings.push(crowded);
      }

      const moveId = await this.door(tx, studentId, current.id, target.id);

      // The teachers of both lessons see the pupil move in their register at once (the web's list and the app's
      // cache), and the lessons' rosters are what the broadcast reads.
      await this.realtime.notifyLessonsChanged(tx, [...new Set([origin.id, current.id, target.id])]);
      await this.tell(tx, { origin, current, target, studentId, undone: backToStart, user });
      this.logger.log(`Pupil moved [from=${origin.id}, to=${target.id}, back=${backToStart}]`);
      return { moved: !backToStart, moveId, warnings };
    });
  }

  /** Ångra: takes a move back, with the pupil's mark on the lesson they left put back if nobody has written one since. */
  async undo(moveId: string, user: AuthenticatedUser): Promise<void> {
    requireSchoolId(user);
    await this.prisma.withRls(user, async (tx) => {
      const row = await tx.lessonPupilMove.findUnique({ where: { id: moveId }, select: { studentId: true, fromLessonId: true, toLessonId: true } });
      // A move a login cannot read is a move that is not there for them: the same answer.
      if (!row) throw new NotFoundException({ message: 'Flytten finns inte.', code: LESSON_MOVE_NOT_FOUND });
      const [origin, target] = await Promise.all([this.lessonOf(tx, row.fromLessonId), this.lessonOf(tx, row.toLessonId)]);
      try {
        await tx.$executeRaw(Prisma.sql`SELECT app.lesson_pupil_move_undo(${moveId}::uuid)`);
      } catch (error) {
        throw doorError(error);
      }
      await this.realtime.notifyLessonsChanged(tx, [origin.id, target.id]);
      await this.tell(tx, { origin, current: target, target, studentId: row.studentId, undone: true, user });
      this.logger.log(`Pupil move undone [from=${origin.id}, to=${target.id}]`);
    });
  }

  /**
   * The pupils of a lesson the caller may move: its whole list for an administrator and for a teacher of the
   * lesson (the register's own list, as the one roster reader answers it), the pupils they mentor that day for a
   * teacher who only mentors. A teacher of neither gets nothing, and no hint of why.
   */
  async pupils(lessonId: string, user: AuthenticatedUser): Promise<{ students: MovablePupil[] }> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const lesson = await this.lessonOf(tx, lessonId);
      const roster = [...((await calendarLessonRosters(tx, [lesson], { pupils: 'ACTIVE' })).get(lesson.id) ?? [])];
      if (roster.length === 0) return { students: [] };
      let allowed = roster;
      if (user.role === Role.TEACHER) {
        const teaches =
          !!user.userId &&
          !!(await tx.calendarLessonTeacher.findFirst({ where: { teacherId: user.userId, calendarLessonId: lessonId }, select: { id: true } }));
        if (!teaches) {
          // Only the mentees: one statement over the roster, the day's mentor question asked once per pupil by the database.
          const rows = await tx.$queryRaw<Array<{ id: string }>>(
            Prisma.sql`SELECT p.id FROM unnest(${roster}::uuid[]) AS p(id) WHERE app.lesson_move_is_mentor(p.id, ${lesson.date}::date)`,
          );
          allowed = rows.map((row) => row.id);
        }
      }
      if (allowed.length === 0) return { students: [] };
      const [students, arrivals] = await Promise.all([
        tx.user.findMany({
          where: { id: { in: allowed } },
          select: { id: true, firstName: true, lastName: true },
          orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        }),
        tx.lessonPupilMove.findMany({ where: { toLessonId: lessonId, studentId: { in: allowed } }, select: { studentId: true } }),
      ]);
      const arrived = new Set(arrivals.map((row) => row.studentId));
      await recordRead(tx, 'ROSTER', students.map((student) => student.id), user.channel);
      return { students: students.map((student) => ({ ...student, arrived: arrived.has(student.id) })) };
    });
  }

  /** The moves of one lesson: the pupils it lost to a parallel lesson and those it gained, by name, for its register. */
  async forLesson(lessonId: string, user: AuthenticatedUser): Promise<LessonMovesView> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const lesson = await this.lessonOf(tx, lessonId);
      const timezone = await schoolTimezone(tx, lesson.schoolId);
      const rows = await tx.lessonPupilMove.findMany({
        where: { OR: [{ fromLessonId: lessonId }, { toLessonId: lessonId }] },
        select: {
          id: true,
          studentId: true,
          fromLessonId: true,
          toLessonId: true,
          movedById: true,
          createdAt: true,
          student: { select: { firstName: true, lastName: true } },
          movedBy: { select: { firstName: true, lastName: true } },
          fromLesson: { select: LESSON_SELECT },
          toLesson: { select: LESSON_SELECT },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      // The register names the pupils on its list; so do the moves on it. The read log has them as a roster read.
      await recordRead(tx, 'ROSTER', rows.map((row) => row.studentId), user.channel);
      // A colleague on the lesson is not told who moved the pupil when the mover has a protected identity (the review
      // of #281, LÅG-1): no list a teacher reads gathers a marked teacher. An administrator, and the mover themselves,
      // see the name. Only asked for a teacher, and only when somebody moved a pupil.
      const held = user.role === Role.SCHOOL_ADMIN || !rows.some((row) => row.movedById) ? new Set<string>() : await this.protectedStaff(tx);
      const view = (row: (typeof rows)[number], other: LessonRow): LessonMoveView => ({
        moveId: row.id,
        studentId: row.studentId,
        studentName: `${row.student.firstName} ${row.student.lastName}`,
        other: viewOf(other, timezone),
        movedByName:
          row.movedBy && !(row.movedById && row.movedById !== user.userId && held.has(row.movedById))
            ? `${row.movedBy.firstName} ${row.movedBy.lastName}`
            : null,
        createdAt: row.createdAt.toISOString(),
      });
      return {
        departures: rows.filter((row) => row.fromLessonId === lessonId).map((row) => view(row, row.toLesson)),
        arrivals: rows.filter((row) => row.toLessonId === lessonId).map((row) => view(row, row.fromLesson)),
      };
    });
  }

  // ---------------------------------------------------------------------------

  /** The marked staff of the school (Skolans dag's list, for a caller who may not read the marks). */
  private async protectedStaff(tx: PrismaClient): Promise<Set<string>> {
    const rows = (await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT app.school_day_protected_staff() AS id`)) ?? [];
    return new Set(rows.map((row) => row.id));
  }

  private async lessonOf(tx: PrismaClient, id: string): Promise<LessonRow> {
    const row = await tx.calendarLesson.findUnique({ where: { id }, select: LESSON_SELECT });
    if (!row) throw new NotFoundException({ message: 'Lektionen finns inte.', code: LESSON_MOVE_LESSON_NOT_FOUND });
    return row;
  }

  /**
   * The lesson the pupil is on (`lessonId`), the lesson they started on (the same, unless a move put them on this
   * one), and whether they are on it at all. A teacher is asked who they are before anything is said about the
   * pupil, so a teacher who may not move this pupil learns nothing about whom a lesson holds.
   */
  private async contextOf(
    tx: PrismaClient,
    lessonId: string,
    studentId: string,
    user: AuthenticatedUser,
    toLessonId?: string,
  ): Promise<{ current: LessonRow; origin: LessonRow; prev: { id: string; fromLessonId: string } | null }> {
    const current = await this.lessonOf(tx, lessonId);
    const pupil = await tx.user.findFirst({ where: { id: studentId, role: 'STUDENT', isActive: true }, select: { id: true } });
    if (!pupil) throw new NotFoundException({ message: 'Eleven finns inte.', code: LESSON_MOVE_NOT_A_PUPIL });
    const prev = (await tx.lessonPupilMove.findFirst({ where: { toLessonId: lessonId, studentId }, select: { id: true, fromLessonId: true } })) ?? null;
    const origin = prev ? await this.lessonOf(tx, prev.fromLessonId) : current;
    await this.assertMayMove(tx, user, studentId, origin, [origin.id, current.id, ...(toLessonId ? [toLessonId] : [])]);
    // Not on a lesson the pupil was moved to? Then on the lesson by the roster's own account.
    if (!prev) {
      const roster = (await calendarLessonRosters(tx, [current], { pupils: 'ACTIVE', among: [studentId] })).get(current.id);
      if (!roster?.has(studentId)) {
        throw new ConflictException({ message: 'Eleven går inte på lektionen.', code: LESSON_MOVE_PUPIL_NOT_ON_LESSON });
      }
    }
    return { current, origin, prev };
  }

  /**
   * An administrator is Drift's (the controller's @Area). A teacher teaches one of the lessons or mentors the pupil
   * the day of the move: the same two questions the door asks, here first so that the answer to a stranger is 403
   * and nothing else.
   */
  private async assertMayMove(
    tx: PrismaClient,
    user: AuthenticatedUser,
    studentId: string,
    origin: LessonRow,
    lessonIds: readonly string[],
  ): Promise<void> {
    if (user.role !== Role.TEACHER) return;
    if (!user.userId) throw new ForbiddenException({ message: 'Läraren saknas i inloggningen.', code: LESSON_MOVE_NOT_ALLOWED });
    const teaches = await tx.calendarLessonTeacher.findFirst({
      where: { teacherId: user.userId, calendarLessonId: { in: [...new Set(lessonIds)] } },
      select: { id: true },
    });
    if (teaches) return;
    const [mentor] = await tx.$queryRaw<Array<{ mentor: boolean }>>(
      Prisma.sql`SELECT app.lesson_move_is_mentor(${studentId}::uuid, ${origin.date}::date) AS mentor`,
    );
    if (!mentor?.mentor) {
      throw new ForbiddenException({ message: 'Du får inte flytta den här eleven.', code: LESSON_MOVE_NOT_ALLOWED });
    }
  }

  /** The database's door; its refusals answered as coded 4xx. */
  private async door(tx: PrismaClient, studentId: string, fromLessonId: string, toLessonId: string): Promise<string | null> {
    try {
      const [row] = await tx.$queryRaw<Array<{ id: string | null }>>(
        Prisma.sql`SELECT app.lesson_pupil_move(${studentId}::uuid, ${fromLessonId}::uuid, ${toLessonId}::uuid) AS id`,
      );
      return row?.id ?? null;
    } catch (error) {
      throw doorError(error);
    }
  }

  /**
   * The teachers of the two lessons are told, the one who moved the pupil excepted, and the pupil's guardians when
   * the school has said so. In the same transaction as the move: a notice for a move that was not made is not sent.
   */
  private async tell(
    tx: PrismaClient,
    input: { origin: LessonRow; current: LessonRow; target: LessonRow; studentId: string; undone: boolean; user: AuthenticatedUser },
  ): Promise<void> {
    const { origin, target, studentId, undone, user } = input;
    const timezone = await schoolTimezone(tx, origin.schoolId);
    const teachers = await tx.calendarLessonTeacher.findMany({
      where: { calendarLessonId: { in: [origin.id, target.id] } },
      select: { teacherId: true },
    });
    const teacherIds = [...new Set(teachers.map((row) => row.teacherId))].filter((id) => id !== user.userId);
    const settings = await tx.schoolDaySettings.findUnique({ where: { schoolId: origin.schoolId }, select: { guardianNoticeOnMove: true } });
    const guardianIds = settings?.guardianNoticeOnMove ? await this.notifications.guardiansOf(tx, [studentId]) : [];
    if (teacherIds.length === 0 && guardianIds.length === 0) return;
    const from = { subjectName: origin.subject.name, startsAt: origin.startsAt };
    const to = { subjectName: target.subject.name, startsAt: target.startsAt };
    const meta = moveMeta({ fromLessonId: origin.id, toLessonId: target.id, studentId }, from, to, undone);
    if (teacherIds.length > 0) {
      await this.notifications.notifyUsers(tx, { schoolId: origin.schoolId, userIds: teacherIds, type: 'LESSON_PUPIL_MOVED', meta: { ...meta } });
    }
    if (guardianIds.length > 0) {
      await this.notifications.notifyUsers(tx, {
        schoolId: origin.schoolId,
        userIds: guardianIds,
        type: 'LESSON_PUPIL_MOVED',
        meta: { ...meta },
        email: moveEmail(from, to, timezone, undone),
      });
    }
  }
}

// ---------------------------------------------------------------------------

const MESSAGES: Readonly<Record<string, string>> = {
  LESSON_MOVE_NOT_ALLOWED: 'Du får inte flytta den här eleven.',
  LESSON_MOVE_NOT_FOUND: 'Flytten finns inte.',
  LESSON_MOVE_LESSON_NOT_FOUND: 'Lektionen finns inte.',
  LESSON_MOVE_NOT_PARALLEL: 'Lektionerna överlappar inte varandra i tid, så eleven kan inte flyttas dit.',
  LESSON_MOVE_LESSON_NOT_HELD: 'Lektionen är inställd och hålls inte.',
  LESSON_MOVE_REPLACED_BY_ACTIVITY: 'Lektionen är ersatt av en schemabrytande aktivitet.',
  LESSON_MOVE_IN_THE_PAST: 'En flytt görs för i dag eller senare.',
  LESSON_MOVE_LESSON_OVER: 'Lektionen eleven flyttas från är slut. Närvaron för den rättas i lektionens register.',
  LESSON_MOVE_PUPIL_NOT_ON_LESSON: 'Eleven går inte på lektionen.',
  LESSON_MOVE_ALREADY_ON_TARGET: 'Eleven går redan på den lektionen.',
  LESSON_MOVE_PUPIL_DOUBLE_BOOKED: 'Eleven skulle få två lektioner samtidigt.',
  LESSON_MOVE_HAS_ATTENDANCE: 'Eleven har redan en närvaromarkering på lektionen de flyttats till. Ta bort markeringen först.',
  LESSON_MOVE_EXISTS: 'Eleven är redan flyttad från lektionen.',
  LESSON_MOVE_CHANGED: 'Flytten ändrades just nu. Försök igen.',
  LESSON_MOVE_NOT_A_PUPIL: 'Eleven finns inte.',
};

function coded(status: 403 | 404 | 409, code: string, params?: Record<string, unknown>): HttpException {
  const body = { message: MESSAGES[code] ?? code, code, ...(params ? { params } : {}) };
  return status === 403 ? new ForbiddenException(body) : status === 404 ? new NotFoundException(body) : new ConflictException(body);
}

/** A refusal from the rules, as a 409 with the code and which lesson it is about. */
export function refusalError(refusal: MoveRefusal): HttpException {
  const side: MoveSide | undefined = refusal.side;
  return coded(409, refusal.code, side ? { side } : undefined);
}

/** The text the database's refusal carries: the adapter's cause has it, and so does the rendered error. */
function doorText(error: unknown): string {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalMessage?: unknown } } } }).meta?.driverAdapterError?.cause;
  return `${typeof cause?.originalMessage === 'string' ? cause.originalMessage : ''} ${error instanceof Error ? error.message : ''}`;
}

/** The database door's refusal as the coded answer the gateway would have given; anything else passes through. */
export function doorError(error: unknown): unknown {
  const state = sqlStateOf(error);
  if (!state) return error;
  if (state === 'LM409') {
    // The code is in the database's message.
    return coded(409, conflictCodeOf(doorText(error)) ?? LESSON_MOVE_ALREADY_ON_TARGET);
  }
  if (state === 'LM404') {
    // Not found is three things in the door (a move, a lesson, a pupil); each says which in its message, and the
    // teacher is told the one that went missing.
    return coded(404, conflictCodeOf(doorText(error)) ?? LESSON_MOVE_NOT_FOUND);
  }
  const code = SQLSTATE_TO_CODE[state];
  if (!code) return error;
  const status: 403 | 409 = state === 'LM403' ? 403 : 409;
  return coded(status, code);
}
