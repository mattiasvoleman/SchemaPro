import type { PrismaClient } from '@prisma/client';
import { isoWeekday } from '../calendar/publish-days';
import { asDay, dayBounds, dayDate, liftWindow, readPersonDays } from '../cover/cover-context';
import type { PersonDay } from '../cover/cover-rules';
import { zonedTimeToUtc } from '../common/utils/time';
import { closedDaysOf } from '../publication/activity-plan';
import { loanBookingRefusal, type LoanRow } from '../room-bookings/loan-holds';
import { wallClockMinutes } from '../school-day/school-day-rules';
import type { GroupFacts } from '../publication/activity-plan';
import { expandNamedGroups } from '../publication/activity-plan';
import type { RoomDayUse, SlotSpan } from './exam-availability';
import { datesBetween, minuteOf, type PlanLesson } from './exam-plan';
import type { PlanningExam, StandingExam } from './exam-request';
import { isPlanned, type ExamRow } from './exams.service';

/*
 * PROVPLANERING'S READS: the rows the planner decides from, turned into the
 * plain values exam-request.ts and exam-availability.ts work on. Every read
 * is under the caller's row security, an administrator's.
 */

/** The home classes of the pupils who write: a class is itself (a half is its class), a teaching group is its pupils' classes. */
export function homeClassesOf(named: readonly string[], groups: ReadonlyMap<string, GroupFacts>, homes: ReadonlyMap<string, readonly string[]>): string[] {
  const out = new Set<string>();
  for (const id of named) {
    const group = groups.get(id);
    if (!group) continue;
    if (group.kind === 'CLASS') {
      out.add(group.halfOfId ?? group.id);
      continue;
    }
    const members = (homes.get(id) ?? []).filter((home) => home !== 'none');
    if (members.length === 0) out.add(id);
    for (const home of members) out.add(home);
  }
  return [...out].sort();
}

export interface Facts {
  groups: GroupFacts[];
  byId: Map<string, GroupFacts>;
  homes: Map<string, string[]>;
}

/** The expansions an exam needs of a set of named groups. */
export function examFacts(
  row: Pick<ExamRow, 'id' | 'subjectId' | 'lengthMinutes' | 'writers' | 'windowKind' | 'windowFrom' | 'windowTo' | 'fixedStart' | 'earliestStart' | 'latestEnd' | 'groups'>,
  facts: Facts,
  breaks: ReadonlyArray<{ startDate: Date; endDate: Date; minGradeLevel: number | null; maxGradeLevel: number | null }>,
): PlanningExam | null {
  const named = row.groups.map((group) => group.studentGroupId).filter((id) => facts.byId.has(id));
  if (named.length === 0) return null;
  const from = asDay(row.windowFrom);
  const to = asDay(row.windowTo);
  const classes = homeClassesOf(named, facts.byId, facts.homes);
  const closed = new Set<string>();
  for (const id of classes) {
    for (const date of closedDaysOf(breaks, facts.byId.get(id)?.gradeLevel ?? null, from, to)) closed.add(date);
  }
  return {
    id: row.id,
    subjectId: row.subjectId,
    lengthMinutes: row.lengthMinutes,
    writers: row.writers,
    windowKind: row.windowKind as 'WEEK' | 'FIXED',
    from,
    to,
    fixedStart: row.fixedStart ? minuteOf(row.fixedStart.toISOString().slice(11, 16)) : null,
    earliestStart: row.earliestStart ? minuteOf(row.earliestStart.toISOString().slice(11, 16)) : null,
    latestEnd: row.latestEnd ? minuteOf(row.latestEnd.toISOString().slice(11, 16)) : null,
    named,
    coverOf: new Map(named.map((id) => [id, new Set(expandNamedGroups([id], facts.groups, facts.homes))])),
    closed,
    affected: new Set(expandNamedGroups(named, facts.groups, facts.homes)),
    classes,
  };
}

/** The exams that stand, as the classes' load and the clash rule read them. */
export function standingOf(rows: readonly ExamRow[], facts: Facts): StandingExam[] {
  const out: StandingExam[] = [];
  for (const row of rows) {
    if (!isPlanned(row) || !row.activity?.batch.startTime) continue;
    const named = row.groups.map((group) => group.studentGroupId).filter((id) => facts.byId.has(id));
    const start = minuteOf(row.activity.batch.startTime.toISOString().slice(11, 16));
    out.push({
      id: row.id,
      date: asDay(row.activity.batch.fromDate),
      start,
      end: start + row.lengthMinutes,
      classes: homeClassesOf(named, facts.byId, facts.homes),
    });
  }
  return out;
}

/** The lessons an activity could take on these dates, of any of these groups: SCHEDULED, not begun, no register, not a replacement lesson. */
export async function readCancellableLessons(
  tx: PrismaClient,
  groupIds: readonly string[],
  from: string,
  to: string,
  timezone: string,
  now: Date,
): Promise<PlanLesson[]> {
  if (groupIds.length === 0) return [];
  const rows = await tx.calendarLesson.findMany({
    where: {
      date: { gte: dayDate(from), lte: dayDate(to) },
      status: 'SCHEDULED',
      startsAt: { gt: now },
      attendanceRecords: { none: {} },
      activityLinks: { none: {} },
      OR: [{ studentGroupId: { in: [...groupIds] } }, { extraGroups: { some: { studentGroupId: { in: [...groupIds] } } } }],
    },
    select: {
      id: true,
      date: true,
      startsAt: true,
      endsAt: true,
      subjectId: true,
      studentGroupId: true,
      extraGroups: { select: { studentGroupId: true } },
    },
  });
  const clock = wallClockMinutes(timezone);
  return rows.map((row) => {
    const start = clock(row.startsAt.getTime());
    const endClock = clock(row.endsAt.getTime());
    return {
      id: row.id,
      date: asDay(row.date),
      start,
      end: endClock === 0 && row.endsAt > row.startsAt ? 1440 : endClock,
      subjectId: row.subjectId,
      groupIds: [row.studentGroupId, ...row.extraGroups.map((extra) => extra.studentGroupId)],
    };
  });
}

