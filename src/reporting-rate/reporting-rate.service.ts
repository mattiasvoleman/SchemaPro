import { Injectable } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { recordRead } from '../access-log/access-log';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId, requireUserId } from '../common/utils/request-context';
import { asDay, dayDate, isoWeekOf, shiftDay } from '../cover/cover-context';
import { PrismaService } from '../database/prisma.service';
import type { ReportingRateQueryDto, ReportingSettingsDto } from './dto/reporting-rate.dto';
import { DEFAULT_OPEN_AFTER_DAYS, DEFAULT_PERIOD, OPEN_LESSONS_DAYS, type ReportingPeriod } from './reporting-rate';

/** Held lessons, and how many of them have a saved register. */
export interface RateFigures {
  held: number;
  reported: number;
}

export interface ReportingRateTeacherView extends RateFigures {
  teacherId: string;
  firstName: string;
  lastName: string;
}

export interface ReportingRateView {
  period: ReportingPeriod;
  /** A day of the period shown (the school's today when none was asked for). */
  anchor: string;
  /** The period's first and last day, in the school's dates; null for a läsår the school has none of. */
  from: string | null;
  to: string | null;
  /** The läsår's name, for YEAR; null otherwise. */
  yearName: string | null;
  /** A day of the period before and the period after; null with no period. */
  previousAnchor: string | null;
  nextAnchor: string | null;
  /** The last day the school has figures for: the nightly count stops at yesterday. */
  through: string | null;
  total: RateFigures;
  /** The teachers with a held lesson in the period, the lowest share first. */
  teachers: ReportingRateTeacherView[];
}

export interface ReportingSettingsView {
  teacherReminders: boolean;
  rektorDigest: boolean;
  openAfterDays: number;
}

export interface OpenLessonView {
  lessonId: string;
  /** The lesson's day in the school's dates, YYYY-MM-DD. */
  date: string;
  startsAt: string;
  endsAt: string;
  subjectName: string;
  groupName: string;
  /** Stood open longer than the school's limit. */
  overdue: boolean;
}

export interface MyReportingView {
  openAfterDays: number;
  /** The teacher's own last stored day; null before the first night's count. */
  through: string | null;
  /** Newest first, as app.reporting_open_lessons answers. */
  open: OpenLessonView[];
  week: RateFigures & { from: string; to: string };
  month: RateFigures & { from: string; to: string };
  /** The läsår holding the school's today; null when the school has none. */
  year: (RateFigures & { name: string; from: string; to: string }) | null;
}

interface Range {
  from: string;
  to: string;
}

/** The calendar month holding a day, first to last, in the day's own dates. */
export function monthOf(day: string): Range {
  const [year, month] = day.split('-').map(Number) as [number, number];
  const first = `${day.slice(0, 7)}-01`;
  // Day 0 of the next month is the last of this one.
  return { from: first, to: asDay(new Date(Date.UTC(year, month, 0))) };
}

/** Lowest share first: a.reported/a.held < b.reported/b.held without a division, then by name, then by id. */
export function byShare(a: ReportingRateTeacherView, b: ReportingRateTeacherView): number {
  return (
    a.reported * b.held - b.reported * a.held ||
    a.lastName.localeCompare(b.lastName, 'sv') ||
    a.firstName.localeCompare(b.firstName, 'sv') ||
    a.teacherId.localeCompare(b.teacherId)
  );
}

const sums = (sum: { held?: number | null; reported?: number | null } | null | undefined): RateFigures => ({
  held: sum?.held ?? 0,
  reported: sum?.reported ?? 0,
});

/**
 * Rapporteringsgrad (20270112090100): what a teacher's lessons with a saved
 * register come to, from the days the nightly job (reporting-rate.job.ts)
 * has stored.
 *
 * WHO READS WHAT. The figures of every teacher are the administrators' (every
 * profile reads; Drift writes the switches and the limit), and the school's
 * limit is also a teacher's, because it is what their own list is measured by.
 * A teacher reads their own days, and their own open lessons through
 * app.reporting_open_lessons, which answers for the caller alone. The gateway
 * does not choose among them: it asks under the reader's own principal, and
 * records what it hands out of other people's, because the gateway is the
 * only way these rows reach anyone (every arm is TO app_authenticated).
 *
 * THE DAYS ARE ADDED UP IN THE DATABASE. A school's 90 days are some thirty
 * thousand rows; the view asks for one row per teacher (a groupBy of the
 * period) and never reads the days.
 */
