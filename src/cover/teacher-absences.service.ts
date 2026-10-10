import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role } from '../auth/enums/role.enum';
import { requireSchoolId, requireUserId } from '../common/utils/request-context';
import { todayInZone, zonedTimeToUtc } from '../common/utils/time';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { enterGrundschemaWrite } from '../publication/publish-mode';
import { RealtimeService } from '../realtime/realtime.service';
import { pairsStatement, toBoardItem, type PairRow } from './cover-board';
import { asDay, dayDate, localDateOf, schoolTimezone, shiftDay } from './cover-context';
import { lockLessons, lockTeachers } from './cover-decisions';
import { ABSENCE_OVERLAPS, ABSENCE_SELF_REPORT_OFF, rethrowCoverError } from './cover-errors';
import { CoverService, emptyEffects, merge, type CoverEffects } from './cover.service';
import type { CreateAbsenceDto, EndAbsenceDto, ListAbsencesQueryDto, UpdateAbsenceDto } from './dto/cover.dto';

export const ABSENCE_RANGE = 'ABSENCE_RANGE';
export const ABSENCE_TOO_FAR_BACK = 'ABSENCE_TOO_FAR_BACK';
export const ABSENCE_NOT_YOURS = 'ABSENCE_NOT_YOURS';
export const ABSENCE_PERSON = 'ABSENCE_PERSON';
export const ABSENCE_REASON = 'ABSENCE_REASON';
export const ABSENCE_HAS_DECISIONS = 'ABSENCE_HAS_DECISIONS';
export const ABSENCE_HAS_HELD_DECISIONS = 'ABSENCE_HAS_HELD_DECISIONS';
export const ABSENCE_WITHDRAWN = 'ABSENCE_WITHDRAWN';
export const ABSENCE_WITHDRAW_TOO_LATE = 'ABSENCE_WITHDRAW_TOO_LATE';
export const ABSENCE_END = 'ABSENCE_END';

/** Half a year of school-local days, inclusive (the CHECK allows the DST hour on top). */
export const MAX_ABSENCE_DAYS = 186;
/** How far back an admin may register an absence. */
export const ADMIN_BACKDATE_DAYS = 30;
/** How long a teacher may take back their own registration once it has started. */
export const SELF_WITHDRAW_MINUTES = 60;

export type AbsencePhase = 'PLANNED' | 'ONGOING' | 'ENDED' | 'WITHDRAWN';

export interface AbsenceView {
  id: string;
  userId: string;
  startsAt: string;
  endsAt: string;
  wholeDays: boolean;
  /** Read only by the admin and the absent teacher (RLS); never anywhere else. */
  reasonId: string | null;
  status: 'ACTIVE' | 'WITHDRAWN';
  phase: AbsencePhase;
  selfReported: boolean;
  createdAt: string;
  counts: { open: number; covered: number; cancelled: number; handled: number; passedOpen: number };
}

const ABSENCE_SELECT = {
  id: true,
  userId: true,
  startsAt: true,
  endsAt: true,
  wholeDays: true,
  reasonId: true,
  status: true,
  createdByUserId: true,
  createdAt: true,
} as const;

type AbsenceRow = Prisma.TeacherAbsenceGetPayload<{ select: typeof ABSENCE_SELECT }>;

const BUILTINS = ['SICK', 'CHILD_CARE', 'WORK_TRAVEL', 'PROFESSIONAL_DEVELOPMENT', 'OTHER'] as const;

/**
 * The school's five categories, inserted the first time somebody needs them:
 * an admin listing the reasons or registering an absence, or turning
 * self-report on. Idempotent on the partial unique index; no migration writes
 * them, so a school that never uses the feature has no rows.
 */
