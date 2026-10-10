import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { CoverDecisionKind, PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { enterGrundschemaWrite } from '../publication/publish-mode';
import { RealtimeService } from '../realtime/realtime.service';
import {
  CalendarLessonsService,
  type CoverWarning,
  type LessonForAction,
} from '../calendar/calendar-lessons.service';
import type { StaffingWarning } from '../staffing/staffing-checks';
import {
  pairsStatement,
  summaryOf,
  toBoardItem,
  deriveStatus,
  type BoardItem,
  type BoardSummary,
  type DerivedStatus,
  type PairRow,
} from './cover-board';
import { asDay, dayBounds, dayDate, schoolTimezone } from './cover-context';
import {
  decisionsOn,
  lockLessons,
  lockTeachers,
  SUPERVISED_STUDY_NOTE,
  writeDecision,
  type DecisionRow,
  type PendingNotice,
  type RemovedTeacher,
} from './cover-decisions';
import { rethrowCoverError } from './cover-errors';
import { sendNotices, settleNotices } from './cover-notices';
import type { BulkDto, CoverDecisionKindValue, CoverStatusValue, DecisionDto } from './dto/cover.dto';

export const COVER_STALE = 'COVER_STALE';
export const COVER_LESSON_HELD = 'COVER_LESSON_HELD';
export const COVER_LESSON_STARTED = 'COVER_LESSON_STARTED';
export const COVER_NOT_AFFECTED = 'COVER_NOT_AFFECTED';
export const COVER_NO_DECISION = 'COVER_NO_DECISION';
export const CO_TEACHER_MISSING = 'CO_TEACHER_MISSING';
export const COVER_UNDO_ORDER = 'COVER_UNDO_ORDER';
export const COVER_UNDO_CONFLICT = 'COVER_UNDO_CONFLICT';
export const COVER_UNDO_CLASH = 'COVER_UNDO_CLASH';
export const COVER_RANGE = 'COVER_RANGE';
export const COVER_SUBSTITUTE_REQUIRED = 'COVER_SUBSTITUTE_REQUIRED';

/** What a cover write leaves to do once it has committed. */
export interface CoverEffects {
  lessonIds: string[];
  dates: string[];
  notices: PendingNotice[];
  warnings: Array<StaffingWarning | CoverWarning>;
}

export interface BoardResponse {
  from: string;
  to: string;
  items: BoardItem[];
  summary: BoardSummary;
  /** The period only: never a reason. */
  absences: { id: string; userId: string; startsAt: string; endsAt: string }[];
}

/** One pair, read inside a write's transaction after its locks. */
interface PairState {
  absence: { id: string; userId: string; startsAt: Date; endsAt: Date; status: 'ACTIVE' | 'WITHDRAWN' };
  lesson: LessonForAction;
  decisions: DecisionRow[];
  decision: DecisionRow | undefined;
  absentOnLesson: boolean;
  isLive: boolean;
  derived: DerivedStatus;
}

const LIVE_STATUSES = ['SCHEDULED', 'CANCELLED', 'COMPLETED'];

export const emptyEffects = (): CoverEffects => ({ lessonIds: [], dates: [], notices: [], warnings: [] });

/**
 * THE COVER BOARD (Vikarietavla): the pairs of a day or a week, and the
 * decisions on them — put in a substitute, cancel, självstudier under
 * tillsyn, the co-teacher takes it — each undoable, all admin.
 *
 * Every write here:
 *   1. enters the publication lock first (enterGrundschemaWrite: DIRECT never
 *      waits; a DRAFT publish in progress is 409 PUBLISH_IN_PROGRESS);
 *   2. locks the lesson rows (id order), then the people whose time it
 *      writes (cover-decisions.ts lockTeachers, id order);
 *   3. checks the pair is affected (404 COVER_NOT_AFFECTED), not ended
 *      (409 COVER_LESSON_HELD — held lessons are never rewritten) and that
 *      the status the admin saw is the status now (409 COVER_STALE);
 *   4. and AFTER the commit tells the substitutes (cover-notices.ts), the
 *      teacher apps (notifyLessonsChanged) and the admins' boards
 *      (cover_board_updated) — a rolled-back bulk has told nobody.
 */
@Injectable()
export class CoverService {
  private readonly logger = new Logger(CoverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
    private readonly calendarLessons: CalendarLessonsService,
  ) {}

  /** The clock the rules are judged on; a method so a spec can hold it still. */
  now(): Date {
    return new Date();
  }

  async board(from: string, to: string, user: AuthenticatedUser): Promise<BoardResponse> {
    const schoolId = requireSchoolId(user);
    checkWindow(from, to, 7);
    return this.prisma.withRls(user, async (tx) => {
      const timezone = await schoolTimezone(tx, schoolId);
      const winFrom = dayBounds(from, timezone).start;
      const winTo = dayBounds(to, timezone).end;
      const rows = (await tx.$queryRaw<PairRow[]>(pairsStatement({ kind: 'window', from, to, winFrom, winTo }))) ?? [];
      const now = this.now();
      const items = rows.map((row) => toBoardItem(row, now));
      const absences =
        (await tx.teacherAbsence.findMany({
          where: { status: 'ACTIVE', startsAt: { lt: winTo }, endsAt: { gt: winFrom } },
          select: { id: true, userId: true, startsAt: true, endsAt: true },
          orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        })) ?? [];
      return {
        from,
        to,
        items,
        summary: summaryOf(items),
        absences: absences.map((a) => ({
          id: a.id,
          userId: a.userId,
          startsAt: a.startsAt.toISOString(),
          endsAt: a.endsAt.toISOString(),
        })),
      };
    });
  }

  async decide(
    lessonId: string,
    dto: DecisionDto,
    user: AuthenticatedUser,
  ): Promise<{ lessonId: string; absenceId: string; warnings: Array<StaffingWarning | CoverWarning> }> {
    const schoolId = requireSchoolId(user);
    const effects = await this.write(user, async (tx) => {
      await enterGrundschemaWrite(tx, schoolId);
      await lockLessons(tx, [lessonId]);
      return this.decideInTransaction(
        tx,
        { lessonId, absenceId: dto.absenceId, kind: dto.kind, substituteId: dto.substituteId, expected: dto.expected },
        user,
      );
    });
    await this.afterCommit(user, effects);
    this.logger.log(`Cover decided [lesson=${lessonId}, absence=${dto.absenceId}, kind=${dto.kind}]`);
    return { lessonId, absenceId: dto.absenceId, warnings: effects.warnings };
  }

  async undo(lessonId: string, absenceId: string, user: AuthenticatedUser): Promise<{ lessonId: string; absenceId: string }> {
    const schoolId = requireSchoolId(user);
    const effects = await this.write(user, async (tx) => {
      await enterGrundschemaWrite(tx, schoolId);
      await lockLessons(tx, [lessonId]);
      return this.undoInTransaction(tx, { lessonId, absenceId }, user);
    });
    await this.afterCommit(user, effects);
    this.logger.log(`Cover undone [lesson=${lessonId}, absence=${absenceId}]`);
    return { lessonId, absenceId };
  }

  /** All or nothing: one transaction, the first refusal names its lesson and nothing is written. */
  async bulk(dto: BulkDto, user: AuthenticatedUser): Promise<{ done: number }> {
    const schoolId = requireSchoolId(user);
    const effects = await this.write(user, async (tx) => {
      await enterGrundschemaWrite(tx, schoolId);
      const lessonIds = dto.items.map((item) => item.lessonId);
      await lockLessons(tx, lessonIds);
      if (dto.action === 'UNDO') {
        // Everybody an undo of the batch could put back, locked once, in
        // order, before any of them is: two bulks never wait on each other
        // in a circle.
        const decisions = await decisionsOn(tx, lessonIds);
        await lockTeachers(
          tx,
          decisions.flatMap((row) => row.removedTeachers.map((removed) => removed.teacherId)),
        );
      }
      const all = emptyEffects();
      for (const item of dto.items) {
        try {
          const one =
            dto.action === 'UNDO'
              ? await this.undoInTransaction(tx, { lessonId: item.lessonId, absenceId: item.absenceId }, user)
              : await this.decideInTransaction(
                  tx,
                  { lessonId: item.lessonId, absenceId: item.absenceId, kind: dto.action, expected: item.expected },
                  user,
                );
          merge(all, one);
        } catch (error) {
          throw naming(error, item.lessonId);
        }
      }
      return all;
    });
    await this.afterCommit(user, effects);
    this.logger.log(`Cover bulk [action=${dto.action}, items=${dto.items.length}]`);
    return { done: dto.items.length };
  }

  // ---------------------------------------------------------------------
  // In-transaction internals: the caller has entered the publication lock
  // and locked the lesson rows.

  async decideInTransaction(
    tx: PrismaClient,
    args: {
      lessonId: string;
      absenceId: string;
      kind: CoverDecisionKindValue;
      substituteId?: string;
      expected: CoverStatusValue;
    },
    user: AuthenticatedUser,
  ): Promise<CoverEffects> {
    const schoolId = requireSchoolId(user);
    const now = this.now();
    const state = await this.readPair(tx, args.absenceId, args.lessonId, now);
    const { lesson, absence } = state;
    if (lesson.endsAt.getTime() <= now.getTime()) throw held();
    if (state.derived.status !== 'OPEN' || args.expected !== 'OPEN') throw stale(state.derived.status);
    if (args.kind !== 'SUBSTITUTE' && args.substituteId !== undefined) {
      throw new BadRequestException({ message: 'substituteId hör bara till SUBSTITUTE.', code: COVER_SUBSTITUTE_REQUIRED });
    }
    const effects: CoverEffects = { ...emptyEffects(), lessonIds: [lesson.id], dates: [asDay(lesson.date)] };
    const absentRow = (lesson.teachers ?? []).find((t) => t.teacherId === absence.userId);
    const removedAbsent: RemovedTeacher[] = absentRow ? [{ teacherId: absentRow.teacherId, role: absentRow.role ?? 'LEAD' }] : [];
    const decidedByUserId = user.userId ?? null;

    switch (args.kind) {
      case 'SUBSTITUTE': {
        if (!args.substituteId) {
          throw new BadRequestException({ message: 'substituteId: vem som vikarierar.', code: COVER_SUBSTITUTE_REQUIRED });
        }
        // The absent row is gone once a decision removed it. If that
        // decision's vikarie still holds the lesson but is away themself
        // (why the pair is OPEN again), the new vikarie takes THEIR row —
        // never a second one beside them. recordAssignment then records the
        // away vikarie's own pair as well, and tells them.
        const staleSubstitute =
          !absentRow && state.decision?.decision === 'SUBSTITUTE' && state.decision.substituteId
            ? (lesson.teachers ?? []).find((t) => t.teacherId === state.decision!.substituteId && t.role === 'SUBSTITUTE')
            : undefined;
        const outcome = await this.calendarLessons.assignInTransaction(
          tx,
          lesson.id,
          args.substituteId,
          absentRow ? absence.userId : (staleSubstitute?.teacherId ?? null),
          user,
          { locked: true, decision: { absenceId: absence.id, absentTeacherId: absence.userId } },
        );
        effects.notices.push(...outcome.notices);
        effects.warnings.push(...outcome.result.warnings);
        return effects;
      }
      case 'CANCELLED': {
        // A lesson that has begun is not cancelled (as an avbokning never
        // cancels one): the class is in the room.
        if (lesson.startsAt.getTime() <= now.getTime()) throw started();
        await this.calendarLessons.cancelInTransaction(tx, lesson, { cause: 'TEACHER_UNAVAILABLE' });
        await writeDecision(tx, {
          schoolId,
          absenceId: absence.id,
          lessonId: lesson.id,
          absentTeacherId: absence.userId,
          decision: 'CANCELLED',
          removed: [],
          substituteId: null,
          decidedByUserId,
          existing: state.decision,
        });
        return effects;
      }
      case 'SUPERVISED_STUDY': {
        if (absentRow) {
          await tx.calendarLessonTeacher.deleteMany({ where: { calendarLessonId: lesson.id, teacherId: absence.userId } });
        }
        await tx.calendarLesson.update({ where: { id: lesson.id }, data: { note: SUPERVISED_STUDY_NOTE } });
        await writeDecision(tx, {
          schoolId,
          absenceId: absence.id,
          lessonId: lesson.id,
          absentTeacherId: absence.userId,
          decision: 'SUPERVISED_STUDY',
          removed: removedAbsent,
          substituteId: null,
          previousNote: lesson.note === SUPERVISED_STUDY_NOTE ? null : lesson.note,
          decidedByUserId,
          existing: state.decision,
        });
        return effects;
      }
      case 'CO_TEACHER': {
        const others = (lesson.teachers ?? []).filter((t) => t.teacherId !== absence.userId);
        const away = await this.absentAmong(tx, others.map((t) => t.teacherId), lesson);
        if (others.every((t) => away.has(t.teacherId))) {
          throw new ConflictException({
            message: 'Ingen annan lärare som är på plats finns kvar på lektionen.',
            code: CO_TEACHER_MISSING,
          });
        }
        if (absentRow) {
          await tx.calendarLessonTeacher.deleteMany({ where: { calendarLessonId: lesson.id, teacherId: absence.userId } });
        }
        await writeDecision(tx, {
          schoolId,
          absenceId: absence.id,
          lessonId: lesson.id,
          absentTeacherId: absence.userId,
          decision: 'CO_TEACHER',
          removed: removedAbsent,
          substituteId: null,
          decidedByUserId,
          existing: state.decision,
        });
        return effects;
      }
    }
  }

  /**
   * "Ångra": the decision reversed, newest first per lesson
   * (COVER_UNDO_ORDER otherwise), putting back exactly the rows it removed —
   * minus anybody already on the lesson, never a second LEAD
   * (COVER_UNDO_CONFLICT), never somebody now teaching elsewhere then
   * (COVER_UNDO_CLASH).
   */
  async undoInTransaction(
    tx: PrismaClient,
    args: { lessonId: string; absenceId: string },
    user: AuthenticatedUser,
  ): Promise<CoverEffects> {
    const now = this.now();
    const lesson = await this.calendarLessons.requireLesson(tx, args.lessonId);
    const decisions = await decisionsOn(tx, [lesson.id]);
    const decision = decisions.find((row) => row.absenceId === args.absenceId);
    if (!decision) {
      throw new NotFoundException({ message: 'Det finns inget beslut att ångra för lektionen.', code: COVER_NO_DECISION });
    }
    if (lesson.endsAt.getTime() <= now.getTime()) throw held();
    const later = decisions.some(
      (row) =>
        row.id !== decision.id &&
        (row.decidedAt.getTime() > decision.decidedAt.getTime() ||
          (row.decidedAt.getTime() === decision.decidedAt.getTime() && row.id > decision.id)),
    );
    if (later) {
      throw new ConflictException({
        message: 'Ett senare beslut på lektionen måste ångras först.',
        code: COVER_UNDO_ORDER,
      });
    }

    const effects: CoverEffects = { ...emptyEffects(), lessonIds: [lesson.id], dates: [asDay(lesson.date)] };
    const teachers = lesson.teachers ?? [];
    // The substitute this decision put in leaves, unless another decision on
    // the lesson still names them (one vikarie for two absent co-teachers).
    const substituteLeaves =
      decision.decision === 'SUBSTITUTE' &&
      decision.substituteId !== null &&
      teachers.some((t) => t.teacherId === decision.substituteId && t.role === 'SUBSTITUTE') &&
      !decisions.some((row) => row.id !== decision.id && row.substituteId === decision.substituteId);
    const staying = teachers.filter((t) => !(substituteLeaves && t.teacherId === decision.substituteId));
    const onLesson = new Set(staying.map((t) => t.teacherId));
    const restore = decision.removedTeachers.filter((row) => !onLesson.has(row.teacherId));
    if (restore.some((row) => row.role === 'LEAD') && staying.some((t) => t.role === 'LEAD')) {
      throw new ConflictException({
        message: 'Lektionen har fått en ny lärare sedan beslutet, så den gamla kan inte läggas tillbaka.',
        code: COVER_UNDO_CONFLICT,
      });
    }
    await lockTeachers(tx, restore.map((row) => row.teacherId));
    for (const row of restore) {
      const clash = await tx.calendarLesson.findFirst({
        where: {
          id: { not: lesson.id },
          status: { in: ['SCHEDULED', 'COMPLETED'] },
          startsAt: { lt: lesson.endsAt },
          endsAt: { gt: lesson.startsAt },
          teachers: { some: { teacherId: row.teacherId } },
        },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictException({
          message: 'Läraren undervisar på en annan lektion då och kan inte läggas tillbaka.',
          code: COVER_UNDO_CLASH,
        });
      }
    }

    if (substituteLeaves) {
      await tx.calendarLessonTeacher.deleteMany({
        where: { calendarLessonId: lesson.id, teacherId: decision.substituteId!, role: 'SUBSTITUTE' },
      });
      effects.notices.push({ kind: 'WITHDRAWN', userId: decision.substituteId!, lessonId: lesson.id });
    }
    if (decision.decision === 'CANCELLED' && lesson.status === 'CANCELLED' && lesson.cancelCause === 'TEACHER_UNAVAILABLE') {
      await this.calendarLessons.reinstateInTransaction(tx, lesson);
    }
    if (decision.decision === 'SUPERVISED_STUDY' && lesson.note === SUPERVISED_STUDY_NOTE) {
      await tx.calendarLesson.update({ where: { id: lesson.id }, data: { note: decision.previousNote } });
    }
    if (restore.length > 0) {
      await tx.calendarLessonTeacher.createMany({
        data: restore.map((row) => ({
          schoolId: requireSchoolId(user),
          calendarLessonId: lesson.id,
          teacherId: row.teacherId,
          role: row.role,
        })),
      });
    }
    await tx.teacherAbsenceCover.delete({ where: { id: decision.id } });
    return effects;
  }

  /** After the commit: the notices, the teacher apps and the boards. Never throws. */
  async afterCommit(user: AuthenticatedUser, effects: CoverEffects): Promise<void> {
    const schoolId = requireSchoolId(user);
    const notices = settleNotices(effects.notices);
    if (notices.length > 0 || effects.lessonIds.length > 0) {
      await this.prisma
        .withRls(user, async (tx) => {
          const timezone = await schoolTimezone(tx, schoolId);
          await sendNotices(this.notifications, tx, schoolId, timezone, notices);
          await this.realtime.notifyLessonsChanged(tx, [...new Set(effects.lessonIds)]);
        })
        .catch(() => this.logger.warn(`Cover notices failed after commit [lessons=${effects.lessonIds.length}]`));
    }
    const dates = [...new Set(effects.dates)].sort();
    if (dates.length > 0) {
      try {
        this.realtime.notifyCoverBoardChanged(schoolId, dates[0]!, dates[dates.length - 1]!);
      } catch {
        this.logger.debug(`Cover board broadcast failed [school=${schoolId}]`);
      }
    }
  }

  /** A write, with its database refusals as coded 4xx (cover-errors.ts). */
  async write<T>(user: AuthenticatedUser, body: (tx: PrismaClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.withRls(user, body, { timeoutMs: 60_000 });
    } catch (error) {
      rethrowCoverError(error);
    }
  }

  private async readPair(tx: PrismaClient, absenceId: string, lessonId: string, now: Date): Promise<PairState> {
    const absence = await tx.teacherAbsence.findUnique({
      where: { id: absenceId },
      // The period only; never the reason.
      select: { id: true, userId: true, startsAt: true, endsAt: true, status: true },
    });
    if (!absence) throw notAffected();
    const lesson = await this.calendarLessons.requireLesson(tx, lessonId);
    const decisions = await decisionsOn(tx, [lesson.id]);
    const decision = decisions.find((row) => row.absenceId === absence.id);
    const teachers = lesson.teachers ?? [];
    const absentOnLesson = teachers.some((t) => t.teacherId === absence.userId);
    const overlapping = lesson.startsAt < absence.endsAt && lesson.endsAt > absence.startsAt;
    const isLive = absence.status === 'ACTIVE' && absentOnLesson && LIVE_STATUSES.includes(lesson.status) && overlapping;
    if (!isLive && !(decision && absence.status === 'ACTIVE')) throw notAffected();
    const substitutes = teachers.filter((t) => t.role === 'SUBSTITUTE' && t.teacherId !== absence.userId).map((t) => t.teacherId);
    const away = await this.absentAmong(tx, substitutes, lesson);
    const derived = deriveStatus(
      {
        lessonStatus: lesson.status,
        endsAt: lesson.endsAt,
        decision: (decision?.decision ?? null) as CoverDecisionKind | null,
        coveringSubstituteIds: substitutes.filter((id) => !away.has(id)),
      },
      now,
    );
    return { absence, lesson, decisions, decision, absentOnLesson, isLive, derived };
  }

  /** Of these people, those with an ACTIVE absence overlapping the lesson. */
  private async absentAmong(
    tx: PrismaClient,
    userIds: readonly string[],
    lesson: { startsAt: Date; endsAt: Date },
  ): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows =
      (await tx.teacherAbsence.findMany({
        where: { userId: { in: [...userIds] }, status: 'ACTIVE', startsAt: { lt: lesson.endsAt }, endsAt: { gt: lesson.startsAt } },
        select: { userId: true },
      })) ?? [];
    return new Set(rows.map((row) => row.userId));
  }
}

export function merge(into: CoverEffects, from: CoverEffects): void {
  into.lessonIds.push(...from.lessonIds);
  into.dates.push(...from.dates);
  into.notices.push(...from.notices);
  into.warnings.push(...from.warnings);
}

/** from ≤ to, at most `days` days inclusive. */
export function checkWindow(from: string, to: string, days: number): void {
  if (to < from) {
    throw new BadRequestException({ message: 'to: tidigast samma dag som from.', code: COVER_RANGE });
  }
  if (dayDate(to).getTime() - dayDate(from).getTime() > (days - 1) * 86_400_000) {
    throw new BadRequestException({ message: `Högst ${days} dagar åt gången.`, code: COVER_RANGE });
  }
}

function held(): ConflictException {
  return new ConflictException({ message: 'Lektionen har redan hållits och ändras inte.', code: COVER_LESSON_HELD });
}

function started(): ConflictException {
  return new ConflictException({
    message: 'Lektionen har redan börjat och kan inte ställas in. Tillsätt en vikarie eller välj självstudier.',
    code: COVER_LESSON_STARTED,
  });
}

function stale(current: string): ConflictException {
  return new ConflictException({
    message: 'Lektionen har ändrats sedan tavlan lästes. Läs om tavlan.',
    code: COVER_STALE,
    // params: the one place the error filter lets a value through, scalars only.
    params: { current },
  });
}

function notAffected(): NotFoundException {
  return new NotFoundException({ message: 'Lektionen berörs inte av frånvaron.', code: COVER_NOT_AFFECTED });
}

/** A bulk or apply item's refusal, with the lesson it was about (in params, which the error filter passes). */
export function naming(error: unknown, lessonId: string): unknown {
  if (!(error instanceof HttpException)) return error;
  const body = error.getResponse();
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : { message: body };
  const params = typeof record.params === 'object' && record.params !== null ? (record.params as Record<string, unknown>) : {};
  return new HttpException({ ...record, params: { ...params, lessonId } }, error.getStatus());
}

