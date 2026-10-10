import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import { substituteHoursStatement, type SubstituteHoursRow } from '../timplan/timplan-delivered.sql';
import { asDay, dayDate, readCounter, type CounterRow } from './cover-context';
import { checkWindow, CoverService } from './cover.service';

export interface CounterView extends CounterRow {
  kind: 'STAFF' | 'POOL';
}

export interface HoursRow {
  lessonId: string;
  userId: string;
  kind: 'STAFF' | 'POOL';
  date: string;
  startsAt: string;
  endsAt: string;
  minutes: number;
  subjectId: string;
  studentGroupId: string;
  roomId: string | null;
}

export interface HoursResponse {
  from: string;
  to: string;
  /** Held covers only (Fas 3's DELIVERED SUBSTITUTE rows): what payroll is sent. */
  rows: HoursRow[];
  /**
   * Held covers the calendar credits to a substitute who had an ACTIVE
   * absence over the lesson themself — booked, then away, and nobody
   * re-covered it before it ended. Fas 3 credits them (the statement is
   * pinned); the payroll rows and the summary leave them out, and the admin
   * checks them. Nothing here says why: the same shape as a row.
   */
  toCheck: HoursRow[];
  summary: { userId: string; kind: 'STAFF' | 'POOL'; lessons: number; minutes: number }[];
  /** Covers booked in the range that have not been held: shown, never exported. */
  planned: { userId: string; lessons: number; minutes: number }[];
}

/**
 * The cover counter (Untis' Vertretungszähler) and the hour statement for
 * payroll (Vikarietimmar). Admin only. Neither says who was away or why: the
 * statement is who covered what when, and a file sent to payroll must not
 * become a sick-leave register.
 */
