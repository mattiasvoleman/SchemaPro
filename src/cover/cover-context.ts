import type { PrismaClient, TeacherQualificationKind } from '@prisma/client';
import { todayInZone, zonedTimeToUtc } from '../common/utils/time';
import { isFullDay, isoWeekday, timeToString } from '../calendar/publish-days';
import type { LoadEmployment } from '../staffing/teacher-load';
import type { LessonStatusValue, PersonClosure, PersonDay, PersonLesson, Span } from './cover-rules';

/**
 * WHAT THE COVER RULES AND THE RANKING READ, BY SCHOOL-WIDE SET.
 *
 * One round of reads per day (D−1 to D+1 for the daily rest), never one per
 * candidate: the old picker's teacherHasClash in a loop was a statement per
 * teacher. Every read runs in the caller's withRls transaction, so a
 * candidate list is what the caller's role may see — an admin's.
 *
 * Model calls only (no $queryRaw), so the old per-lesson operations can use
 * these readers without moving any raw statement their specs queue.
 *
 * PRIVACY: nothing here selects an absence's reasonId, an
 * AvailabilityConstraint's free-text reason, or a TeacherDuty's note. An
 * absence is a span; a closure is a span with the uppdrag's label at most.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const asDay = (value: Date): string => value.toISOString().slice(0, 10);
export const dayDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
export function shiftDay(date: string, days: number): string {
  return asDay(new Date(dayDate(date).getTime() + days * DAY_MS));
}

/** The school-local day [00:00, next 00:00) as instants. */
export function dayBounds(date: string, timezone: string): { start: Date; end: Date } {
  return { start: zonedTimeToUtc(date, '00:00', timezone), end: zonedTimeToUtc(shiftDay(date, 1), '00:00', timezone) };
}

/** A wall-clock window of a day lifted to instants; a 00:00–23:59 row is the whole day. */
export function liftWindow(date: string, startTime: Date, endTime: Date, timezone: string): Span {
  if (isFullDay(startTime, endTime)) {
    const bounds = dayBounds(date, timezone);
    return { start: bounds.start.getTime(), end: bounds.end.getTime() };
  }
  return {
    start: zonedTimeToUtc(date, timeToString(startTime), timezone).getTime(),
    end: zonedTimeToUtc(date, timeToString(endTime), timezone).getTime(),
  };
}

/** The school-local date of an instant. */
export function localDateOf(instant: Date, timezone: string): string {
  return asDay(todayInZone(timezone, instant));
}

export async function schoolTimezone(tx: PrismaClient, schoolId: string): Promise<string> {
  const school = await tx.school.findUnique({ where: { id: schoolId }, select: { timezone: true } });
  return school?.timezone ?? 'Europe/Stockholm';
}

export interface DayReadOptions {
  date: string;
  timezone: string;
  academicYearId: string | null;
  /** Read only these people; absent = every active TEACHER of the school. */
  userIds?: readonly string[];
  /** Their Users rows, when the caller has them already (no read then). */
  known?: readonly { id: string; role: string; isActive: boolean }[];
  /** The caller has read and judged their absences itself. */
  skipAbsences?: boolean;
}

export interface DayRead {
  days: Map<string, PersonDay>;
  employments: Map<string, LoadEmployment>;
  poolMembers: Set<string>;
}

const HOLDING: LessonStatusValue[] = ['SCHEDULED', 'COMPLETED'];

/**
 * Every person's day as cover-rules.ts reads it. Defensive about rows it did
 * not ask for in a shape it expects: a reader that crashes on an odd row
 * would take the old assignment path down with it.
 */