@Injectable()
export class ReportingRateService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The share of held lessons with a saved register, for the school and per
   * teacher, over a week, a month or a läsår. The read is recorded in the read
   * log inside its own transaction, as EMPLOYMENT (how each person does their
   * post) and PEOPLE (the name), about every teacher handed out.
   */
  async overview(query: ReportingRateQueryDto, user: AuthenticatedUser, now: Date = new Date()): Promise<ReportingRateView> {
    const schoolId = requireSchoolId(user);
    const period = query.period ?? DEFAULT_PERIOD;
    return this.prisma.withRls(user, async (tx) => {
      const anchor = query.anchor ?? (await this.today(tx, now));
      const range = await this.rangeOf(tx, period, anchor);
      const [grouped, newest] = await Promise.all([
        range
          ? tx.teacherReportingDay.groupBy({
              by: ['teacherId'],
              where: { schoolId, day: { gte: dayDate(range.from), lte: dayDate(range.to) } },
              _sum: { held: true, reported: true },
            })
          : [],
        tx.teacherReportingDay.aggregate({ where: { schoolId }, _max: { day: true } }),
      ]);
      const counted = grouped.map((row) => ({ teacherId: row.teacherId, ...sums(row._sum) })).filter((row) => row.held > 0);
      const ids = counted.map((row) => row.teacherId);
      const people = ids.length > 0 ? await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } }) : [];
      const names = new Map(people.map((person) => [person.id, person]));
      const teachers = counted
        .map((row) => ({
          teacherId: row.teacherId,
          firstName: names.get(row.teacherId)?.firstName ?? '',
          lastName: names.get(row.teacherId)?.lastName ?? '',
          held: row.held,
          reported: row.reported,
        }))
        .sort(byShare);
      await recordRead(tx, 'EMPLOYMENT', ids, user.channel);
      await recordRead(tx, 'PEOPLE', ids, user.channel);
      return {
        period,
        anchor,
        from: range?.from ?? null,
        to: range?.to ?? null,
        yearName: range && 'name' in range ? range.name : null,
        previousAnchor: range ? shiftDay(range.from, -1) : null,
        nextAnchor: range ? shiftDay(range.to, 1) : null,
        through: newest._max.day ? asDay(newest._max.day) : null,
        total: counted.reduce<RateFigures>((total, row) => ({ held: total.held + row.held, reported: total.reported + row.reported }), { held: 0, reported: 0 }),
        teachers,
      };
    });
  }

  async settings(user: AuthenticatedUser): Promise<ReportingSettingsView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, (tx) => this.readSettings(tx, schoolId));
  }

  /**
   * Saves what the request names; a field left out, or sent as null, keeps its
   * value. A save that names nothing writes nothing: it answers what is stored,
   * and no row is made for a school that has chosen nothing (no row already
   * says both switches off and two days).
   */
  async updateSettings(dto: ReportingSettingsDto, user: AuthenticatedUser): Promise<ReportingSettingsView> {
    const schoolId = requireSchoolId(user);
    const data = {
      ...(dto.teacherReminders != null ? { teacherReminders: dto.teacherReminders } : {}),
      ...(dto.rektorDigest != null ? { rektorDigest: dto.rektorDigest } : {}),
      ...(dto.openAfterDays != null ? { openAfterDays: dto.openAfterDays } : {}),
    };
    if (Object.keys(data).length === 0) return this.settings(user);
    return this.prisma.withRls(user, async (tx) => {
      await tx.reportingSetting.upsert({ where: { schoolId }, create: { schoolId, ...data }, update: data });
      return this.readSettings(tx, schoolId);
    });
  }

  /**
   * A teacher's own view: the lessons that wait for their register, and their
   * share this week, this month and this läsår (the periods holding the
   * school's today). Their own days only, under the egen-arm; nothing is
   * recorded in the read log, because a teacher reads no one else's.
   */
  async mine(user: AuthenticatedUser, now: Date = new Date()): Promise<MyReportingView> {
    const schoolId = requireSchoolId(user);
    const teacherId = requireUserId(user);
    return this.prisma.withRls(user, async (tx) => {
      const today = await this.today(tx, now);
      const week = isoWeekOf(today);
      const month = monthOf(today);
      const year = await this.yearOf(tx, today);
      const own = async (range: Range): Promise<RateFigures> =>
        sums(
          (
            await tx.teacherReportingDay.aggregate({
              where: { schoolId, teacherId, day: { gte: dayDate(range.from), lte: dayDate(range.to) } },
              _sum: { held: true, reported: true },
            })
          )._sum,
        );
      const [setting, open, newest, inWeek, inMonth, inYear] = await Promise.all([
        tx.reportingSetting.findUnique({ where: { schoolId }, select: { openAfterDays: true } }),
        this.openLessons(tx),
        tx.teacherReportingDay.aggregate({ where: { schoolId, teacherId }, _max: { day: true } }),
        own(week),
        own(month),
        year ? own(year) : Promise.resolve(null),
      ]);
      return {
        openAfterDays: setting?.openAfterDays ?? DEFAULT_OPEN_AFTER_DAYS,
        through: newest._max.day ? asDay(newest._max.day) : null,
        open,
        week: { ...week, ...inWeek },
        month: { ...month, ...inMonth },
        year: year && inYear ? { ...year, ...inYear } : null,
      };
    });
  }

  private async readSettings(tx: PrismaClient, schoolId: string): Promise<ReportingSettingsView> {
    const row = await tx.reportingSetting.findUnique({ where: { schoolId } });
    return {
      teacherReminders: row?.teacherReminders ?? false,
      rektorDigest: row?.rektorDigest ?? false,
      openAfterDays: row?.openAfterDays ?? DEFAULT_OPEN_AFTER_DAYS,
    };
  }

  /**
   * The school's today on the database's clock (app.school_today()). The
   * database always answers; the instant is what a stand-in that does not
   * falls back on.
   */
  private async today(tx: PrismaClient, now: Date): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ today: string }>>(Prisma.sql`SELECT app.school_today()::text AS today`);
    return rows?.[0]?.today ?? asDay(now);
  }

  /**
   * The first and last day of the period holding `anchor`: the ISO week
   * (Monday to Sunday) and the calendar month are dates alone, the läsår is the
   * AcademicYear that holds the day (the active one before an inactive, when
   * two do). A school with no läsår for the day has no period: null.
   */
  private async rangeOf(tx: PrismaClient, period: ReportingPeriod, anchor: string): Promise<Range | (Range & { name: string }) | null> {
    if (period === 'WEEK') return isoWeekOf(anchor);
    if (period === 'MONTH') return monthOf(anchor);
    return this.yearOf(tx, anchor);
  }

  private async yearOf(tx: PrismaClient, day: string): Promise<(Range & { name: string }) | null> {
    const year = await tx.academicYear.findFirst({
      where: { startDate: { lte: dayDate(day) }, endDate: { gte: dayDate(day) } },
      orderBy: [{ isActive: 'desc' }, { startDate: 'desc' }, { id: 'asc' }],
      select: { name: true, startDate: true, endDate: true },
    });
    return year ? { name: year.name, from: asDay(year.startDate), to: asDay(year.endDate) } : null;
  }

  /** The caller's own lessons that wait for their register: app.reporting_open_lessons answers for the caller alone. */
  private async openLessons(tx: PrismaClient): Promise<OpenLessonView[]> {
    const rows = await tx.$queryRaw<
      Array<{ lesson_id: string; day: string; starts_at: Date; ends_at: Date; subject_name: string; group_name: string; overdue: boolean }>
    >(
      Prisma.sql`SELECT lesson_id, day::text AS day, starts_at, ends_at, subject_name, group_name, overdue
                   FROM app.reporting_open_lessons(${OPEN_LESSONS_DAYS}::integer)`,
    );
    return (rows ?? []).map((row) => ({
      lessonId: row.lesson_id,
      date: row.day,
      startsAt: new Date(row.starts_at).toISOString(),
      endsAt: new Date(row.ends_at).toISOString(),
      subjectName: row.subject_name,
      groupName: row.group_name,
      overdue: row.overdue,
    }));
  }
}
