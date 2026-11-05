import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type AbsenceWatchBasis, type AbsenceWatchCadence, type AbsenceWatchGroup, type AbsenceWatchKind } from '@prisma/client';
import { recordRead } from '../access-log/access-log';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import { FINDINGS_LIMIT, RECENT_DAYS } from './absence-watch';
import type { AbsenceWatchFiguresDto, AbsenceWatchFindingsQueryDto, AbsenceWatchLimitDto, AbsenceWatchSettingsDto } from './dto/absence-watch.dto';

export const ABSENCE_WATCH_FIGURES = 'ABSENCE_WATCH_FIGURES';
export const ABSENCE_WATCH_LIMIT_EXISTS = 'ABSENCE_WATCH_LIMIT_EXISTS';
export const ABSENCE_WATCH_LIMIT_NOT_FOUND = 'ABSENCE_WATCH_LIMIT_NOT_FOUND';

export interface AbsenceWatchLimitView {
  id: string;
  recipientGroup: AbsenceWatchGroup;
  kind: AbsenceWatchKind;
  basis: AbsenceWatchBasis;
  /** SHARE: the percent of the registered minutes. */
  percent: number | null;
  /** SHARE: the days the share is counted over. */
  windowDays: number | null;
  /** CONSECUTIVE: the skoldagar in a row. */
  consecutiveDays: number | null;
}

export interface AbsenceWatchSettingsView {
  enabled: boolean;
  /** ISO date the switch last went on; null if it never has. */
  enabledOn: string | null;
  cadence: Record<AbsenceWatchGroup, AbsenceWatchCadence>;
}

export interface AbsenceWatchOverview {
  settings: AbsenceWatchSettingsView;
  limits: AbsenceWatchLimitView[];
}

export interface AbsenceWatchFindingView {
  id: string;
  studentId: string;
  /** "Förnamn Efternamn"; null when the reader may not read the pupil's row. */
  studentName: string | null;
  className: string | null;
  recipientGroup: AbsenceWatchGroup;
  kind: AbsenceWatchKind;
  basis: AbsenceWatchBasis;
  percent: number | null;
  windowDays: number | null;
  consecutiveDays: number | null;
  /** ISO dates. clearedOn is null while the pupil is over the limit. */
  firstCrossedOn: string;
  lastSeenOn: string;
  clearedOn: string | null;
  /** SHARE: minutes absent of the minutes registered in the window. */
  absentMinutes: number | null;
  recordedMinutes: number | null;
  /** CONSECUTIVE: the run, in skoldagar. */
  streakDays: number | null;
}

export interface AbsenceWatchFindingsView {
  findings: AbsenceWatchFindingView[];
  /** True when more than FINDINGS_LIMIT findings matched and the oldest were left out. */
  truncated: boolean;
}

const isoDay = (value: Date) => value.toISOString().slice(0, 10);

const DEFAULT_CADENCE: Record<AbsenceWatchGroup, AbsenceWatchCadence> = {
  MENTOR: 'WEEKLY',
  REKTOR: 'WEEKLY',
  KANSLI: 'WEEKLY',
  GUARDIAN: 'MONTHLY',
};

/**
 * Frånvarobevakning: the school's limits, the switch, and the findings the
 * nightly job (absence-watch.job.ts) has made.
 *
 * WHO READS WHAT. The settings and the limits are the administrators' (Drift
 * writes them); the findings are read by the three kinds of reader the
 * database's arms admit, each its own: every administrator all of them, a
 * teacher those of the MENTOR limits for the classes they mentor, a guardian
 * those of the GUARDIAN limits for their own child. The gateway does not
 * choose among them: it asks the table under the reader's own principal and
 * records what it hands out, because the gateway is the only way these rows
 * reach anyone (every arm is TO app_authenticated).
 */
