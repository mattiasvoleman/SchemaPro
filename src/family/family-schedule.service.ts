import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../common/utils/request-context';
import { asDay, dayDate, isoWeekOf, localDateOf, schoolTimezone, shiftDay } from '../cover/cover-context';
import { PrismaService } from '../database/prisma.service';
import type { FamilyScheduleQueryDto } from './dto/family-schedule.dto';

/**
 * A child's PUBLISHED week, as the school shows it to the family.
 *
 * GET /api/v1/family/schedule, for a GUARDIAN (their own children) and the
 * SCHOOL_ADMIN (any pupil of the school: "see what a family sees"). Runs in
 * one transaction under the caller's own RLS, where the arms of
 * 20261013090000 are the boundary on WHICH lessons: a guardian reads the
 * lessons their children are taught in and nothing else, whatever this
 * service does. Which COLUMNS, which weeks and the class history are this
 * service's alone, so the lesson arms are granted to the API's role
 * (app_authenticated) and not to PostgREST's: a direct read would carry the
 * note and cancel cause of a whole year of cancellations. On top of RLS it
 * adds three things:
 *
 *   * the per-child split. A guardian of two children reads both children's
 *     lessons in one table, so a sibling's lesson must not appear under the
 *     wrong child: the lessons are matched by THIS child's groups and name;
 *   * the class history (C6). A lesson matched only through the home class is
 *     kept on the dates the child's enrollment segment names that class; a
 *     child who moved class this week shows no lessons of the new class on
 *     the days before the move (and, the arm being keyed on today's class,
 *     none of the old class's either). Teaching groups have no history and
 *     count as of today;
 *   * the whitelist. No note (it carries "Inställd: <aktivitet>" and
 *     "Självstudier under tillsyn"), no cancel cause, no teacher id, no other
 *     pupil, no roster. Teachers are named only by app.family_lesson_staff,
 *     the SECURITY DEFINER function that applies the school's
 *     publicTeacherDisplay as the public viewer does; a substituted or
 *     cancelled lesson names nobody, and the substitute is a boolean.
 *
 * The calendar is the published layer (Publicering, 20261011100000), so no
 * draft is ever read. Times are HH:MM on the school's clock.
 */

const SHOWN_STATUSES = ['SCHEDULED', 'COMPLETED', 'CANCELLED'] as const;
type ShownStatus = (typeof SHOWN_STATUSES)[number];

export interface FamilyLesson {
  id: string;
  date: string;
  start: string;
  end: string;
  startsAt: string;
  endsAt: string;
  subjectId: string;
  subject: string;
  subjectColor: string | null;
  room: string | null;
  teachers: string[];
  status: ShownStatus;
  substitute: boolean;
}

export interface FamilyMeal {
  id: string;
  date: string;
  start: string;
  end: string;
}

export interface FamilyRast extends FamilyMeal {
  name: string;
}

export interface FamilySchedule {
  student: { id: string; firstName: string };
  week: { from: string; to: string; isoWeek: string };
  /** The school's today, so the reader's "i dag" is the school's and not the device's. */
  today: string;
  /**
   * The Mondays of the first and the last week that may be asked for (the
   * viewer's bound below); `latest` null without an active year. The pages
   * disable stepping past them rather than meeting WEEK_OUT_OF_RANGE.
   */
  bounds: { earliest: string; latest: string | null };
  timezone: string;
  lessons: FamilyLesson[];
  lunches: FamilyMeal[];
  rasts: FamilyRast[];
}

interface StaffRow {
  lesson_id: string;
  substitute: boolean;
  labels: string[] | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const STUDENT_NOT_FOUND = 'STUDENT_NOT_FOUND';
export const WEEK_OUT_OF_RANGE = 'WEEK_OUT_OF_RANGE';

/** One answer for every pupil the caller may not see: unknown, another family's, another school's, inactive, not a pupil. */
function studentNotFound(): NotFoundException {
  return new NotFoundException({ message: 'Eleven finns inte.', code: STUDENT_NOT_FOUND });
}

/** A YYYY-MM-DD that exists in the calendar. */
export function isRealDay(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const day = dayDate(value);
  return !Number.isNaN(day.getTime()) && asDay(day) === value;
}

/** "2026-W42" for the week whose Monday is given: the week of its Thursday, counted in the Thursday's year. */
export function isoWeekLabel(monday: string): string {
  const thursday = dayDate(shiftDay(monday, 3));
  const year = thursday.getUTCFullYear();
  const dayOfYear = Math.round((thursday.getTime() - Date.UTC(year, 0, 1)) / 86_400_000);
  return `${year}-W${String(Math.floor(dayOfYear / 7) + 1).padStart(2, '0')}`;
}

/** HH:MM of an instant on the school's clock. */
export function schoolClock(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant);
}

