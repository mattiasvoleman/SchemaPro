import { BadRequestException, ForbiddenException, HttpException, Injectable } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../common/utils/request-context';
import { sqlStateOf } from '../cover/cover-errors';
import { PrismaService } from '../database/prisma.service';
import type { RetentionDecisionDto, RetentionPreviewQueryDto } from './dto/gallring.dto';
import {
  DECISION_WAIT_MS,
  firstNightFor,
  GALLRING_HOUR_LOCAL,
  RETENTION_DATA_TYPES,
  type RetentionDataTypeValue,
  type RetentionDecisionValue,
} from './retention';

export const RETENTION_MONTHS_ONLY_FOR_A_PERIOD = 'RETENTION_MONTHS_ONLY_FOR_A_PERIOD';
export const RETENTION_PREVIEW_IS_THE_ADMINS = 'RETENTION_PREVIEW_IS_THE_ADMINS';
export const RETENTION_INVALID = 'RETENTION_INVALID';

export interface RetentionPreview {
  /** ISO date: rows dated before it go. */
  cutoff: string;
  /** Rows (or people) a period would take today. */
  due: number;
  /** DEPARTED_PEOPLE only: people past the period that SCB's 15 October rule holds back. */
  held: number;
}

export interface RetentionDecisionView {
  dataType: RetentionDataTypeValue;
  decision: RetentionDecisionValue;
  months: number | null;
  reference: string | null;
  decidedAt: string;
  /** "Förnamn Efternamn", or null once the decider's row is gone. */
  decidedBy: string | null;
}

export interface RetentionKindView {
  dataType: RetentionDataTypeValue;
  /** The latest decision; null is ej beslutat. */
  current: RetentionDecisionView | null;
  /** For a period younger than 24 hours: the first night (ISO date, "natten mot") it can take more than before. */
  waitsUntil: string | null;
  /** For a period: what it would take today. */
  preview: RetentionPreview | null;
  /** ISO date: everything of the kind dated before it is gone (a run that took it all). */
  purgedBefore: string | null;
}

export interface GallringRunView {
  startedAt: string;
  finishedAt: string | null;
  status: 'RUNNING' | 'DONE' | 'INTERRUPTED';
  /** Months applied per kind. */
  periods: Record<string, number>;
  cutoffs: Record<string, string>;
  counts: Record<string, number>;
  complete: Record<string, boolean>;
  waiting: Record<string, number>;
}

export interface RetentionOverview {
  timezone: string;
  /** Runs start at this local hour. */
  nightlyHour: number;
  kinds: RetentionKindView[];
  /** Newest first, at most 20. */
  runs: GallringRunView[];
  /** Every decision recorded, newest first, at most 100. */
  history: RetentionDecisionView[];
}

export interface PurgedBeforeView {
  dataType: RetentionDataTypeValue;
  purgedBefore: string;
}

const isoDay = (value: Date) => value.toISOString().slice(0, 10);

/**
 * /admin/dataskydd: the school's retention decisions, what each period would
 * take, the runs as evidence, and the "gallrat före" dates the reports show.
 *
 * Everything runs under the caller's own principal (withRls): row security
 * gives an administrator the school's decisions and runs and nobody else
 * anything, app.gallring_preview answers only the school's SCHOOL_ADMIN
 * (GL403), and app.retention_purged_before answers any active user about
 * their own school, dates only. Nothing here removes a row: that is the
 * night's (GallringJob), and a new decision that gallrar more waits a day.
 */