export async function readPersonDays(tx: PrismaClient, options: DayReadOptions): Promise<DayRead> {
  const { date, timezone } = options;
  const only = options.userIds ? [...new Set(options.userIds)] : null;
  const byUser = only ? { in: only } : undefined;
  const weekday = isoWeekday(date);
  const from = dayBounds(shiftDay(date, -1), timezone).start;
  const to = dayBounds(shiftDay(date, 1), timezone).end;
  const today = dayBounds(date, timezone);

  const users =
    options.known ??
    (await tx.user.findMany({
      where: only ? { id: { in: only } } : { role: 'TEACHER', isActive: true },
      select: { id: true, role: true, isActive: true },
    })) ??
    [];
  const days = new Map<string, PersonDay>();
  for (const user of users) {
    if (!user?.id) continue;
    days.set(user.id, {
      userId: user.id,
      isActiveTeacher: user.role === 'TEACHER' && user.isActive === true,
      lessons: [],
      closures: [],
      preferredFree: [],
      bookings: [],
      absences: [],
      lunch: null,
      minDailyRestMinutes: null,
      pool: { member: false, hasEmployment: false, windows: [] },
    });
  }
  const ids = [...days.keys()];
  if (ids.length === 0) return { days, employments: new Map(), poolMembers: new Set() };
  const people = byUser ?? { in: ids };

  const rows =
    (await tx.calendarLessonTeacher.findMany({
      where: { teacherId: people, calendarLesson: { date: { gte: dayDate(shiftDay(date, -1)), lte: dayDate(shiftDay(date, 1)) } } },
      select: {
        teacherId: true,
        calendarLesson: {
          select: { id: true, date: true, startsAt: true, endsAt: true, status: true, cancelCause: true, studentGroupId: true, subjectId: true },
        },
      },
    })) ?? [];
  for (const row of rows) {
    const lesson = row?.calendarLesson;
    const day = days.get(row?.teacherId);
    if (!lesson || !day) continue;
    day.lessons.push({
      id: lesson.id,
      date: asDay(lesson.date),
      start: lesson.startsAt.getTime(),
      end: lesson.endsAt.getTime(),
      status: lesson.status,
      cancelCause: lesson.cancelCause ?? null,
      studentGroupId: lesson.studentGroupId,
      subjectId: lesson.subjectId,
    } satisfies PersonLesson);
  }

  const constraints =
    (await tx.availabilityConstraint.findMany({
      where: {
        resourceType: 'TEACHER',
        userId: people,
        type: { in: ['UNAVAILABLE', 'PREFERRED_FREE'] },
        OR: [{ date: dayDate(date) }, { date: null, dayOfWeek: weekday }],
      },
      // Never `reason`: it is free text and can name an illness.
      select: { id: true, userId: true, startTime: true, endTime: true, type: true },
    })) ?? [];
  const slotIds = constraints.filter((row) => row?.type === 'UNAVAILABLE').map((row) => row.id);
  const duties =
    slotIds.length > 0
      ? ((await tx.teacherDuty.findMany({
          where: { blockedConstraintId: { in: slotIds } },
          // Never `note`.
          select: { blockedConstraintId: true, label: true, academicYearId: true },
        })) ?? [])
      : [];
  const dutyOf = new Map(duties.filter((duty) => duty?.blockedConstraintId).map((duty) => [duty.blockedConstraintId!, duty]));
  for (const row of constraints) {
    const day = row?.userId ? days.get(row.userId) : undefined;
    if (!day || !row.startTime || !row.endTime) continue;
    const span = liftWindow(date, row.startTime, row.endTime, timezone);
    if (row.type === 'PREFERRED_FREE') {
      day.preferredFree.push(span);
      continue;
    }
    const duty = dutyOf.get(row.id);
    // An uppdrag's slot blocks its own läsår only (Fas 2): a duty of another
    // year leaves this day free.
    if (duty && options.academicYearId !== null && duty.academicYearId !== options.academicYearId) continue;
    const closure: PersonClosure = duty
      ? { span, kind: 'DUTY', label: duty.label }
      : { span, kind: 'UNAVAILABLE', label: null };
    day.closures.push(closure);
  }

  const bookings =
    (await tx.roomBooking.findMany({
      where: { bookedById: people, status: { in: ['PENDING', 'APPROVED'] }, startsAt: { lt: today.end }, endsAt: { gt: today.start } },
      select: { bookedById: true, startsAt: true, endsAt: true },
    })) ?? [];
  for (const booking of bookings) {
    const day = booking?.bookedById ? days.get(booking.bookedById) : undefined;
    if (day && booking.startsAt && booking.endsAt) {
      day.bookings.push({ start: booking.startsAt.getTime(), end: booking.endsAt.getTime() });
    }
  }

  const rules =
    (await tx.teacherWorkRule.findMany({
      where: { userId: people },
      select: { userId: true, lunchMinutes: true, lunchStartTime: true, lunchEndTime: true, minDailyRestMinutes: true },
    })) ?? [];
  for (const rule of rules) {
    const day = rule?.userId ? days.get(rule.userId) : undefined;
    if (!day) continue;
    if (rule.lunchMinutes !== null && rule.lunchStartTime && rule.lunchEndTime) {
      day.lunch = { minutes: rule.lunchMinutes, window: liftWindow(date, rule.lunchStartTime, rule.lunchEndTime, timezone) };
    }
    day.minDailyRestMinutes = rule.minDailyRestMinutes ?? null;
  }

  const absences = options.skipAbsences
    ? []
    : (await tx.teacherAbsence.findMany({
      where: { userId: people, status: 'ACTIVE', startsAt: { lt: to }, endsAt: { gt: from } },
      // The period only; never the reason.
      select: { userId: true, startsAt: true, endsAt: true },
    })) ?? [];
  for (const absence of absences) {
    const day = absence?.userId ? days.get(absence.userId) : undefined;
    if (day && absence.startsAt && absence.endsAt) {
      day.absences.push({ start: absence.startsAt.getTime(), end: absence.endsAt.getTime() });
    }
  }

  const members = (await tx.substitutePoolMember.findMany({ where: { userId: people }, select: { userId: true } })) ?? [];
  const poolMembers = new Set(members.filter((row) => row?.userId).map((row) => row.userId));
  if (poolMembers.size > 0) {
    const windows =
      (await tx.substituteAvailability.findMany({
        where: { userId: { in: [...poolMembers] }, OR: [{ date: dayDate(date) }, { date: null, dayOfWeek: weekday }] },
        select: { userId: true, startTime: true, endTime: true },
      })) ?? [];
    for (const window of windows) {
      const day = window?.userId ? days.get(window.userId) : undefined;
      if (day && window.startTime && window.endTime) {
        day.pool.windows.push(liftWindow(date, window.startTime, window.endTime, timezone));
      }
    }
  }

  const employments = new Map<string, LoadEmployment>();
  if (options.academicYearId !== null) {
    const rows =
      (await tx.teacherEmployment.findMany({
        where: { academicYearId: options.academicYearId, userId: people },
        select: {
          userId: true,
          employmentPercent: true,
          reductionPercent: true,
          contractKind: true,
          teachingTargetMinutesPerWeek: true,
          signature: true,
        },
      })) ?? [];
    for (const row of rows) {
      if (!row?.userId) continue;
      employments.set(row.userId, {
        userId: row.userId,
        employmentPercent: Number(row.employmentPercent),
        reductionPercent: Number(row.reductionPercent ?? 0),
        contractKind: row.contractKind,
        teachingTargetMinutesPerWeek: row.teachingTargetMinutesPerWeek ?? null,
        signature: row.signature ?? null,
      });
    }
  }
  for (const [userId, day] of days) {
    day.pool.member = poolMembers.has(userId);
    day.pool.hasEmployment = employments.has(userId);
  }
  return { days, employments, poolMembers };
}