export async function ensureDefaultReasons(tx: PrismaClient, schoolId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "TeacherAbsenceReasons" ("schoolId", "builtin", "sortOrder")
    SELECT ${schoolId}::uuid, b::"AbsenceReasonBuiltin", (o * 10)::int
      FROM unnest(${[...BUILTINS]}::text[]) WITH ORDINALITY AS u(b, o)
    ON CONFLICT ("schoolId", "builtin") WHERE "builtin" IS NOT NULL DO NOTHING`);
}

/**
 * Teacher absences (20261012090000): register, list, edit, end early,
 * withdraw. Admins do all of it; a teacher, for themself only and only when
 * the school allows self-report — and the database decides that too (RLS and
 * the guard trigger), this service only answers first and more clearly.
 *
 * The REASON is in the list response alone, which RLS gives to the admin and
 * the absent teacher. No notice, broadcast, log line or board row carries it;
 * logs carry absence and lesson ids.
 */
@Injectable()
export class TeacherAbsencesService {
  private readonly logger = new Logger(TeacherAbsencesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
    private readonly cover: CoverService,
  ) {}

  async list(query: ListAbsencesQueryDto, user: AuthenticatedUser): Promise<AbsenceView[]> {
    const schoolId = requireSchoolId(user);
    const now = this.cover.now();
    return this.prisma.withRls(user, async (tx) => {
      const timezone = await schoolTimezone(tx, schoolId);
      const includeEnded = query.includeEnded === 'true';
      // Current and coming by default; with includeEnded, ended and
      // withdrawn ones too. from/to narrow to absences touching those days.
      const after = [
        includeEnded ? null : now,
        query.from ? zonedTimeToUtc(query.from, '00:00', timezone) : null,
      ].filter((value): value is Date => value !== null);
      const where: Prisma.TeacherAbsenceWhereInput = {
        ...(query.userId ? { userId: query.userId } : {}),
        ...(includeEnded ? {} : { status: 'ACTIVE' as const }),
        ...(after.length > 0 ? { endsAt: { gt: new Date(Math.max(...after.map((value) => value.getTime()))) } } : {}),
        ...(query.to ? { startsAt: { lt: zonedTimeToUtc(shiftDay(query.to, 1), '00:00', timezone) } } : {}),
      };
      const rows = await tx.teacherAbsence.findMany({ where, select: ABSENCE_SELECT, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }] });
      const counts = await this.countsOf(
        tx,
        rows.filter((row) => row.status === 'ACTIVE').map((row) => row.id),
        now,
      );
      return rows.map((row) => viewOf(row, now, counts.get(row.id)));
    });
  }

  async create(dto: CreateAbsenceDto, user: AuthenticatedUser): Promise<AbsenceView> {
    const schoolId = requireSchoolId(user);
    const me = requireUserId(user);
    const isAdmin = user.role === Role.SCHOOL_ADMIN;
    if (!isAdmin && dto.userId !== me) {
      throw new ForbiddenException({ message: 'En lärare registrerar bara sin egen frånvaro.', code: ABSENCE_NOT_YOURS });
    }
    const now = this.cover.now();
    const row = await this.write(user, async (tx) => {
      const timezone = await schoolTimezone(tx, schoolId);
      if (isAdmin) {
        await ensureDefaultReasons(tx, schoolId);
      } else {
        const settings = await tx.coverSettings.findUnique({ where: { schoolId }, select: { teacherSelfReport: true } });
        if (!settings?.teacherSelfReport) throw selfReportOff();
      }
      const person = await tx.user.findUnique({ where: { id: dto.userId }, select: { id: true, role: true, isActive: true } });
      if (!person || !person.isActive || (person.role !== 'TEACHER' && person.role !== 'SCHOOL_ADMIN')) {
        throw new BadRequestException({ message: 'userId: frånvaro registreras för en aktiv lärare.', code: ABSENCE_PERSON });
      }
      await this.checkReason(tx, dto.reasonId ?? null);
      const period = periodOf(
        { from: dto.from, to: dto.to, startTime: dto.startTime ?? null, endTime: dto.endTime ?? null },
        timezone,
      );
      const today = asDay(todayInZone(timezone, now));
      if (isAdmin && dto.from < shiftDay(today, -ADMIN_BACKDATE_DAYS)) throw tooFarBack();
      if (!isAdmin && dto.from < today) {
        throw new BadRequestException({ message: 'from: en lärare anmäler frånvaro från i dag.', code: ABSENCE_TOO_FAR_BACK });
      }
      await lockTeachers(tx, [dto.userId]);
      await this.refuseOverlap(tx, dto.userId, period, null);
      return tx.teacherAbsence.create({
        data: {
          schoolId,
          userId: dto.userId,
          startsAt: period.startsAt,
          endsAt: period.endsAt,
          wholeDays: period.wholeDays,
          reasonId: dto.reasonId ?? null,
          createdByUserId: me,
        },
        select: ABSENCE_SELECT,
      });
    });
    this.logger.log(`Absence registered [absence=${row.id}]`);
    if (!isAdmin) await this.tellAdmins(user, row);
    await this.boardChanged(user, row.startsAt, row.endsAt);
    return viewOf(row, now, undefined);
  }

  async update(id: string, dto: UpdateAbsenceDto, user: AuthenticatedUser): Promise<AbsenceView> {
    const schoolId = requireSchoolId(user);
    const now = this.cover.now();
    let before: { startsAt: Date; endsAt: Date } | null = null;
    const { row, effects } = await this.write(user, async (tx) => {
      await enterGrundschemaWrite(tx, schoolId);
      const current = await this.requireAbsence(tx, id);
      if (current.status !== 'ACTIVE') throw withdrawn();
      before = { startsAt: current.startsAt, endsAt: current.endsAt };
      const timezone = await schoolTimezone(tx, schoolId);
      const fields = fieldsOf(current, timezone);
      const merged = {
        from: dto.from ?? fields.from,
        to: dto.to ?? fields.to,
        startTime: dto.startTime !== undefined ? dto.startTime : fields.startTime,
        endTime: dto.endTime !== undefined ? dto.endTime : fields.endTime,
      };
      const period = periodOf(merged, timezone);
      const today = asDay(todayInZone(timezone, now));
      if (dto.from !== undefined && dto.from !== fields.from && dto.from < shiftDay(today, -ADMIN_BACKDATE_DAYS)) {
        throw tooFarBack();
      }
      if (dto.reasonId !== undefined) await this.checkReason(tx, dto.reasonId);
      await lockTeachers(tx, [current.userId]);
      await this.refuseOverlap(tx, current.userId, period, id);
      const effects = await this.settleDecisionsOutside(tx, user, id, period, Boolean(dto.undoDecisionsOutside), now);
      const row = await tx.teacherAbsence.update({
        where: { id },
        data: {
          startsAt: period.startsAt,
          endsAt: period.endsAt,
          wholeDays: period.wholeDays,
          ...(dto.reasonId !== undefined ? { reasonId: dto.reasonId } : {}),
        },
        select: ABSENCE_SELECT,
      });
      return { row, effects };
    });
    await this.cover.afterCommit(user, effects);
    this.logger.log(`Absence changed [absence=${id}]`);
    const span = before as { startsAt: Date; endsAt: Date } | null;
    await this.boardChanged(
      user,
      span && span.startsAt < row.startsAt ? span.startsAt : row.startsAt,
      span && span.endsAt > row.endsAt ? span.endsAt : row.endsAt,
    );
    return viewOf(row, now, undefined);
  }

  /**
   * "Avsluta i förtid". An admin may end it in the past, but not before it
   * started ("came back yesterday"); a teacher not before now. Never later
   * than it was.
   */
  async end(id: string, dto: EndAbsenceDto, user: AuthenticatedUser): Promise<AbsenceView> {
    const schoolId = requireSchoolId(user);
    const isAdmin = user.role === Role.SCHOOL_ADMIN;
    const now = this.cover.now();
    const at = new Date(dto.at);
    if (Number.isNaN(at.getTime())) throw new BadRequestException({ message: 'at: en giltig tidpunkt.', code: ABSENCE_END });
    let before: Date | null = null;
    const { row, effects } = await this.write(user, async (tx) => {
      if (isAdmin) await enterGrundschemaWrite(tx, schoolId);
      const current = await this.requireAbsence(tx, id);
      if (current.status !== 'ACTIVE') throw withdrawn();
      if (!isAdmin) await this.requireSelfReport(tx, schoolId);
      before = current.endsAt;
      // A teacher's end is never before now (the guard trigger says the same
      // against the database's clock, so "now" here is a minute ahead of it).
      const endsAt = isAdmin ? at : new Date(Math.max(at.getTime(), now.getTime() + 60_000));
      if (endsAt.getTime() >= current.endsAt.getTime()) {
        throw new BadRequestException({ message: 'at: frånvaron kan bara avslutas tidigare än den slutar.', code: ABSENCE_END });
      }
      if (endsAt.getTime() <= current.startsAt.getTime()) {
        throw new BadRequestException({
          message: 'at: frånvaron har inte börjat då. Återkalla den i stället.',
          code: ABSENCE_END,
        });
      }
      await lockTeachers(tx, [current.userId]);
      const effects = await this.settleDecisionsOutside(
        tx,
        user,
        id,
        { startsAt: current.startsAt, endsAt, wholeDays: current.wholeDays },
        Boolean(dto.undoDecisions) && isAdmin,
        now,
      );
      const row = await tx.teacherAbsence.update({ where: { id }, data: { endsAt }, select: ABSENCE_SELECT });
      return { row, effects };
    });
    await this.cover.afterCommit(user, effects);
    this.logger.log(`Absence ended early [absence=${id}]`);
    await this.boardChanged(user, row.endsAt, (before as Date | null) ?? row.endsAt);
    return viewOf(row, now, undefined);
  }

  /**
   * "Registrerad av misstag". A teacher: before it starts, or within an hour
   * of registering it while nothing has been decided on it. Never when a
   * decision sits on a lesson already held (use Avsluta), and only with
   * `undoDecisions` when decisions sit on lessons still ahead.
   */
  async withdraw(id: string, undoDecisions: boolean, user: AuthenticatedUser): Promise<AbsenceView> {
    const schoolId = requireSchoolId(user);
    const me = requireUserId(user);
    const isAdmin = user.role === Role.SCHOOL_ADMIN;
    const now = this.cover.now();
    const { row, effects } = await this.write(user, async (tx) => {
      if (isAdmin) await enterGrundschemaWrite(tx, schoolId);
      const current = await this.requireAbsence(tx, id);
      if (current.status !== 'ACTIVE') throw withdrawn();
      const decisions = await tx.teacherAbsenceCover.findMany({
        where: { absenceId: id },
        select: { calendarLessonId: true, decision: true },
      });
      if (!isAdmin) {
        await this.requireSelfReport(tx, schoolId);
        const early = current.startsAt.getTime() > now.getTime();
        const fresh = now.getTime() - current.createdAt.getTime() <= SELF_WITHDRAW_MINUTES * 60_000 && decisions.length === 0;
        if (!early && !fresh) {
          throw new ConflictException({
            message: 'Frånvaron har börjat. Avsluta den i förtid i stället.',
            code: ABSENCE_WITHDRAW_TOO_LATE,
          });
        }
      }
      await lockTeachers(tx, [current.userId]);
      const effects = await this.settleDecisionsOutside(
        tx,
        user,
        id,
        null,
        undoDecisions && isAdmin,
        now,
      );
      const row = await tx.teacherAbsence.update({
        where: { id },
        data: { status: 'WITHDRAWN', withdrawnAt: now, withdrawnByUserId: me },
        select: ABSENCE_SELECT,
      });
      return { row, effects };
    });
    await this.cover.afterCommit(user, effects);
    this.logger.log(`Absence withdrawn [absence=${id}]`);
    await this.boardChanged(user, row.startsAt, row.endsAt);
    return viewOf(row, now, undefined);
  }

  // ---------------------------------------------------------------------

  /**
   * The decisions a new period leaves behind (null = all of them, for a
   * withdrawal): a held one refuses a withdrawal outright and stays with an
   * edit (outsideAbsence on the board); one still ahead is a 409 listing
   * them, or is undone here when asked.
   */
  private async settleDecisionsOutside(
    tx: PrismaClient,
    user: AuthenticatedUser,
    absenceId: string,
    period: { startsAt: Date; endsAt: Date; wholeDays: boolean } | null,
    undo: boolean,
    now: Date,
  ): Promise<CoverEffects> {
    const rows = await tx.teacherAbsenceCover.findMany({
      where: { absenceId },
      select: {
        calendarLessonId: true,
        decision: true,
      },
    });
    if (rows.length === 0) return emptyEffects();
    const lessons = await tx.calendarLesson.findMany({
      where: { id: { in: rows.map((row) => row.calendarLessonId) } },
      select: { id: true, startsAt: true, endsAt: true },
    });
    const lessonOf = new Map(lessons.map((lesson) => [lesson.id, lesson]));
    const outside = rows.filter((row) => {
      const lesson = lessonOf.get(row.calendarLessonId);
      if (!lesson) return false;
      if (period === null) return true;
      return !(lesson.startsAt < period.endsAt && lesson.endsAt > period.startsAt);
    });
    const held = outside.filter((row) => lessonOf.get(row.calendarLessonId)!.endsAt.getTime() <= now.getTime());
    if (period === null && held.length > 0) {
      throw new ConflictException({
        message: 'Beslut finns på lektioner som redan hållits. Avsluta frånvaron i förtid i stället.',
        code: ABSENCE_HAS_HELD_DECISIONS,
        params: paramsOf(held),
      });
    }
    const ahead = outside.filter((row) => lessonOf.get(row.calendarLessonId)!.endsAt.getTime() > now.getTime());
    if (ahead.length === 0) return emptyEffects();
    if (!undo) {
      throw new ConflictException({
        message: 'Det finns beslut på lektioner som inte längre ingår. Ångra dem, eller skicka undoDecisions.',
        code: ABSENCE_HAS_DECISIONS,
        params: paramsOf(ahead),
      });
    }
    // Undone newest first per lesson, under the lessons' locks.
    await lockLessons(tx, ahead.map((row) => row.calendarLessonId));
    const all = emptyEffects();
    for (const row of ahead) {
      merge(all, await this.cover.undoInTransaction(tx, { lessonId: row.calendarLessonId, absenceId }, user));
    }
    return all;
  }

  /** The derived counts of each absence's lessons, by the board's own statement. */
  private async countsOf(tx: PrismaClient, ids: string[], now: Date): Promise<Map<string, AbsenceView['counts']>> {
    const counts = new Map<string, AbsenceView['counts']>();
    if (ids.length === 0) return counts;
    const rows = (await tx.$queryRaw<PairRow[]>(pairsStatement({ kind: 'absences', ids }))) ?? [];
    for (const row of rows) {
      const item = toBoardItem(row, now);
      const entry = counts.get(item.absenceId) ?? { open: 0, covered: 0, cancelled: 0, handled: 0, passedOpen: 0 };
      if (item.status === 'OPEN') {
        if (item.passed) entry.passedOpen++;
        else entry.open++;
      } else if (item.status === 'COVERED') entry.covered++;
      else if (item.status === 'CANCELLED') entry.cancelled++;
      else entry.handled++;
      counts.set(item.absenceId, entry);
    }
    return counts;
  }

  private async refuseOverlap(
    tx: PrismaClient,
    userId: string,
    period: { startsAt: Date; endsAt: Date },
    except: string | null,
  ): Promise<void> {
    const other = await tx.teacherAbsence.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
        startsAt: { lt: period.endsAt },
        endsAt: { gt: period.startsAt },
        ...(except ? { id: { not: except } } : {}),
      },
      // The period of the other absence, never its reason.
      select: { id: true, startsAt: true, endsAt: true },
    });
    if (other) {
      throw new ConflictException({
        message: 'Läraren är redan registrerad som frånvarande under en del av perioden.',
        code: ABSENCE_OVERLAPS,
        params: { otherAbsenceId: other.id, startsAt: other.startsAt.toISOString(), endsAt: other.endsAt.toISOString() },
      });
    }
  }

  private async checkReason(tx: PrismaClient, reasonId: string | null): Promise<void> {
    if (reasonId === null) return;
    const reason = await tx.teacherAbsenceReason.findUnique({ where: { id: reasonId }, select: { archivedAt: true } });
    if (!reason || reason.archivedAt !== null) {
      throw new BadRequestException({ message: 'reasonId: orsaken finns inte i skolans lista.', code: ABSENCE_REASON });
    }
  }

  private async requireSelfReport(tx: PrismaClient, schoolId: string): Promise<void> {
    const settings = await tx.coverSettings.findUnique({ where: { schoolId }, select: { teacherSelfReport: true } });
    if (!settings?.teacherSelfReport) throw selfReportOff();
  }

  private async requireAbsence(tx: PrismaClient, id: string) {
    const row = await tx.teacherAbsence.findUnique({
      where: { id },
      select: { ...ABSENCE_SELECT, status: true },
    });
    if (!row) throw new NotFoundException('Frånvaron finns inte.');
    return row;
  }

  /** A self-report: the school's active admins are told, with the period and never the reason. */
  private async tellAdmins(user: AuthenticatedUser, row: AbsenceRow): Promise<void> {
    const schoolId = requireSchoolId(user);
    await this.prisma
      .withRls(user, async (tx) => {
        const admins = await tx.user.findMany({ where: { role: 'SCHOOL_ADMIN', isActive: true }, select: { id: true } });
        await this.notifications.notifyUsers(tx, {
          schoolId,
          userIds: admins.map((admin) => admin.id),
          type: 'TEACHER_ABSENCE_REPORTED',
          meta: { absenceId: row.id, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString() },
        });
      })
      .catch(() => this.logger.warn(`Absence report notice failed [absence=${row.id}]`));
  }

  private async boardChanged(user: AuthenticatedUser, from: Date, to: Date): Promise<void> {
    const schoolId = requireSchoolId(user);
    try {
      const timezone = await this.prisma.withRls(user, (tx) => schoolTimezone(tx, schoolId));
      const first = localDateOf(from, timezone);
      // The day of the last instant inside the period.
      const last = localDateOf(new Date(to.getTime() - 1), timezone);
      this.realtime.notifyCoverBoardChanged(schoolId, first, last < first ? first : last);
    } catch {
      this.logger.debug(`Cover board broadcast failed [school=${schoolId}]`);
    }
  }

  private async write<T>(user: AuthenticatedUser, body: (tx: PrismaClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.withRls(user, body, { timeoutMs: 60_000 });
    } catch (error) {
      rethrowCoverError(error);
    }
  }
}

/**
 * A period from the form: whole days from the school-local midnight of
 * `from` to the midnight after `to`; with times, `startTime` on the first day
 * and `endTime` on the last. The bounds of the DTO's comment, with the field
 * named.
 */
export function periodOf(
  input: { from: string; to: string; startTime: string | null; endTime: string | null },
  timezone: string,
): { startsAt: Date; endsAt: Date; wholeDays: boolean } {
  if (input.to < input.from) {
    throw new BadRequestException({ message: 'to: tidigast samma dag som from.', code: ABSENCE_RANGE });
  }
  const days = Math.round((dayDate(input.to).getTime() - dayDate(input.from).getTime()) / 86_400_000) + 1;
  if (days > MAX_ABSENCE_DAYS) {
    throw new BadRequestException({
      message: `Högst ${MAX_ABSENCE_DAYS} dagar. Längre frånvaro är en ändring i tjänstefördelningen.`,
      code: ABSENCE_RANGE,
    });
  }
  const startsAt = zonedTimeToUtc(input.from, input.startTime ?? '00:00', timezone);
  const endsAt = input.endTime
    ? zonedTimeToUtc(input.to, input.endTime, timezone)
    : zonedTimeToUtc(shiftDay(input.to, 1), '00:00', timezone);
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new BadRequestException({ message: 'endTime: efter startTime.', code: ABSENCE_RANGE });
  }
  return { startsAt, endsAt, wholeDays: input.startTime === null && input.endTime === null };
}

/** The form's fields back from a stored period (the inverse of periodOf). */
export function fieldsOf(
  row: { startsAt: Date; endsAt: Date },
  timezone: string,
): { from: string; to: string; startTime: string | null; endTime: string | null } {
  const clock = (instant: Date) =>
    new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant);
  const from = localDateOf(row.startsAt, timezone);
  const startClock = clock(row.startsAt);
  const endClock = clock(row.endsAt);
  return {
    from,
    startTime: startClock === '00:00' ? null : startClock,
    to: endClock === '00:00' ? shiftDay(localDateOf(row.endsAt, timezone), -1) : localDateOf(row.endsAt, timezone),
    endTime: endClock === '00:00' ? null : endClock,
  };
}

function viewOf(row: AbsenceRow, now: Date, counts: AbsenceView['counts'] | undefined): AbsenceView {
  const phase: AbsencePhase =
    row.status === 'WITHDRAWN'
      ? 'WITHDRAWN'
      : row.endsAt.getTime() <= now.getTime()
        ? 'ENDED'
        : row.startsAt.getTime() <= now.getTime()
          ? 'ONGOING'
          : 'PLANNED';
  return {
    id: row.id,
    userId: row.userId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    wholeDays: row.wholeDays,
    reasonId: row.reasonId,
    status: row.status,
    phase,
    selfReported: row.createdByUserId !== null && row.createdByUserId === row.userId,
    createdAt: row.createdAt.toISOString(),
    counts: counts ?? { open: 0, covered: 0, cancelled: 0, handled: 0, passedOpen: 0 },
  };
}

/**
 * The decisions a 409 names, as the error filter's scalar params: how many,
 * and the first lesson (the register opens the board on its day).
 */
function paramsOf(rows: { calendarLessonId: string; decision: string }[]): Record<string, string | number> {
  const first = [...rows].sort((a, b) => a.calendarLessonId.localeCompare(b.calendarLessonId))[0]!;
  return { count: rows.length, lessonId: first.calendarLessonId, decision: first.decision };
}

function selfReportOff(): ForbiddenException {
  return new ForbiddenException({
    message: 'Skolan låter inte lärare registrera sin egen frånvaro.',
    code: ABSENCE_SELF_REPORT_OFF,
  });
}

function tooFarBack(): BadRequestException {
  return new BadRequestException({
    message: `from: högst ${ADMIN_BACKDATE_DAYS} dagar bakåt.`,
    code: ABSENCE_TOO_FAR_BACK,
  });
}

function withdrawn(): ConflictException {
  return new ConflictException({ message: 'Frånvaron är återkallad.', code: ABSENCE_WITHDRAWN });
}