@Injectable()
export class GallringService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(user: AuthenticatedUser): Promise<RetentionOverview> {
    const schoolId = requireSchoolId(user);
    return this.mapped(() => this.prisma.withRls(user, (tx) => this.read(tx, schoolId)));
  }

  async preview(query: RetentionPreviewQueryDto, user: AuthenticatedUser): Promise<RetentionPreview> {
    requireSchoolId(user);
    return this.mapped(() => this.prisma.withRls(user, (tx) => this.previewIn(tx, query.dataType, query.months)));
  }

  /** Records one decision for one kind and answers the page as it now stands. */
  async decide(dto: RetentionDecisionDto, user: AuthenticatedUser): Promise<RetentionOverview> {
    const schoolId = requireSchoolId(user);
    if (dto.decision !== 'PURGE_AFTER' && dto.months !== undefined) {
      throw new BadRequestException({
        message: 'Bara en gallringsperiod har ett antal månader.',
        code: RETENTION_MONTHS_ONLY_FOR_A_PERIOD,
      });
    }
    return this.mapped(() =>
      this.prisma.withRls(user, async (tx) => {
        await tx.retentionDecision.create({
          data: {
            schoolId,
            dataType: dto.dataType,
            decision: dto.decision,
            months: dto.decision === 'PURGE_AFTER' ? (dto.months ?? null) : null,
            reference: dto.reference ?? null,
          },
          select: { id: true },
        });
        return this.read(tx, schoolId);
      }),
    );
  }

  /** "Gallrat före" per kind, for any role's reports. Dates only. */
  async purgedBefore(user: AuthenticatedUser): Promise<PurgedBeforeView[]> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ data_type: RetentionDataTypeValue; purged_before: Date }>>(
        Prisma.sql`SELECT data_type, purged_before FROM app.retention_purged_before()`,
      );
      return (rows ?? [])
        .map((row) => ({ dataType: row.data_type, purgedBefore: isoDay(row.purged_before) }))
        .sort((a, b) => RETENTION_DATA_TYPES.indexOf(a.dataType) - RETENTION_DATA_TYPES.indexOf(b.dataType));
    });
  }

  private async read(tx: PrismaClient, schoolId: string): Promise<RetentionOverview> {
    const [school, decisions, runs, purged] = await Promise.all([
      tx.school.findUnique({ where: { id: schoolId }, select: { timezone: true } }),
      tx.retentionDecision.findMany({ orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }], take: 100 }),
      tx.gallringRun.findMany({ orderBy: { startedAt: 'desc' }, take: 20 }),
      tx.$queryRaw<Array<{ data_type: RetentionDataTypeValue; purged_before: Date }>>(
        Prisma.sql`SELECT data_type, purged_before FROM app.retention_purged_before()`,
      ),
    ]);
    const timezone = school?.timezone ?? 'Europe/Stockholm';
    const deciders = [...new Set(decisions.map((d) => d.decidedById).filter((id): id is string => id !== null))];
    const people = deciders.length
      ? await tx.user.findMany({ where: { id: { in: deciders } }, select: { id: true, firstName: true, lastName: true } })
      : [];
    const nameOf = new Map(people.map((p) => [p.id, `${p.firstName} ${p.lastName}`.trim()]));
    const view = (d: (typeof decisions)[number]): RetentionDecisionView => ({
      dataType: d.dataType,
      decision: d.decision,
      months: d.months,
      reference: d.reference,
      decidedAt: d.decidedAt.toISOString(),
      decidedBy: d.decidedById ? (nameOf.get(d.decidedById) ?? null) : null,
    });
    const purgedOf = new Map((purged ?? []).map((row) => [row.data_type, isoDay(row.purged_before)]));
    const now = Date.now();

    const kinds: RetentionKindView[] = [];
    for (const dataType of RETENTION_DATA_TYPES) {
      const [latest = null, previous = null] = decisions.filter((d) => d.dataType === dataType);
      const period = latest?.decision === 'PURGE_AFTER' && latest.months !== null ? latest.months : null;
      // A period that takes more than the one before it waits a day; one that
      // takes less (a longer period) applies at once.
      const takesMore =
        period !== null && (previous?.decision !== 'PURGE_AFTER' || previous.months === null || period < previous.months);
      kinds.push({
        dataType,
        current: latest ? view(latest) : null,
        waitsUntil:
          latest && takesMore && now - latest.decidedAt.getTime() < DECISION_WAIT_MS
            ? firstNightFor(latest.decidedAt, timezone)
            : null,
        // Counted one kind after another: the preview's counts read the
        // whole school's rows, and seven at once would hold seven of the
        // pool's connections' worth of work in one request.
        preview: period !== null ? await this.previewIn(tx, dataType, period) : null,
        purgedBefore: purgedOf.get(dataType) ?? null,
      });
    }

    return {
      timezone,
      nightlyHour: GALLRING_HOUR_LOCAL,
      kinds,
      runs: runs.map((run) => ({
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
        status: run.status,
        periods: run.periods as Record<string, number>,
        cutoffs: run.cutoffs as Record<string, string>,
        counts: run.counts as Record<string, number>,
        complete: run.complete as Record<string, boolean>,
        waiting: run.waiting as Record<string, number>,
      })),
      history: decisions.map(view),
    };
  }

  private async previewIn(tx: PrismaClient, dataType: RetentionDataTypeValue, months: number): Promise<RetentionPreview> {
    const [row] = await tx.$queryRaw<Array<{ cutoff: Date; due: bigint; held: bigint }>>(
      Prisma.sql`SELECT cutoff, due, held FROM app.gallring_preview(${dataType}::"RetentionDataType", ${months}::integer)`,
    );
    return {
      cutoff: row ? isoDay(row.cutoff) : '',
      due: Number(row?.due ?? 0),
      held: Number(row?.held ?? 0),
    };
  }

  /** The database's refusals as coded answers: GL403 (not the admin), GL400 and CHECKs (a value out of range). */
  private async mapped<T>(body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const state = sqlStateOf(error);
      if (state === 'GL403' || state === '42501') {
        throw new ForbiddenException({
          message: 'Bara skolans administratör ser och bestämmer gallringen.',
          code: RETENTION_PREVIEW_IS_THE_ADMINS,
        });
      }
      if (state === 'GL400' || state === '23514') {
        throw new BadRequestException({ message: 'Perioden måste vara 1–120 månader.', code: RETENTION_INVALID });
      }
      throw error;
    }
  }
}