/**
 * The Swedish termin around a date: HT is [max(year start, 1 Aug), 31 Dec],
 * VT [1 Jan, min(year end, 31 Jul)] of the läsår containing it. A term is
 * modelled nowhere else; without a year it is the calendar half-year.
 */
export function termOf(date: string, year: { startDate: string; endDate: string } | null): { from: string; to: string } {
  const y = date.slice(0, 4);
  const autumn = date.slice(5) >= '08-01';
  const half = autumn ? { from: `${y}-08-01`, to: `${y}-12-31` } : { from: `${y}-01-01`, to: `${y}-07-31` };
  if (!year || date < year.startDate || date > year.endDate) return half;
  return autumn
    ? { from: year.startDate > half.from ? year.startDate : half.from, to: half.to }
    : { from: half.from, to: year.endDate < half.to ? year.endDate : half.to };
}

/** Monday and Sunday of the ISO week of a date. */
export function isoWeekOf(date: string): { from: string; to: string } {
  const monday = shiftDay(date, 1 - isoWeekday(date));
  return { from: monday, to: shiftDay(monday, 6) };
}

export interface CounterRow {
  userId: string;
  weekLessons: number;
  weekMinutes: number;
  termLessons: number;
  termMinutes: number;
  /** Of the term's, those that have ended. */
  heldTermMinutes: number;
}

