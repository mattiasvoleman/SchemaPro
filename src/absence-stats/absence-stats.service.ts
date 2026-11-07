import { Injectable } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { recordRead } from '../access-log/access-log';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import {
  MAX_PERIOD_DAYS,
  MIN_GROUP,
  asIso,
  buildClasses,
  buildPatterns,
  buildPupilMonths,
  buildSeries,
  dayOf,
  figuresOf,
  monthStart,
  monthsBetween,
  totalOf,
  type ClassRow,
  type ClassSummaryView,
  type Figures,
  type PatternRow,
  type PatternsView,
  type PupilMonthRow,
  type PupilMonthView,
  type RawFigures,
  type SeriesMonthView,
  type SeriesRow,
} from './absence-stats';
import { noPupilsForTheReader, noSuchPupil, refusing } from './absence-stats-errors';
import type { PeriodQueryDto } from './dto/absence-stats.dto';

const DAY_MS = 86_400_000;

/** The school's calendar as the pages need it. */
export interface WindowView {
  /** The first day of the first month of the three läsår shown. */
  firstMonth: string;
  /** The school's today; the figures run to yesterday. */
  today: string;
  /** The läsår holding today: its name and first and last day; null for a school with none. */
  year: { name: string; from: string; to: string } | null;
  /** The smallest group a figure rests on. */
  minGroup: number;
}

export interface SchoolStatsView {
  window: WindowView;
  /** The whole school, month by month over the three läsår. */
  series: SeriesMonthView[];
}

export interface ClassesView {
  window: WindowView;
  /** The period the classes' months were added over, from the first of its first month to the last of its last. */
  period: { from: string; to: string };
  classes: ClassSummaryView[];
}

export interface ClassStatsView {
  window: WindowView;
  classId: string;
  /** The class and its predecessors, month by month. */
  series: SeriesMonthView[];
  period: { from: string; to: string };
  patterns: PatternsView;
}

export interface ClassPupilView {
  studentId: string;
  firstName: string;
  lastName: string;
  figures: Figures;
}

export interface ClassPupilsView {
  window: WindowView;
  classId: string;
  period: { from: string; to: string };
  pupils: ClassPupilView[];
  /**
   * Pupils the school has marked as having a protected identity, left out of the list and counted. An
   * administrator is told how many; a mentor is not (the count would point at the pupil): null.
   */
  heldOut: number | null;
}

export interface PupilStatsView {
  window: WindowView;
  student: { id: string; firstName: string; lastName: string; classId: string | null; className: string | null; isProtected: boolean };
  /** The first and last day of the pupil's marks still stored; null when none is. The months before were gallrade, or never reported. */
  marksFrom: string | null;
  marksTo: string | null;
  /** Every month of the window. */
  months: PupilMonthView[];
  total: Figures | null;
  /** The pupil's class and its predecessors, to read the pupil against and to read the reporting beside; null for a pupil in no class. */
  classSeries: SeriesMonthView[] | null;
  period: { from: string; to: string };
  patterns: PatternsView;
}

interface WindowRow {
  first_month: string;
  today: string;
  year_name: string | null;
  year_start: string | null;
  year_end: string | null;
}

interface FigureColumns {
  recorded_minutes: number | null;
  valid_minutes: number | null;
  absent_minutes: number | null;
  late_minutes: number | null;
  late_count: number | null;
}

/** The five minutes of a row, or none when the database left them out (fewer than five pupils behind them). */
function figuresFrom(row: FigureColumns): RawFigures | null {
  if (row.recorded_minutes === null) return null;
  return {
    recordedMinutes: row.recorded_minutes,
    validMinutes: row.valid_minutes ?? 0,
    absentMinutes: row.absent_minutes ?? 0,
    lateMinutes: row.late_minutes ?? 0,
    lateCount: row.late_count ?? 0,
  };
}

const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));