/** Every teacher's day for each date, as Skolans dag reads it. */
export async function readTeacherDays(
  tx: PrismaClient,
  teacherIds: readonly string[],
  dates: readonly string[],
  timezone: string,
  academicYearId: string,
): Promise<Map<string, Map<string, PersonDay>>> {
  const out = new Map<string, Map<string, PersonDay>>();
  for (const date of dates) {
    const read = await readPersonDays(tx, {
      date,
      timezone,
      academicYearId,
      known: teacherIds.map((id) => ({ id, role: 'TEACHER', isActive: true })),
      occupancyOnly: true,
    });
    out.set(date, read.days);
  }
  return out;
}

/** The approved loans between this school and another, as the booking page reads them. */
export async function readLoans(tx: PrismaClient): Promise<LoanRow[]> {
  const loans = await tx.roomLoan.findMany({
    where: { status: 'APPROVED' },
    select: { status: true, roomId: true, localRoomId: true, dayOfWeek: true, startTime: true, endTime: true, startDate: true, endDate: true },
  });
  return loans.map((loan) => ({
    status: loan.status,
    roomId: loan.roomId,
    localRoomId: loan.localRoomId,
    dayOfWeek: loan.dayOfWeek,
    startTime: loan.startTime.toISOString().slice(11, 16),
    endTime: loan.endTime.toISOString().slice(11, 16),
    startDate: loan.startDate.toISOString().slice(0, 10),
    endDate: loan.endDate.toISOString().slice(0, 10),
  }));
}

export const loanCheck =
  (loans: readonly LoanRow[], timezone: string) =>
  (roomId: string, slot: SlotSpan): boolean => {
    const named = loans.filter((loan) => loan.roomId === roomId || loan.localRoomId === roomId);
    return named.length > 0 && loanBookingRefusal(named, roomId, new Date(slot.start), new Date(slot.end), timezone) !== null;
  };

/** Each room's lessons, bookings and closures over the dates, for the rules that say whether it is free. */
export async function readRoomUses(
  tx: PrismaClient,
  roomIds: readonly string[],
  dates: readonly string[],
  timezone: string,
): Promise<Map<string, RoomDayUse>> {
  const uses = new Map<string, { lessons: RoomDayUse['lessons'][number][]; bookings: { start: number; end: number }[]; closures: { start: number; end: number }[] }>(
    roomIds.map((id) => [id, { lessons: [], bookings: [], closures: [] }]),
  );
  if (roomIds.length === 0 || dates.length === 0) return new Map();
  const first = dates[0];
  const last = dates[dates.length - 1];
  const lessons = await tx.calendarLesson.findMany({
    where: { roomId: { in: [...roomIds] }, date: { gte: dayDate(first), lte: dayDate(last) } },
    select: {
      id: true,
      date: true,
      roomId: true,
      startsAt: true,
      endsAt: true,
      status: true,
      studentGroupId: true,
      extraGroups: { select: { studentGroupId: true } },
    },
  });
  for (const lesson of lessons) {
    uses.get(lesson.roomId!)?.lessons.push({
      id: lesson.id,
      date: asDay(lesson.date),
      start: lesson.startsAt.getTime(),
      end: lesson.endsAt.getTime(),
      status: lesson.status,
      groupIds: [lesson.studentGroupId, ...lesson.extraGroups.map((extra) => extra.studentGroupId)],
    });
  }
  const bounds = { start: dayBounds(first, timezone).start, end: dayBounds(last, timezone).end };
  const bookings = await tx.roomBooking.findMany({
    where: { roomId: { in: [...roomIds] }, status: { in: ['PENDING', 'APPROVED'] }, startsAt: { lt: bounds.end }, endsAt: { gt: bounds.start } },
    select: { roomId: true, startsAt: true, endsAt: true },
  });
  for (const booking of bookings) uses.get(booking.roomId)?.bookings.push({ start: booking.startsAt.getTime(), end: booking.endsAt.getTime() });
  const closures = await tx.availabilityConstraint.findMany({
    where: {
      resourceType: 'ROOM',
      type: 'UNAVAILABLE',
      roomId: { in: [...roomIds] },
      OR: [{ date: { gte: dayDate(first), lte: dayDate(last) } }, { date: null, dayOfWeek: { not: null } }],
    },
    select: { roomId: true, date: true, dayOfWeek: true, startTime: true, endTime: true },
  });
  for (const date of dates) {
    for (const row of closures) {
      if (!row.roomId || !row.startTime || !row.endTime) continue;
      if (row.date ? asDay(row.date) !== date : row.dayOfWeek !== isoWeekday(date)) continue;
      uses.get(row.roomId)?.closures.push(liftWindow(date, row.startTime, row.endTime, timezone));
    }
  }
  return uses;
}

/** The school days that matter to a set of exams: the weekdays after today inside any window. */
export function datesToRead(exams: ReadonlyArray<{ from: string; to: string }>, today: string): string[] {
  const dates = new Set<string>();
  for (const exam of exams) {
    for (const date of datesBetween(exam.from, exam.to)) {
      if (date > today && isoWeekday(date) <= 5) dates.add(date);
    }
  }
  return [...dates].sort();
}

/** An instant of the school's day, for a span. */
export const instantOf = (date: string, minute: number, timezone: string): number =>
  zonedTimeToUtc(date, `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`, timezone).getTime();