@Injectable()
export class FamilyScheduleService {
  constructor(private readonly prisma: PrismaService) {}

  async week(query: FamilyScheduleQueryDto, user: AuthenticatedUser): Promise<FamilySchedule> {
    const schoolId = requireSchoolId(user);
    if (query.week !== undefined && !isRealDay(query.week)) {
      throw new BadRequestException('week: ett datum som finns, ÅÅÅÅ-MM-DD.');
    }
    return this.prisma.withRls(user, async (tx) => {
      // For a guardian, users_guardian_children_select answers linked children
      // only; isActive and role make a pupil who left, or a linked adult, the
      // same 404 as a stranger.
      const child = await tx.user.findFirst({
        where: { id: query.studentId, role: 'STUDENT', isActive: true },
        select: { id: true, firstName: true, studentGroupId: true },
      });
      if (!child) throw studentNotFound();

      const timezone = await schoolTimezone(tx, schoolId);
      const today = await this.schoolToday(tx, timezone);
      const { from, to } = isoWeekOf(query.week ?? today);
      const { bounds, pastYear } = await this.assertWeekInRange(tx, from, to, today);
      if (pastYear) {
        // Today's own week after the active year has ended (the summer):
        // nothing is published past the year, so the week is empty rather
        // than a 400 the pages would show before the reader did anything.
        return {
          student: { id: child.id, firstName: child.firstName },
          week: { from, to, isoWeek: isoWeekLabel(from) },
          today,
          bounds,
          timezone,
          lessons: [],
          lunches: [],
          rasts: [],
        };
      }

      const home = child.studentGroupId;
      const teaching = (
        await tx.studentGroupMember.findMany({ where: { studentId: child.id }, select: { studentGroupId: true } })
      ).map((row) => row.studentGroupId);
      const groups = [...new Set([...(home ? [home] : []), ...teaching])];
      const homeDays = await this.homeClassDays(tx, child.id, home, from, to);

      const rows =
        (await tx.calendarLesson.findMany({
          where: {
            date: { gte: dayDate(from), lte: dayDate(to) },
            status: { in: [...SHOWN_STATUSES] },
            OR: [
              ...(groups.length > 0
                ? [{ studentGroupId: { in: groups } }, { extraGroups: { some: { studentGroupId: { in: groups } } } }]
                : []),
              { participants: { some: { studentId: child.id } } },
            ],
          },
          select: {
            id: true,
            date: true,
            startsAt: true,
            endsAt: true,
            status: true,
            subjectId: true,
            studentGroupId: true,
            subject: { select: { name: true, color: true } },
            room: { select: { name: true } },
            extraGroups: { select: { studentGroupId: true } },
            participants: { where: { studentId: child.id }, select: { studentId: true } },
          },
          orderBy: [{ startsAt: 'asc' }, { endsAt: 'asc' }, { id: 'asc' }],
        })) ?? [];

      const teachingSet = new Set(teaching);
      const lessons = rows.filter((row) => {
        const date = asDay(row.date);
        const named = row.participants.length > 0;
        const viaTeaching =
          teachingSet.has(row.studentGroupId) || row.extraGroups.some((x) => teachingSet.has(x.studentGroupId));
        const viaHome = home !== null && (row.studentGroupId === home || row.extraGroups.some((x) => x.studentGroupId === home));
        return named || viaTeaching || (viaHome && homeDays.has(date));
      });

      const staff = await this.staff(
        tx,
        lessons.map((lesson) => lesson.id),
      );

      const [lunches, rasts] = home
        ? await Promise.all([
            tx.calendarLunch.findMany({
              where: { studentGroupId: home, date: { gte: dayDate(from), lte: dayDate(to) } },
              select: { id: true, date: true, startsAt: true, endsAt: true },
              orderBy: [{ startsAt: 'asc' }],
            }),
            tx.calendarRast.findMany({
              where: { studentGroupId: home, date: { gte: dayDate(from), lte: dayDate(to) } },
              select: { id: true, date: true, startsAt: true, endsAt: true, name: true },
              orderBy: [{ startsAt: 'asc' }],
            }),
          ])
        : [[], []];

      return {
        student: { id: child.id, firstName: child.firstName },
        week: { from, to, isoWeek: isoWeekLabel(from) },
        today,
        bounds,
        timezone,
        lessons: lessons.map((row) => {
          const said = staff.get(row.id);
          return {
            id: row.id,
            date: asDay(row.date),
            start: schoolClock(row.startsAt, timezone),
            end: schoolClock(row.endsAt, timezone),
            startsAt: row.startsAt.toISOString(),
            endsAt: row.endsAt.toISOString(),
            subjectId: row.subjectId,
            subject: row.subject.name,
            subjectColor: row.subject.color ?? null,
            room: row.room?.name ?? null,
            teachers: said?.labels ?? [],
            status: row.status as ShownStatus,
            substitute: said?.substitute ?? false,
          };
        }),
        lunches: (lunches ?? [])
          .filter((meal) => homeDays.has(asDay(meal.date)))
          .map((meal) => ({
            id: meal.id,
            date: asDay(meal.date),
            start: schoolClock(meal.startsAt, timezone),
            end: schoolClock(meal.endsAt, timezone),
          })),
        rasts: (rasts ?? [])
          .filter((rast) => homeDays.has(asDay(rast.date)))
          .map((rast) => ({
            id: rast.id,
            date: asDay(rast.date),
            start: schoolClock(rast.startsAt, timezone),
            end: schoolClock(rast.endsAt, timezone),
            name: rast.name,
          })),
      };
    });
  }