/**
 * Frånvarostatistik över tid (20270121090000): the school's absence month by
 * month over three läsår, per class and per pupil, the patterns by weekday,
 * pass and subject for a development talk, and the reporting rate beside.
 *
 * WHO READS WHAT. Every door is a function of the database that reads the
 * caller's identity from the claims (app.absence_stats_*): an administrator
 * reads the school, each class and each pupil; a mentor reads their own pupils
 * and classes, with the mentor definition Frånvarobevakningen has; the
 * huvudman's reader reads the school's and the classes' sums and never a pupil;
 * nobody else reads anything. The gateway does not choose among them. It asks
 * under the reader's own principal, turns a refusal into its answer, and
 * records what it hands out that names a pupil, in the read log.
 *
 * NO FIGURE UNDER FIVE PUPILS, AND NO PUPIL KEPT. The school's and the classes'
 * months are sums the nightly job (absence-stats.job.ts) stores, without a
 * pupil's id; what is shown about a pupil is counted from the marks that are
 * left, when it is asked for, and goes with them when they are purged.
 */
@Injectable()
export class AbsenceStatsService {
  constructor(private readonly prisma: PrismaService) {}

  async window(user: AuthenticatedUser): Promise<WindowView> {
    requireSchoolId(user);
    return refusing(() => this.prisma.withRls(user, (tx) => this.readWindow(tx)));
  }

  /** The whole school over the three läsår. For an administrator, the huvudman's reader included. */
  async school(user: AuthenticatedUser): Promise<SchoolStatsView> {
    requireSchoolId(user);
    return refusing(() =>
      this.prisma.withRls(user, async (tx) => {
        const window = await this.readWindow(tx);
        return { window, series: buildSeries(await this.readSeries(tx, null)) };
      }),
    );
  }

  /** The school's classes with the sum of their months over a period (the läsår so far without one). */
  async classes(query: PeriodQueryDto, user: AuthenticatedUser): Promise<ClassesView> {
    requireSchoolId(user);
    return refusing(() =>
      this.prisma.withRls(user, async (tx) => {
        const window = await this.readWindow(tx);
        const period = periodOf(query, window);
        const rows = await tx.$queryRaw<
          Array<
            FigureColumns & {
              class_id: string;
              class_name: string;
              year_name: string | null;
              months_counted: number;
              pupils: number;
              pupils_registered: number;
              lessons_held: number;
              lessons_reported: number;
            }
          >
        >(
          Prisma.sql`SELECT class_id, class_name, year_name, months_counted, pupils, pupils_registered,
                            recorded_minutes, valid_minutes, absent_minutes, late_minutes, late_count, lessons_held, lessons_reported
                       FROM app.absence_stats_classes(${period.from}::date, ${period.to}::date)`,
        );
        const classes: ClassRow[] = (rows ?? []).map((row) => ({
          classId: row.class_id,
          className: row.class_name,
          yearName: row.year_name,
          monthsCounted: num(row.months_counted),
          pupils: num(row.pupils),
          pupilsRegistered: num(row.pupils_registered),
          figures: figuresFrom({
            recorded_minutes: row.recorded_minutes === null ? null : num(row.recorded_minutes),
            valid_minutes: row.valid_minutes === null ? null : num(row.valid_minutes),
            absent_minutes: row.absent_minutes === null ? null : num(row.absent_minutes),
            late_minutes: row.late_minutes === null ? null : num(row.late_minutes),
            late_count: row.late_count === null ? null : num(row.late_count),
          }),
          lessonsHeld: num(row.lessons_held),
          lessonsReported: num(row.lessons_reported),
        }));
        return { window, period, classes: buildClasses(classes) };
      }),
    );
  }

  /** A class and its predecessors month by month, and its patterns over a period. Sums: no pupil is named, so nothing is recorded. */
  async classView(classId: string, query: PeriodQueryDto, user: AuthenticatedUser): Promise<ClassStatsView> {
    requireSchoolId(user);
    return refusing(() =>
      this.prisma.withRls(user, async (tx) => {
        const window = await this.readWindow(tx);
        const period = periodOf(query, window);
        const series = buildSeries(await this.readSeries(tx, classId));
        const patterns = await this.readPatterns(tx, { classId }, period);
        return { window, classId, series, period, patterns };
      }),
    );
  }

