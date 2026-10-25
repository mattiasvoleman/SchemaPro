import type { PrismaClient, TeacherQualificationKind } from '@prisma/client';
import { todayInZone, zonedTimeToUtc } from '../common/utils/time';
import { isFullDay, isoWeekday, timeToString } from '../calendar/publish-days';
import { dayOf, dutyRunsOn } from '../staffing/duty-dates';
import { toLoadPeriod } from '../staffing/load-input';
import type { LoadEmployment } from '../staffing/teacher-load';
import { passTargetId, type LessonStatusValue, type PersonClosure, type PersonDay, type PersonLesson, type Span } from './cover-rules';

/**
 * WHAT THE COVER RULES AND THE RANKING READ, BY SCHOOL-WIDE SET.
 *
 * One round of reads per day (D−1 to D+1 for the daily rest), never one per
 * candidate: the old picker's teacherHasClash in a loop was a statement per
 * teacher. The one wider read is the ISO week's teaching dates, for the
 * people whose post limits their days, and only when somebody's does. Every
 * read runs in the caller's withRls transaction, so a candidate list is what
 * the caller's role may see — an admin's.
 *
 * Model calls only (no $queryRaw), so the old per-lesson operations can use
 * these readers without moving any raw statement their specs queue.
 *
 * PRIVACY: nothing here selects an absence's reasonId, an
 * AvailabilityConstraint's free-text reason, a TeacherDuty's note or a
 * rastvaktspass's note. An absence is a span; a closure is a span with the
 * uppdrag's label at most; a pass is a span.
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
  /**
   * Read each post's periods too (20261022120000): the ranking judges the
   * week by the post in force then (postOfWeek). The hard rules ask only
   * whether a post exists, and leave them unread.
   */
  withPeriods?: boolean;
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
      dailyCapMinutes: null,
      maxTeachingDaysPerWeek: null,
      weekTeachingDates: [],
      preferredFreeDay: null,
      supervision: [],
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
          select: { id: true, date: true, startsAt: true, endsAt: true, status: true, cancelCause: true, studentGroupId: true, subjectId: true, roomId: true },
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
      roomId: lesson.roomId ?? null,
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
  // The uppdrag each time belongs to, through its link (TeacherDutySlots,
  // migration 20261017090000), with the dates it runs.
  const links =
    slotIds.length > 0
      ? ((await tx.teacherDutySlot.findMany({
          where: { availabilityConstraintId: { in: slotIds } },
          // Never the duty's `note`.
          select: {
            availabilityConstraintId: true,
            teacherDuty: { select: { label: true, academicYearId: true, validFrom: true, validTo: true } },
          },
        })) ?? [])
      : [];
  const dutyOf = new Map(
    links.filter((link) => link?.teacherDuty).map((link) => [link.availabilityConstraintId, link.teacherDuty]),
  );
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
    // And only on the days the uppdrag runs: Anna's mentor hour ends at the
    // jullov, and in March the same weekly row keeps nobody busy.
    if (duty && !dutyRunsOn({ validFrom: dayOf(duty.validFrom ?? null), validTo: dayOf(duty.validTo ?? null) }, date)) continue;
    const closure: PersonClosure = duty
      ? { span, kind: 'DUTY', label: duty.label }
      : { span, kind: 'UNAVAILABLE', label: null };
    day.closures.push(closure);
  }

  // THE RASTVAKTSPASS OF THE DAY (Rastvakt i vardagen, 20261210090000): ONE
  // statement for the year's own passes of these people on the weekday, or a
  // pass one of them has taken as vikarie on the date; and only when it
  // returns a pass, one more for the date's decisions on those passes. (A
  // selected relation would be that second statement always: Prisma 7 sends
  // it for an empty parent too, which the adapter probe's (z) measured.) A
  // school without passes sends the one SELECT. Never a pass's note.
  //
  // An own pass holds its time on a date between its Från and Till unless a
  // decision of the day has relieved its teacher of it (a vikarie takes it,
  // or it is left without one) — a decision on an ACTIVE absence. A pass on a day a lov closes its area still
  // holds its time here: excluding a colleague for twenty minutes is the
  // smaller mistake beside putting them in two places.
  const passes =
    (await tx.supervisionShift.findMany({
      where: {
        OR: [
          ...(options.academicYearId !== null
            ? [{ userId: people, academicYearId: options.academicYearId, dayOfWeek: weekday }]
            : []),
          { covers: { some: { date: dayDate(date), decision: 'SUBSTITUTE' as const, substituteId: people } } },
        ],
      },
      select: {
        id: true,
        userId: true,
        academicYearId: true,
        dayOfWeek: true,
        startTime: true,
        endTime: true,
        validFrom: true,
        validTo: true,
      },
    })) ?? [];
  const decided =
    passes.length > 0
      ? ((await tx.supervisionCover.findMany({
          where: { shiftId: { in: passes.map((pass) => pass.id) }, date: dayDate(date) },
          select: { shiftId: true, decision: true, substituteId: true, startsAt: true, endsAt: true, absenceId: true },
        })) ?? [])
      : [];
  // A decision on an absence no longer ACTIVE (left by an API from before
  // this release: a rollback, or containers side by side) relieves nobody —
  // its teacher is back — but its vikarie stays booked until Ångra. Asked only
  // of the decisions there are; one RLS hides reads as ACTIVE, as before.
  const leftBehind =
    decided.length > 0
      ? new Set(
          (
            (await tx.teacherAbsence.findMany({
              where: { id: { in: [...new Set(decided.map((row) => row.absenceId))] }, status: { not: 'ACTIVE' } },
              select: { id: true },
            })) ?? []
          ).map((row) => row.id),
        )
      : new Set<string>();
  for (const pass of passes) {
    if (!pass?.id) continue;
    const decisions = decided.filter((row) => row?.shiftId === pass.id);
    const relieving = decisions.filter((row) => !leftBehind.has(row.absenceId));
    const own = days.get(pass.userId);
    const runs =
      own !== undefined &&
      options.academicYearId !== null &&
      pass.academicYearId === options.academicYearId &&
      pass.dayOfWeek === weekday &&
      (!pass.validFrom || asDay(pass.validFrom) <= date) &&
      (!pass.validTo || asDay(pass.validTo) >= date);
    if (runs && relieving.length === 0 && pass.startTime && pass.endTime) {
      const span = liftWindow(date, pass.startTime, pass.endTime, timezone);
      own!.supervision!.push({ id: passTargetId(pass.id, date), date, start: span.start, end: span.end });
    }
    for (const decision of decisions) {
      const vikarie = decision.decision === 'SUBSTITUTE' && decision.substituteId ? days.get(decision.substituteId) : undefined;
      if (!vikarie || !decision.startsAt || !decision.endsAt) continue;
      vikarie.supervision!.push({
        id: passTargetId(pass.id, date),
        date,
        start: decision.startsAt.getTime(),
        end: decision.endsAt.getTime(),
      });
    }
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

  // The cap and the wish of Lärarens dag (20261123090000) are columns of the
  // same row, read in the same statement: a school that sets neither asks
  // nothing more than it did.
  const rules =
    (await tx.teacherWorkRule.findMany({
      where: { userId: people },
      select: {
        userId: true,
        lunchMinutes: true,
        lunchStartTime: true,
        lunchEndTime: true,
        minDailyRestMinutes: true,
        maxTeachingMinutesPerDay: true,
        preferredFreeDayOfWeek: true,
      },
    })) ?? [];
  for (const rule of rules) {
    const day = rule?.userId ? days.get(rule.userId) : undefined;
    if (!day) continue;
    if (rule.lunchMinutes !== null && rule.lunchStartTime && rule.lunchEndTime) {
      day.lunch = { minutes: rule.lunchMinutes, window: liftWindow(date, rule.lunchStartTime, rule.lunchEndTime, timezone) };
    }
    day.minDailyRestMinutes = rule.minDailyRestMinutes ?? null;
    day.dailyCapMinutes = rule.maxTeachingMinutesPerDay ?? null;
    day.preferredFreeDay = rule.preferredFreeDayOfWeek ?? null;
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
          // Deltid in days (20261123090000), a column of the same post: the
          // rule reads it, the LoadEmployment below never carries it.
          maxTeachingDaysPerWeek: true,
        },
      })) ?? [];
    // The posts' periods, under the same arms as the posts, asked only when
    // there is a post to have one — a school without posts sends what it did.
    const periodRows =
      options.withPeriods && rows.length > 0
        ? ((await tx.teacherEmploymentPeriod.findMany({
            where: { academicYearId: options.academicYearId, userId: people },
            orderBy: [{ userId: 'asc' }, { validFrom: 'asc' }],
          })) ?? [])
        : [];
    // THE WEEK'S TEACHING DATES, ASKED ONLY OF A POST WITH A DAY LIMIT. The
    // rows above cover D−1 to D+1, and a limit in days is the whole ISO week's,
    // so the week is one more read — of exactly those people, and only when
    // one exists: a school that sets no limit sends what it did, statement for
    // statement (the adapter probe's check (z) pins it). Where one exists the
    // read is two statements: the date is the lesson's and not the row's, and
    // Prisma 7 sends the selected relation as a statement of its own (the
    // probe's (ld-b) pins the pair). Every role on a
    // lesson that holds its time, as src/common/teacher-day.ts counts, from
    // the calendar as it stands: a part-timer whose Monday a cover decision
    // took over while they were away does not teach that Monday any more.
    const limited = rows.filter((row) => days.has(row?.userId) && (row.maxTeachingDaysPerWeek ?? null) !== null);
    for (const row of limited) days.get(row.userId)!.maxTeachingDaysPerWeek = row.maxTeachingDaysPerWeek;
    if (limited.length > 0) {
      const week = isoWeekOf(date);
      const taught =
        (await tx.calendarLessonTeacher.findMany({
          where: {
            teacherId: { in: limited.map((row) => row.userId) },
            calendarLesson: { status: { in: HOLDING }, date: { gte: dayDate(week.from), lte: dayDate(week.to) } },
          },
          select: { teacherId: true, calendarLesson: { select: { date: true } } },
        })) ?? [];
      const dates = new Map<string, Set<string>>();
      for (const row of taught) {
        if (!row?.calendarLesson?.date || !days.has(row.teacherId)) continue;
        dates.set(row.teacherId, (dates.get(row.teacherId) ?? new Set<string>()).add(asDay(row.calendarLesson.date)));
      }
      for (const [userId, taughtOn] of dates) days.get(userId)!.weekTeachingDates = [...taughtOn].sort();
    }
    for (const row of rows) {
      if (!row?.userId) continue;
      const periods = periodRows.filter((period) => period?.userId === row.userId).map(toLoadPeriod);
      employments.set(row.userId, {
        userId: row.userId,
        employmentPercent: Number(row.employmentPercent),
        reductionPercent: Number(row.reductionPercent ?? 0),
        contractKind: row.contractKind,
        teachingTargetMinutesPerWeek: row.teachingTargetMinutesPerWeek ?? null,
        signature: row.signature ?? null,
        ...(periods.length > 0 ? { periods } : {}),
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