/**
 * THE COVER COUNTER: SUBSTITUTE rows on SCHEDULED or COMPLETED lessons — the
 * row Fas 3 credits — per ISO week and per term. Planned covers count:
 * fairness is about who has been asked.
 */
export async function readCounter(
  tx: PrismaClient,
  date: string,
  year: { startDate: string; endDate: string } | null,
  now: Date = new Date(),
): Promise<Map<string, CounterRow>> {
  const term = termOf(date, year);
  const week = isoWeekOf(date);
  const from = week.from < term.from ? week.from : term.from;
  const to = week.to > term.to ? week.to : term.to;
  const rows =
    (await tx.calendarLessonTeacher.findMany({
      where: {
        role: 'SUBSTITUTE',
        calendarLesson: { status: { in: HOLDING }, date: { gte: dayDate(from), lte: dayDate(to) } },
      },
      select: { teacherId: true, calendarLesson: { select: { date: true, startsAt: true, endsAt: true } } },
    })) ?? [];
  const counter = new Map<string, CounterRow>();
  for (const row of rows) {
    const lesson = row?.calendarLesson;
    if (!lesson || !row.teacherId) continue;
    const day = asDay(lesson.date);
    const minutes = Math.round((lesson.endsAt.getTime() - lesson.startsAt.getTime()) / 60_000);
    const entry =
      counter.get(row.teacherId) ??
      { userId: row.teacherId, weekLessons: 0, weekMinutes: 0, termLessons: 0, termMinutes: 0, heldTermMinutes: 0 };
    if (day >= week.from && day <= week.to) {
      entry.weekLessons += 1;
      entry.weekMinutes += minutes;
    }
    if (day >= term.from && day <= term.to) {
      entry.termLessons += 1;
      entry.termMinutes += minutes;
      if (lesson.endsAt.getTime() <= now.getTime()) entry.heldTermMinutes += minutes;
    }
    counter.set(row.teacherId, entry);
  }
  return counter;
}

/** Calendar minutes per teacher in the ISO week of a date, every role, SCHEDULED or COMPLETED. */
export async function readWeekMinutes(tx: PrismaClient, date: string): Promise<Map<string, number>> {
  const week = isoWeekOf(date);
  const rows =
    (await tx.calendarLessonTeacher.findMany({
      where: { calendarLesson: { status: { in: HOLDING }, date: { gte: dayDate(week.from), lte: dayDate(week.to) } } },
      select: { teacherId: true, calendarLesson: { select: { startsAt: true, endsAt: true } } },
    })) ?? [];
  const minutes = new Map<string, number>();
  for (const row of rows) {
    const lesson = row?.calendarLesson;
    if (!lesson || !row.teacherId) continue;
    minutes.set(row.teacherId, (minutes.get(row.teacherId) ?? 0) + (lesson.endsAt.getTime() - lesson.startsAt.getTime()) / 60_000);
  }
  return minutes;
}

export interface QualificationRow {
  userId: string;
  subjectId: string;
  minGradeLevel: number;
  maxGradeLevel: number;
  kind: TeacherQualificationKind;
  validFrom: Date | null;
  validTo: Date | null;
}

const QUALIFICATION_RANK: Record<TeacherQualificationKind, number> = { LEGITIMATION: 3, BEHORIG: 2, TILLATEN: 1 };

/**
 * The strongest behörighet a person holds for a subject over a grade span,
 * valid on the date — the old picker's question (calendar-lessons.service.ts
 * suggestSubstitutes), asked of many people at once. A null span is not
 * judged (any span counts), as there.
 */
export function strongestOn(
  held: readonly QualificationRow[],
  userId: string,
  subjectId: string,
  span: { min: number; max: number } | null,
  date: Date,
): TeacherQualificationKind | null {
  let best: TeacherQualificationKind | null = null;
  for (const row of held) {
    if (row.userId !== userId || row.subjectId !== subjectId) continue;
    if (span && (row.minGradeLevel > span.min || row.maxGradeLevel < span.max)) continue;
    if (row.validFrom && row.validFrom > date) continue;
    if (row.validTo && row.validTo < date) continue;
    if (best === null || QUALIFICATION_RANK[row.kind] > QUALIFICATION_RANK[best]) best = row.kind;
  }
  return best;
}