@Injectable()
export class AbsenceWatchService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(user: AuthenticatedUser): Promise<AbsenceWatchOverview> {
    requireSchoolId(user);
    return this.prisma.withRls(user, (tx) => this.read(tx));
  }

  async updateSettings(dto: AbsenceWatchSettingsDto, user: AuthenticatedUser): Promise<AbsenceWatchOverview> {
    const schoolId = requireSchoolId(user);
    const data = {
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      ...(dto.mentorCadence ? { mentorCadence: dto.mentorCadence } : {}),
      ...(dto.rektorCadence ? { rektorCadence: dto.rektorCadence } : {}),
      ...(dto.kansliCadence ? { kansliCadence: dto.kansliCadence } : {}),
      ...(dto.guardianCadence ? { guardianCadence: dto.guardianCadence } : {}),
    };
    return this.prisma.withRls(user, async (tx) => {
      await tx.absenceWatchSetting.upsert({
        where: { schoolId },
        create: { schoolId, ...data },
        update: data,
      });
      return this.read(tx);
    });
  }

  async createLimit(dto: AbsenceWatchLimitDto, user: AuthenticatedUser): Promise<AbsenceWatchLimitView> {
    const schoolId = requireSchoolId(user);
    const figures = figuresOf(dto.kind, dto);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const row = await tx.absenceWatchLimit.create({
          data: { schoolId, recipientGroup: dto.recipientGroup, kind: dto.kind, basis: dto.basis, ...figures },
        });
        return limitView(row);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({ code: ABSENCE_WATCH_LIMIT_EXISTS, message: 'The school already has a limit for that group, kind and basis.' });
      }
      throw error;
    }
  }

  /** Changes a limit's figures. Its group, kind and basis are what its findings belong to: another is a new limit. */
  async updateLimit(id: string, dto: AbsenceWatchFiguresDto, user: AuthenticatedUser): Promise<AbsenceWatchLimitView> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const existing = await tx.absenceWatchLimit.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException({ code: ABSENCE_WATCH_LIMIT_NOT_FOUND, message: 'No such limit.' });
      const row = await tx.absenceWatchLimit.update({ where: { id }, data: figuresOf(existing.kind, dto) });
      return limitView(row);
    });
  }

  /** Removes a limit; its open findings are closed by the database in the same transaction. */
  async deleteLimit(id: string, user: AuthenticatedUser): Promise<void> {
    requireSchoolId(user);
    await this.prisma.withRls(user, async (tx) => {
      const { count } = await tx.absenceWatchLimit.deleteMany({ where: { id } });
      if (count === 0) throw new NotFoundException({ code: ABSENCE_WATCH_LIMIT_NOT_FOUND, message: 'No such limit.' });
    });
  }

  /**
   * The findings the reader's principal sees, newest crossing first: the open
   * ones, and with `recent` the ones closed in the last RECENT_DAYS too (the
   * pupils who came back under, and since when they had passed). The read is
   * recorded in the read log inside its own transaction, as ATTENDANCE (the
   * figures are the pupil's attendance in minutes and days) and PEOPLE (the
   * name), about every pupil handed out; the reader's own id never counts.
   */
  async findings(query: AbsenceWatchFindingsQueryDto, user: AuthenticatedUser, now: Date = new Date()): Promise<AbsenceWatchFindingsView> {
    requireSchoolId(user);
    const since = new Date(now.getTime() - RECENT_DAYS * 86_400_000);
    return this.prisma.withRls(user, async (tx) => {
      const rows = await tx.absenceWatchFinding.findMany({
        where: query.recent ? { OR: [{ clearedOn: null }, { clearedOn: { gte: since } }] } : { clearedOn: null },
        orderBy: [{ firstCrossedOn: 'desc' }, { id: 'asc' }],
        take: FINDINGS_LIMIT + 1,
        include: { student: { select: { firstName: true, lastName: true, studentGroup: { select: { name: true } } } } },
      });
      const truncated = rows.length > FINDINGS_LIMIT;
      const shown = truncated ? rows.slice(0, FINDINGS_LIMIT) : rows;
      const pupils = shown.map((row) => row.studentId);
      await recordRead(tx, 'ATTENDANCE', pupils, user.channel);
      await recordRead(tx, 'PEOPLE', pupils, user.channel);
      return {
        truncated,
        findings: shown.map((row) => ({
          id: row.id,
          studentId: row.studentId,
          studentName: row.student ? `${row.student.firstName} ${row.student.lastName}` : null,
          className: row.student?.studentGroup?.name ?? null,
          recipientGroup: row.recipientGroup,
          kind: row.kind,
          basis: row.basis,
          percent: row.percent,
          windowDays: row.windowDays,
          consecutiveDays: row.consecutiveDays,
          firstCrossedOn: isoDay(row.firstCrossedOn),
          lastSeenOn: isoDay(row.lastSeenOn),
          clearedOn: row.clearedOn ? isoDay(row.clearedOn) : null,
          absentMinutes: row.absentMinutes,
          recordedMinutes: row.recordedMinutes,
          streakDays: row.streakDays,
        })),
      };
    });
  }

  private async read(tx: Prisma.TransactionClient): Promise<AbsenceWatchOverview> {
    const [settings, limits] = await Promise.all([
      tx.absenceWatchSetting.findFirst(),
      tx.absenceWatchLimit.findMany({ orderBy: [{ recipientGroup: 'asc' }, { kind: 'asc' }, { basis: 'asc' }] }),
    ]);
    return {
      settings: {
        enabled: settings?.enabled ?? false,
        enabledOn: settings?.enabledOn ? isoDay(settings.enabledOn) : null,
        cadence: settings
          ? {
              MENTOR: settings.mentorCadence,
              REKTOR: settings.rektorCadence,
              KANSLI: settings.kansliCadence,
              GUARDIAN: settings.guardianCadence,
            }
          : { ...DEFAULT_CADENCE },
      },
      limits: limits.map(limitView),
    };
  }
}