  /** The school's today, on the database's clock (app.school_today()). */
  private async schoolToday(tx: PrismaClient, timezone: string): Promise<string> {
    const rows = await tx.$queryRaw<{ today: string }[]>`SELECT app.school_today()::text AS today`;
    return rows?.[0]?.today ?? localDateOf(new Date(), timezone);
  }

  /**
   * The viewer's bound (20261011133000): a week that ended more than seven
   * days before today, or starts after the active läsår has ended, is not
   * shown. Paging through history would rebuild a record of cancellations;
   * a week past the year has nothing published. Without an active year only
   * the first bound applies.
   *
   * One exception: the week holding today is always answered, empty when it
   * starts past the year (`pastYear`). Between the year's end and the next
   * year's activation the default request would otherwise be a 400 that no
   * reader can step out of.
   */
  private async assertWeekInRange(
    tx: PrismaClient,
    from: string,
    to: string,
    today: string,
  ): Promise<{ bounds: { earliest: string; latest: string | null }; pastYear: boolean }> {
    const year = await tx.academicYear.findFirst({ where: { isActive: true }, select: { endDate: true } });
    const yearEnd = year ? asDay(year.endDate) : null;
    const thisWeek = isoWeekOf(today).from;
    const pastYear = yearEnd !== null && from > yearEnd;
    if (to < shiftDay(today, -7) || (pastYear && from !== thisWeek)) {
      throw new BadRequestException({ message: 'Veckan ligger utanför det som går att visa.', code: WEEK_OUT_OF_RANGE });
    }
    // The same rule read as Mondays: the week holding today − 7 is the first
    // whose Sunday is not before it, the week holding the year's last day the
    // last that starts inside the year; this week is always one of them.
    const lastWeek = isoWeekOf(shiftDay(today, -7)).from;
    const earliest = yearEnd !== null && lastWeek > yearEnd ? thisWeek : lastWeek;
    const yearsLast = yearEnd === null ? null : isoWeekOf(yearEnd).from;
    const latest = yearsLast === null ? null : yearsLast < thisWeek ? thisWeek : yearsLast;
    return { bounds: { earliest, latest }, pastYear };
  }

  /**
   * The dates of [from, to] on which the child's home class was `home`,
   * according to the enrollment segments ([validFrom, validTo), validTo null
   * open). A date no segment covers is not one: before a pupil's first
   * segment, the class's lessons were not theirs.
   */
  private async homeClassDays(
    tx: PrismaClient,
    studentId: string,
    home: string | null,
    from: string,
    to: string,
  ): Promise<Set<string>> {
    const days = new Set<string>();
    if (!home) return days;
    const segments =
      (await tx.studentEnrollment.findMany({
        where: {
          studentId,
          studentGroupId: home,
          validFrom: { lte: dayDate(to) },
          OR: [{ validTo: null }, { validTo: { gt: dayDate(from) } }],
        },
        select: { validFrom: true, validTo: true },
      })) ?? [];
    for (let day = from; day <= to; day = shiftDay(day, 1)) {
      if (segments.some((s) => asDay(s.validFrom) <= day && (s.validTo === null || day < asDay(s.validTo)))) days.add(day);
    }
    return days;
  }

  /** app.family_lesson_staff: the substitute flag and the teachers as the school names them to families. */
  private async staff(tx: PrismaClient, lessonIds: string[]): Promise<Map<string, { substitute: boolean; labels: string[] }>> {
    if (lessonIds.length === 0) return new Map();
    const rows =
      (await tx.$queryRaw<StaffRow[]>(
        Prisma.sql`SELECT lesson_id::text AS lesson_id, substitute, labels FROM app.family_lesson_staff(${lessonIds}::uuid[])`,
      )) ?? [];
    return new Map(rows.map((row) => [row.lesson_id, { substitute: row.substitute === true, labels: row.labels ?? [] }]));
  }
}
