import type { PrismaClient } from '@prisma/client';
import { landingContextOf } from '../publication/draft-publish';
import { isoWeekday, publishSkips } from '../calendar/publish-days';
import { toWallClock } from '../common/utils/time';
import type { ConflictView } from './class-teacher.types';

/**
 * The same four questions the schemaläggare's editor asks of a placement in
 * the grundschema (MasterLessonsService.findConflicts: is the teacher, the room
 * or the class taken, is the hour unavailable), asked of ONE DATE of the dated
 * calendar. A klasslärare's exception for one date meets no second set of
 * rules; what the template check cannot see, a lesson already moved to this
 * date, is seen here, and a lov or a closed class (publishSkips, the rule a
 * publish skips a date by) is added, because a date has them and a weekday has
 * not.
 *
 * It names a clash by what clashes and with which lesson (class, subject,
 * time), and never by a person: a klasslärare is not told which colleague is
 * teaching, and a colleague with a protected identity is named nowhere.
 */

export interface DatedPlacement {
  /** The lesson being placed; its own row is not a clash. */
  lessonId: string;
  academicYearId: string;
  /** YYYY-MM-DD, on the school's clock. */
  date: string;
  startsAt: Date;
  endsAt: Date;
  roomId: string | null;
  studentGroupId: string;
  teacherIds: readonly string[];
  extraGroupIds: readonly string[];
  timezone: string;
}

/** Minutes after local midnight of an instant. */
export function localMinutes(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  return get('hour') * 60 + get('minute');
}

const clock = (instant: Date, timezone: string): string => {
  const minutes = localMinutes(instant, timezone);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};

const overlapsClock = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean => aStart < bEnd && bStart < aEnd;

export async function datedConflicts(tx: PrismaClient, placement: DatedPlacement): Promise<ConflictView[]> {
  const found: ConflictView[] = [];
  const { timezone } = placement;
  const own = new Set<string>([placement.studentGroupId, ...placement.extraGroupIds]);
  // The halves of the classes attending are the same children.
  const halves = await tx.studentGroup.findMany({
    where: { halfOfId: { in: [...own] } },
    select: { id: true },
  });
  for (const half of halves) own.add(half.id);

  const others = await tx.calendarLesson.findMany({
    where: {
      id: { not: placement.lessonId },
      status: { in: ['SCHEDULED', 'COMPLETED'] },
      startsAt: { lt: placement.endsAt },
      endsAt: { gt: placement.startsAt },
    },
    select: {
      roomId: true,
      startsAt: true,
      endsAt: true,
      studentGroupId: true,
      studentGroup: { select: { name: true, halfOfId: true } },
      subject: { select: { name: true } },
      teachers: { select: { teacherId: true } },
      extraGroups: { select: { studentGroupId: true } },
    },
  });
  const seen = new Set<string>();
  const add = (view: ConflictView): void => {
    const key = `${view.kind}|${view.other?.className}|${view.other?.subjectName}|${view.other?.start}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(view);
  };
  for (const other of others) {
    const view = (kind: ConflictView['kind']): ConflictView => ({
      kind,
      other: {
        className: other.studentGroup.name,
        subjectName: other.subject.name,
        date: placement.date,
        start: clock(other.startsAt, timezone),
        end: clock(other.endsAt, timezone),
      },
    });
    if (other.teachers.some((row) => placement.teacherIds.includes(row.teacherId))) add(view('TEACHER'));
    if (placement.roomId && other.roomId === placement.roomId) add(view('ROOM'));
    const theirs = [other.studentGroupId, other.studentGroup.halfOfId, ...other.extraGroups.map((row) => row.studentGroupId)];
    if (theirs.some((id) => id !== null && own.has(id))) add(view('GROUP'));
  }

  if (placement.roomId) {
    const booking = await tx.roomBooking.findFirst({
      where: { roomId: placement.roomId, status: 'APPROVED', startsAt: { lt: placement.endsAt }, endsAt: { gt: placement.startsAt } },
      select: { id: true },
    });
    if (booking) found.push({ kind: 'BOOKING' });
  }

  // Unavailable: the teacher's, the room's and the class's, weekly or for this date.
  const startMinutes = localMinutes(placement.startsAt, timezone);
  const endMinutes = localMinutes(placement.endsAt, timezone);
  const weekday = isoWeekday(placement.date);
  const constraints = await tx.availabilityConstraint.findMany({
    where: {
      type: 'UNAVAILABLE',
      OR: [
        ...(placement.teacherIds.length > 0 ? [{ userId: { in: [...placement.teacherIds] } }] : []),
        ...(placement.roomId ? [{ roomId: placement.roomId }] : []),
        { studentGroupId: { in: [...own] } },
      ],
    },
    select: { dayOfWeek: true, date: true, startTime: true, endTime: true },
  });
  const blocked = constraints.some((constraint) => {
    const onDay = constraint.date
      ? constraint.date.toISOString().slice(0, 10) === placement.date
      : constraint.dayOfWeek === weekday;
    if (!onDay) return false;
    const from = Number(toWallClock(constraint.startTime).slice(0, 2)) * 60 + Number(toWallClock(constraint.startTime).slice(3));
    const to = Number(toWallClock(constraint.endTime).slice(0, 2)) * 60 + Number(toWallClock(constraint.endTime).slice(3));
    return overlapsClock(startMinutes, endMinutes, from, to);
  });
  if (blocked) found.push({ kind: 'AVAILABILITY' });

  // A lov, or the class closed for the date.
  const landing = await landingContextOf(tx, placement.academicYearId, placement.date, placement.date, timezone);
  const skip = publishSkips(
    {
      studentGroupId: placement.studentGroupId,
      startTime: new Date(Date.UTC(1970, 0, 1, Math.floor(startMinutes / 60), startMinutes % 60)),
      endTime: new Date(Date.UTC(1970, 0, 1, Math.floor(endMinutes / 60), endMinutes % 60)),
    },
    placement.date,
    landing,
  );
  if (skip !== null) found.push({ kind: 'BREAK' });
  return found;
}