function limitView(row: {
  id: string;
  recipientGroup: AbsenceWatchGroup;
  kind: AbsenceWatchKind;
  basis: AbsenceWatchBasis;
  percent: number | null;
  windowDays: number | null;
  consecutiveDays: number | null;
}): AbsenceWatchLimitView {
  return {
    id: row.id,
    recipientGroup: row.recipientGroup,
    kind: row.kind,
    basis: row.basis,
    percent: row.percent,
    windowDays: row.windowDays,
    consecutiveDays: row.consecutiveDays,
  };
}

/**
 * The figures a limit of this kind carries: a share needs percent and windowDays
 * and may not carry days in a row, a run the reverse. The CHECK in the database
 * says the same; this answers first, naming the field.
 */
export function figuresOf(
  kind: AbsenceWatchKind,
  figures: AbsenceWatchFiguresDto,
): { percent: number | null; windowDays: number | null; consecutiveDays: number | null } {
  const bad = (message: string) => new BadRequestException({ code: ABSENCE_WATCH_FIGURES, message });
  // A figure that is null is a figure that is not given: a form sends null for the
  // field its kind does not use, and a share without its percent is not one.
  const given = (value: number | null | undefined): value is number => value !== undefined && value !== null;
  if (kind === 'SHARE') {
    if (!given(figures.percent) || !given(figures.windowDays)) throw bad('A share limit has a percent and a number of days.');
    if (given(figures.consecutiveDays)) throw bad('A share limit has no days in a row.');
    return { percent: figures.percent, windowDays: figures.windowDays, consecutiveDays: null };
  }
  if (!given(figures.consecutiveDays)) throw bad('A limit of days in a row has a number of days.');
  if (given(figures.percent) || given(figures.windowDays)) throw bad('A limit of days in a row has no percent or window.');
  return { percent: null, windowDays: null, consecutiveDays: figures.consecutiveDays };
}
