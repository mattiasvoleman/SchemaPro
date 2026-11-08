import type { PrismaClient } from '@prisma/client';
import type { DayLesson, MasterLessonsService } from '../calendar/master-lessons.service';
import { isoWeekday, publishSkips } from '../calendar/publish-days';
import type { GradeNumbering } from '../common/grade-numbering';
import { toWallClock } from '../common/utils/time';
import { landingContextOf } from '../publication/draft-publish';
import { boardCodeOf, readBoardFacts } from '../swaps/board-rules';
import { constraintsOfYear } from '../staffing/duty-slot-year';
import type { RosterBasis } from '../year-rollover/projected-rosters';
import type { ConflictView } from './class-teacher.types';

/**
 * A placement on ONE DATE of the dated calendar is held to the rules a
 * placement in the grundschema is held to, because it IS the same rule:
 *
 *   * the clash rule, MasterLessonsService.findConflicts, every arm of it: the
 *     teacher, the room, the class and its pupils (through the year's rosters,
 *     so a teaching group that shares pupils with the class, a half, a
 *     replacing group and a pupil named on a lesson clash as they do in the
 *     editor), the pupils' ombyte and dusch before and after a lesson, and the
 *     weekly unavailability of the teacher, the room and the class. It is asked
 *     with the date's dated lessons as the lessons to be held against
 *     (`against`) in place of the template's, because a date has exceptions
 *     the template does not know: a lesson cancelled or moved for the date
 *     stands nowhere that date, and one moved to it stands there;
 *   * the board's three hard rules (src/swaps/board-rules.ts, the judge G1's
 *     swap search asks too): the stage's ramtid, the class's meal (the date's
 *     own where the publication laid one) and a closure on whole årskurser;
 *   * what only a date has: a closure written for the date, an approved room
 *     booking, and a lov or a closed class (publishSkips, the rule a publish
 *     skips a date by).
 *
 * It names a clash by what clashes and with which lesson (class, subject,
 * time), and never by a person: a klasslärare is not told which colleague is
 * teaching, and a colleague with a protected identity is named nowhere.
 */

export interface DatedPlacement {
  /** The lesson being placed; its own row is not a clash. */
  lessonId: string;
  academicYearId: string;
  schoolId: string;
  subjectId: string;
  /** YYYY-MM-DD, on the school's clock. */
  date: string;
  startsAt: Date;
  endsAt: Date;
  roomId: string | null;
  studentGroupId: string;
  teacherIds: readonly string[];
  extraGroupIds: readonly string[];
  /** Pupils the lesson names one by one. */
  participantIds: readonly string[];
  timezone: string;
}