@Injectable()
export class CoverReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cover: CoverService,
  ) {}

  async counter(date: string, user: AuthenticatedUser): Promise<{ date: string; rows: CounterView[] }> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const year = await tx.academicYear.findFirst({
        where: { startDate: { lte: dayDate(date) }, endDate: { gte: dayDate(date) } },
        select: { id: true, startDate: true, endDate: true },
        orderBy: [{ isActive: 'desc' }, { startDate: 'desc' }],
      });
      const counter = await readCounter(
        tx,
        date,
        year ? { startDate: asDay(year.startDate), endDate: asDay(year.endDate) } : null,
        this.cover.now(),
      );
      const kindOf = await this.kinds(tx, year ? [year.id] : []);
      for (const userId of kindOf.members) {
        if (!counter.has(userId)) {
          counter.set(userId, { userId, weekLessons: 0, weekMinutes: 0, termLessons: 0, termMinutes: 0, heldTermMinutes: 0 });
        }
      }
      const rows = [...counter.values()]
        .map((row) => ({ ...row, kind: kindOf.of(row.userId) }))
        .sort((a, b) => b.weekLessons - a.weekLessons || b.termLessons - a.termLessons || a.userId.localeCompare(b.userId));
      return { date, rows };
    });
  }

  /**
   * Held covers per substitute over a range of at most 93 days. The range is
   * split by the läsår it crosses — the classification is a year's (June to
   * August is two) — run per year, clamped, and concatenated.
   */
  async hours(from: string, to: string, userId: string | undefined, user: AuthenticatedUser): Promise<HoursResponse> {
    requireSchoolId(user);
    checkWindow(from, to, 93);
    const now = this.cover.now();
    return this.prisma.withRls(user, async (tx) => {
      const years = await tx.academicYear.findMany({
        where: { startDate: { lte: dayDate(to) }, endDate: { gte: dayDate(from) } },
        select: { id: true, startDate: true, endDate: true },
        orderBy: { startDate: 'asc' },
      });
      const found: SubstituteHoursRow[] = [];
      for (const year of years) {
        const yearStart = asDay(year.startDate);
        const yearEnd = asDay(year.endDate);
        const range = { from: from > yearStart ? from : yearStart, to: to < yearEnd ? to : yearEnd };
        found.push(
          ...((await tx.$queryRaw<SubstituteHoursRow[]>(
            substituteHoursStatement({ academicYearId: year.id, yearStart, yearEnd, asOf: now }, range, userId ?? null),
          )) ?? []),
        );
      }
      const kindOf = await this.kinds(tx, years.map((year) => year.id));
      const all: HoursRow[] = found.map((row) => ({
        lessonId: row.lessonId,
        userId: row.userId,
        kind: kindOf.of(row.userId),
        date: row.date,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        minutes: Number(row.minutes),
        subjectId: row.subjectId,
        studentGroupId: row.studentGroupId,
        roomId: row.roomId,
      }));
      const away = await this.awayDuring(tx, found);
      const wasAway = (row: HoursRow) =>
        (away.get(row.userId) ?? []).some(
          (span) => span.startsAt.getTime() < Date.parse(row.endsAt) && span.endsAt.getTime() > Date.parse(row.startsAt),
        );
      const rows = all.filter((row) => !wasAway(row));
      const toCheck = all.filter(wasAway);
      const summary = new Map<string, HoursResponse['summary'][number]>();
      for (const row of rows) {
        const entry = summary.get(row.userId) ?? { userId: row.userId, kind: row.kind, lessons: 0, minutes: 0 };
        entry.lessons += 1;
        entry.minutes += row.minutes;
        summary.set(row.userId, entry);
      }
      const ahead = await tx.calendarLessonTeacher.findMany({
        where: {
          role: 'SUBSTITUTE',
          ...(userId ? { teacherId: userId } : {}),
          calendarLesson: {
            status: 'SCHEDULED',
            date: { gte: dayDate(from), lte: dayDate(to) },
            endsAt: { gt: now },
          },
        },
        select: { teacherId: true, calendarLesson: { select: { startsAt: true, endsAt: true } } },
      });
      const planned = new Map<string, HoursResponse['planned'][number]>();
      for (const row of ahead) {
        const entry = planned.get(row.teacherId) ?? { userId: row.teacherId, lessons: 0, minutes: 0 };
        entry.lessons += 1;
        entry.minutes += Math.round((row.calendarLesson.endsAt.getTime() - row.calendarLesson.startsAt.getTime()) / 60_000);
        planned.set(row.teacherId, entry);
      }
      const byUser = <T extends { userId: string }>(a: T, b: T) => a.userId.localeCompare(b.userId);
      return {
        from,
        to,
        rows,
        toCheck,
        summary: [...summary.values()].sort(byUser),
        planned: [...planned.values()].sort(byUser),
      };
    });
  }

  /** The substitutes' ACTIVE absences over the rows' span: the period only, never the reason. */
  private async awayDuring(
    tx: PrismaClient,
    rows: readonly SubstituteHoursRow[],
  ): Promise<Map<string, { startsAt: Date; endsAt: Date }[]>> {
    if (rows.length === 0) return new Map();
    const first = new Date(Math.min(...rows.map((row) => row.startsAt.getTime())));
    const last = new Date(Math.max(...rows.map((row) => row.endsAt.getTime())));
    const absences =
      (await tx.teacherAbsence.findMany({
        where: {
          status: 'ACTIVE',
          userId: { in: [...new Set(rows.map((row) => row.userId))] },
          startsAt: { lt: last },
          endsAt: { gt: first },
        },
        select: { userId: true, startsAt: true, endsAt: true },
      })) ?? [];
    const byUser = new Map<string, { startsAt: Date; endsAt: Date }[]>();
    for (const absence of absences) byUser.set(absence.userId, [...(byUser.get(absence.userId) ?? []), absence]);
    return byUser;
  }

  /** POOL: a pool member without a post in any of the years; everybody else STAFF. */
  private async kinds(tx: PrismaClient, yearIds: string[]): Promise<{ members: string[]; of: (userId: string) => 'STAFF' | 'POOL' }> {
    const members = (await tx.substitutePoolMember.findMany({ select: { userId: true } })).map((row) => row.userId);
    const employed =
      members.length > 0 && yearIds.length > 0
        ? new Set(
            (
              await tx.teacherEmployment.findMany({
                where: { userId: { in: members }, academicYearId: { in: yearIds } },
                select: { userId: true },
              })
            ).map((row) => row.userId),
          )
        : new Set<string>();
    const pool = new Set(members.filter((id) => !employed.has(id)));
    return { members, of: (id) => (pool.has(id) ? 'POOL' : 'STAFF') };
  }
}