  /**
   * The pupils of a class over a period, each with their sum, for a
   * development talk. Names pupils, so it is recorded in the read log inside
   * its own transaction, as ATTENDANCE (the figures) and PEOPLE (the names),
   * about every pupil handed out. Not for the huvudman's reader.
   */
  async classPupils(classId: string, query: PeriodQueryDto, user: AuthenticatedUser): Promise<ClassPupilsView> {
    requireSchoolId(user);
    if (user.huvudman) throw noPupilsForTheReader();
    return refusing(() =>
      this.prisma.withRls(user, async (tx) => {
        const window = await this.readWindow(tx);
        const period = periodOf(query, window);
        const rows = await tx.$queryRaw<
          Array<FigureColumns & { student_id: string | null; first_name: string | null; last_name: string | null; is_protected: boolean }>
        >(
          Prisma.sql`SELECT student_id, first_name, last_name, is_protected,
                            recorded_minutes, valid_minutes, absent_minutes, late_minutes, late_count
                       FROM app.absence_stats_class_pupils(${classId}::uuid, ${period.from}::date, ${period.to}::date)`,
        );
        const shown = (rows ?? []).filter((row) => !row.is_protected && row.student_id !== null);
        const pupils = shown.map((row) => ({
          studentId: row.student_id as string,
          firstName: row.first_name ?? '',
          lastName: row.last_name ?? '',
          figures: figuresOf(figuresFrom(row) ?? { recordedMinutes: 0, validMinutes: 0, absentMinutes: 0, lateMinutes: 0, lateCount: 0 }),
        }));
        const ids = pupils.map((pupil) => pupil.studentId);
        await recordRead(tx, 'ATTENDANCE', ids, user.channel);
        await recordRead(tx, 'PEOPLE', ids, user.channel);
        const held = (rows ?? []).filter((row) => row.is_protected).length;
        return { window, classId, period, pupils, heldOut: user.role === Role.SCHOOL_ADMIN ? held : null };
      }),
    );
  }

  /**
   * One pupil, for the talk: every month of the window with the same month a
   * year before, the pupil's class beside it with the reporting rate, and the
   * patterns over a period. Counted from the marks that are left; the months
   * before them are none, not zero. Recorded in the read log, as ATTENDANCE
   * and PEOPLE, about the pupil. Not for the huvudman's reader.
   */
  async pupil(studentId: string, query: PeriodQueryDto, user: AuthenticatedUser): Promise<PupilStatsView> {
    requireSchoolId(user);
    if (user.huvudman) throw noPupilsForTheReader();
    return refusing(() =>
      this.prisma.withRls(user, async (tx) => {
        const window = await this.readWindow(tx);
        const period = periodOf(query, window);
        const head = await tx.$queryRaw<
          Array<{
            student_id: string;
            first_name: string;
            last_name: string;
            class_id: string | null;
            class_name: string | null;
            first_day: string | null;
            last_day: string | null;
            is_protected: boolean;
          }>
        >(
          Prisma.sql`SELECT student_id, first_name, last_name, class_id, class_name, first_day::text AS first_day, last_day::text AS last_day, is_protected
                       FROM app.absence_stats_pupil_head(${studentId}::uuid)`,
        );
        const who = head?.[0];
        if (!who) throw noSuchPupil();
        // The months of the window; a window longer than the database reads at once is cut from the front.
        const yesterday = asIso(new Date(dayOf(window.today).getTime() - DAY_MS));
        const earliest = asIso(new Date(dayOf(yesterday).getTime() - MAX_PERIOD_DAYS * DAY_MS));
        const from = window.firstMonth < earliest ? earliest : window.firstMonth;
        const months = await tx.$queryRaw<Array<FigureColumns & { month: string; lessons: number }>>(
          Prisma.sql`SELECT month::text AS month, recorded_minutes, valid_minutes, absent_minutes, late_minutes, late_count, lessons
                       FROM app.absence_stats_pupil(${studentId}::uuid, ${from}::date, ${yesterday}::date)`,
        );
        const rows: PupilMonthRow[] = (months ?? []).map((row) => ({
          month: row.month,
          figures: figuresFrom(row) as RawFigures,
          lessons: num(row.lessons),
        }));
        const patterns = await this.readPatterns(tx, { studentId }, period);
        const classSeries = who.class_id ? buildSeries(await this.readSeries(tx, who.class_id)) : null;
        await recordRead(tx, 'ATTENDANCE', [studentId], user.channel);
        await recordRead(tx, 'PEOPLE', [studentId], user.channel);
        return {
          window,
          student: {
            id: who.student_id,
            firstName: who.first_name,
            lastName: who.last_name,
            classId: who.class_id,
            className: who.class_name,
            isProtected: who.is_protected,
          },
          marksFrom: who.first_day,
          marksTo: who.last_day,
          months: buildPupilMonths(rows, monthsBetween(window.firstMonth, yesterday)),
          total: totalOf(rows),
          classSeries,
          period,
          patterns,
        };
      }),
    );
  }