/** What the clash rule reads the year through (the same basis every other reader of a year's pupils uses). */
export interface DatedContext {
  masters: MasterLessonsService;
  basis: RosterBasis;
  gradeNumbering: GradeNumbering;
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

/** A time of day as the TIME columns hold it, which is what the clash rule reads. */
const timeOfDay = (instant: Date, timezone: string): Date => {
  const minutes = localMinutes(instant, timezone);
  return new Date(Date.UTC(1970, 0, 1, Math.floor(minutes / 60), minutes % 60));
};

const overlapsClock = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean => aStart < bEnd && bStart < aEnd;
const dateOf = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

export async function datedConflicts(tx: PrismaClient, context: DatedContext, placement: DatedPlacement): Promise<ConflictView[]> {
  const { timezone, date } = placement;
  const found: ConflictView[] = [];
  const startMinutes = localMinutes(placement.startsAt, timezone);
  const endMinutes = localMinutes(placement.endsAt, timezone);
  const weekday = isoWeekday(date);
  const own = new Set<string>([placement.studentGroupId, ...placement.extraGroupIds]);

  // The date's lessons: the ones the placement is held against.
  const rows = await tx.calendarLesson.findMany({
    where: { id: { not: placement.lessonId }, date: dateOf(date), status: { in: ['SCHEDULED', 'COMPLETED'] } },
    select: {
      id: true,
      roomId: true,
      startsAt: true,
      endsAt: true,
      subjectId: true,
      studentGroupId: true,
      studentGroup: { select: { name: true } },
      subject: { select: { name: true } },
      teachers: { select: { teacherId: true } },
      extraGroups: { select: { studentGroupId: true } },
      participants: { select: { studentId: true } },
    },
  });
  // A lesson the clash rule reads holds two teachers; a third is a lesson of its own, so that no teacher goes unasked.
  const against: DayLesson[] = rows.flatMap((row): DayLesson[] => {
    const teacherIds = [...new Set(row.teachers.map((teacher) => teacher.teacherId))];
    const lesson = (teacherId: string | null, coTeacherId: string | null): DayLesson => ({
      id: row.id,
      teacherId,
      coTeacherId,
      roomId: row.roomId,
      studentGroupId: row.studentGroupId,
      subjectId: row.subjectId,
      startTime: timeOfDay(row.startsAt, timezone),
      endTime: timeOfDay(row.endsAt, timezone),
      recurrence: 'ALL_WEEKS',
      startDate: null,
      endDate: null,
      subject: { name: row.subject.name },
      extraGroups: row.extraGroups,
      participants: row.participants,
    });
    const pairs: DayLesson[] = [lesson(teacherIds[0] ?? null, teacherIds[1] ?? null)];
    for (const extra of teacherIds.slice(2)) pairs.push(lesson(extra, null));
    return pairs;
  });
  const byId = new Map(rows.map((row) => [row.id, row]));

  const seen = new Set<string>();
  const add = (view: ConflictView): void => {
    const key = `${view.kind}|${view.other?.className}|${view.other?.subjectName}|${view.other?.start}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(view);
  };

  const hits = await context.masters.findConflicts(
    tx,
    context.basis,
    { id: null, academicYearId: placement.academicYearId, studentGroupId: placement.studentGroupId, subjectId: placement.subjectId },
    {
      dayOfWeek: weekday,
      startMinutes,
      endMinutes,
      teacherId: placement.teacherIds[0] ?? null,
      coTeacherId: placement.teacherIds[1] ?? null,
      roomId: placement.roomId,
      extraGroupIds: [...placement.extraGroupIds],
      studentIds: [...placement.participantIds],
    },
    { against },
  );
  for (const hit of hits) {
    const other = hit.masterLessonId ? byId.get(hit.masterLessonId) : undefined;
    add({
      kind: hit.kind,
      ...(other
        ? {
            other: {
              className: other.studentGroup.name,
              subjectName: other.subject.name,
              date,
              start: clock(other.startsAt, timezone),
              end: clock(other.endsAt, timezone),
            },
          }
        : {}),
    });
  }

  if (placement.roomId) {
    const booking = await tx.roomBooking.findFirst({
      where: { roomId: placement.roomId, status: 'APPROVED', startsAt: { lt: placement.endsAt }, endsAt: { gt: placement.startsAt } },
      select: { id: true },
    });
    if (booking) add({ kind: 'BOOKING' });
  }

  // A closure written for this date: the teacher's, the room's and the class's (the weekly ones are the clash rule's).
  const dated = await tx.availabilityConstraint.findMany({
    where: {
      type: 'UNAVAILABLE',
      date: dateOf(date),
      AND: [constraintsOfYear(placement.academicYearId)],
      OR: [
        ...(placement.teacherIds.length > 0 ? [{ userId: { in: [...placement.teacherIds] } }] : []),
        ...(placement.roomId ? [{ roomId: placement.roomId }] : []),
        { studentGroupId: { in: [...own] } },
      ],
    },
    select: { startTime: true, endTime: true },
  });
  const blocked = dated.some((constraint) => {
    const from = Number(toWallClock(constraint.startTime).slice(0, 2)) * 60 + Number(toWallClock(constraint.startTime).slice(3));
    const to = Number(toWallClock(constraint.endTime).slice(0, 2)) * 60 + Number(toWallClock(constraint.endTime).slice(3));
    return overlapsClock(startMinutes, endMinutes, from, to);
  });
  if (blocked) add({ kind: 'AVAILABILITY' });

  // A lov, or the class closed for the date.
  const landing = await landingContextOf(tx, placement.academicYearId, date, date, timezone);
  const skip = publishSkips(
    {
      studentGroupId: placement.studentGroupId,
      startTime: new Date(Date.UTC(1970, 0, 1, Math.floor(startMinutes / 60), startMinutes % 60)),
      endTime: new Date(Date.UTC(1970, 0, 1, Math.floor(endMinutes / 60), endMinutes % 60)),
    },
    date,
    landing,
  );
  if (skip !== null) add({ kind: 'BREAK' });

  // The board's hard rules, as G1's swap search holds a landing to them.
  const facts = await readBoardFacts(tx, {
    academicYearId: placement.academicYearId,
    schoolId: placement.schoolId,
    gradeNumbering: context.gradeNumbering,
    basis: context.basis,
    groupIds: [...own],
    weekday,
    date: { day: date, localMinutes: (instant) => localMinutes(instant, timezone) },
  });
  const board = boardCodeOf(facts, [...own], { dayOfWeek: weekday, startMinutes, endMinutes });
  if (board !== null) add({ kind: board });
  return found;
}