  private async readWindow(tx: PrismaClient): Promise<WindowView> {
    const rows = await tx.$queryRaw<WindowRow[]>(
      Prisma.sql`SELECT first_month::text AS first_month, today::text AS today, year_name, year_start::text AS year_start, year_end::text AS year_end
                   FROM app.absence_stats_window()`,
    );
    const row = rows?.[0];
    if (!row) throw new Error('app.absence_stats_window answered nothing');
    return {
      firstMonth: row.first_month,
      today: row.today,
      year: row.year_name && row.year_start && row.year_end ? { name: row.year_name, from: row.year_start, to: row.year_end } : null,
      minGroup: MIN_GROUP,
    };
  }

  private async readSeries(tx: PrismaClient, classId: string | null): Promise<SeriesRow[]> {
    const rows = await tx.$queryRaw<
      Array<
        FigureColumns & {
          month: string;
          through_day: string;
          class_id: string | null;
          class_name: string | null;
          pupils: number;
          pupils_registered: number;
          lessons_held: number;
          lessons_reported: number;
        }
      >
    >(
      Prisma.sql`SELECT month::text AS month, through_day::text AS through_day, class_id, class_name, pupils, pupils_registered,
                        recorded_minutes, valid_minutes, absent_minutes, late_minutes, late_count, lessons_held, lessons_reported
                   FROM app.absence_stats_series(${classId}::uuid)`,
    );
    return (rows ?? []).map((row) => ({
      month: row.month,
      throughDay: row.through_day,
      classId: row.class_id,
      className: row.class_name,
      pupils: num(row.pupils),
      pupilsRegistered: num(row.pupils_registered),
      figures: figuresFrom(row),
      lessonsHeld: num(row.lessons_held),
      lessonsReported: num(row.lessons_reported),
    }));
  }

  private async readPatterns(
    tx: PrismaClient,
    scope: { classId: string } | { studentId: string },
    period: { from: string; to: string },
  ): Promise<PatternsView> {
    const classId = 'classId' in scope ? scope.classId : null;
    const studentId = 'studentId' in scope ? scope.studentId : null;
    const rows = await tx.$queryRaw<
      Array<FigureColumns & { dimension: PatternRow['dimension']; key: string; label: string; group_size: number; suppressed: boolean }>
    >(
      Prisma.sql`SELECT dimension, key, label, group_size, suppressed,
                        recorded_minutes, valid_minutes, absent_minutes, late_minutes, late_count
                   FROM app.absence_stats_patterns(${classId}::uuid, ${studentId}::uuid, ${period.from}::date, ${period.to}::date)`,
    );
    return buildPatterns(
      (rows ?? []).map((row) => ({
        dimension: row.dimension,
        key: row.key,
        label: row.label,
        groupSize: num(row.group_size),
        suppressed: row.suppressed,
        figures: figuresFrom(row),
      })),
    );
  }
}

/**
 * The period a read covers: what was asked for, or the läsår holding today
 * up to yesterday (the first of the window without a läsår). The database
 * holds a period to MAX_PERIOD_DAYS and from before to, and refuses (400) one
 * that is not.
 */
export function periodOf(query: PeriodQueryDto, window: WindowView): { from: string; to: string } {
  const yesterday = asIso(new Date(dayOf(window.today).getTime() - DAY_MS));
  const to = query.to ?? yesterday;
  const from = query.from ?? (window.year && window.year.from <= to ? window.year.from : monthStart(window.firstMonth));
  return { from, to };
}

