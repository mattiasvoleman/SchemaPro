import { Prisma, type LessonRecurrence, type PrismaClient } from '@prisma/client';
import { lessonLabel, type GateLesson } from './publication-gates.reader';
import type { GateEntry, GateFinding } from './publication-gates';
import { otherSchoolClashes, type BusyLesson, type LoanWindow } from './other-school-clashes';

/**
 * PUB_OTHER_SCHOOL (Delade lokaler och lärare): the lessons this publish
 * would put in the calendar that meet another school of the huvudman: a
 * shared teacher's lesson there, the walk between the schools counted; a
 * room lent to it in an approved window; or the school's own room for a
 * borrowed one outside every approved window (other-school-clashes.ts).
 *
 * Read in the publish's own transaction, on both schools: each compares its
 * own grundschema with the other school's grundschema and the loans between
 * them, and every edit is made before the publish reads, so the school that
 * publishes last sees a clash whoever made it. Under the policy for clashes
 * (gateClashes): WARN by default.
 *
 * Through the database's narrow reads only (app.shared_teacher_busy, the
 * loans' arms, app.sibling_schools): the other school's lesson is a weekday,
 * a time, weeks and dates, never its subject, class or room. A school
 * without another school of its huvudman reads one empty answer and finds
 * nothing.
 */

const WEEKDAY = ['', 'mån', 'tis', 'ons', 'tors', 'fre', 'lör', 'sön'];
const day = (value: Date): string => value.toISOString().slice(0, 10);
const clock = (value: Date): string => value.toISOString().slice(11, 16);

export async function otherSchoolFinding(
  tx: PrismaClient,
  schoolId: string,
  lessons: readonly GateLesson[],
  window: { from: string; to: string; yearStart: string; yearEnd: string },
): Promise<GateFinding> {
  const none: GateFinding = { code: 'PUB_OTHER_SCHOOL', count: 0 };
  const siblings = await tx.$queryRaw<Array<{ school_id: string; name: string }>>(
    Prisma.sql`SELECT school_id, name FROM app.sibling_schools()`,
  );
  // Without another school of the huvudman there is no shared teacher, but
  // the loans are still read: the owner keeps an approved loan of its room
  // after the borrower, or it, has left, until it ends it.
  const schoolName = new Map(siblings.map((row) => [row.school_id, row.name]));

  const busy = siblings.length === 0 ? [] : await tx.$queryRaw<
    Array<{
      teacher_id: string;
      school_id: string;
      day_of_week: number;
      start_time: Date;
      end_time: Date;
      recurrence: LessonRecurrence;
      start_date: Date;
      end_date: Date;
      travel_minutes: number | null;
    }>
  >(
    Prisma.sql`SELECT teacher_id, school_id, day_of_week, start_time, end_time, recurrence, start_date, end_date, travel_minutes
                 FROM app.shared_teacher_busy(${window.from}::date, ${window.to}::date)`,
  );
  const loans = await tx.roomLoan.findMany({
    select: {
      id: true,
      status: true,
      ownerSchoolId: true,
      borrowerSchoolId: true,
      roomId: true,
      localRoomId: true,
      dayOfWeek: true,
      startTime: true,
      endTime: true,
      startDate: true,
      endDate: true,
    },
  });

  const busyLessons: BusyLesson[] = busy.map((row) => ({
    teacherId: row.teacher_id,
    schoolId: row.school_id,
    dayOfWeek: row.day_of_week,
    startTime: clock(row.start_time),
    endTime: clock(row.end_time),
    recurrence: row.recurrence,
    startDate: day(row.start_date),
    endDate: day(row.end_date),
    travelMinutes: row.travel_minutes,
  }));
  const windowOf = (loan: (typeof loans)[number], roomId: string, otherSchool: string): LoanWindow => ({
    loanId: loan.id,
    roomId,
    schoolId: otherSchool,
    dayOfWeek: loan.dayOfWeek,
    startTime: clock(loan.startTime),
    endTime: clock(loan.endTime),
    startDate: day(loan.startDate),
    endDate: day(loan.endDate),
  });
  const approved = loans.filter((loan) => loan.status === 'APPROVED');
  const lent = approved.filter((loan) => loan.ownerSchoolId === schoolId).map((loan) => windowOf(loan, loan.roomId, loan.borrowerSchoolId));
  // A request not yet approved has no room of the school's (the approval
  // makes it): it holds nothing, and no lesson stands in it.
  const borrowedAll = loans.flatMap((loan) =>
    loan.borrowerSchoolId === schoolId && loan.localRoomId !== null ? [{ ...loan, localRoomId: loan.localRoomId }] : [],
  );
  const borrowed = borrowedAll
    .filter((loan) => loan.status === 'APPROVED')
    .map((loan) => windowOf(loan, loan.localRoomId, loan.ownerSchoolId));
  const localRoomIds = new Set(borrowedAll.map((loan) => loan.localRoomId));
  const ownerOfLocal = new Map(borrowedAll.map((loan) => [loan.localRoomId, loan.ownerSchoolId]));

  // The dates each lesson runs in this publish: its own period within the
  // year, clipped to the publish's window.
  const placed = lessons.filter((lesson) => !lesson.isParked);
  const byId = new Map(placed.map((lesson) => [lesson.id, lesson]));
  const clashes = otherSchoolClashes({
    lessons: placed.map((lesson) => {
      const from = lesson.startDate ?? window.yearStart;
      const to = lesson.endDate ?? window.yearEnd;
      return {
        id: lesson.id,
        teacherIds: [lesson.teacherId, lesson.coTeacherId].filter((id): id is string => id !== null),
        roomId: lesson.roomId,
        dayOfWeek: lesson.dayOfWeek,
        startTime: lesson.startTime,
        endTime: lesson.endTime,
        recurrence: lesson.recurrence,
        startDate: from > window.from ? from : window.from,
        endDate: to < window.to ? to : window.to,
      };
    }),
    busy: busyLessons,
    lent,
    borrowed,
    localRoomIds,
  });
  if (clashes.length === 0) return none;

  // The school's own names: its teachers and its rooms.
  const teacherIds = [...new Set(clashes.flatMap((clash) => (clash.kind === 'TEACHER' ? [clash.teacherId] : [])))];
  const roomIds = [...new Set(clashes.flatMap((clash) => (clash.kind === 'TEACHER' ? [] : [clash.kind === 'LENT_ROOM' ? clash.window.roomId : clash.roomId])))];
  const teachers = teacherIds.length
    ? new Map(
        (await tx.user.findMany({ where: { id: { in: teacherIds } }, select: { id: true, firstName: true, lastName: true } })).map(
          (person) => [person.id, `${person.firstName} ${person.lastName}`],
        ),
      )
    : new Map<string, string>();
  const rooms = roomIds.length
    ? new Map((await tx.room.findMany({ where: { id: { in: roomIds } }, select: { id: true, name: true } })).map((room) => [room.id, room.name]))
    : new Map<string, string>();

  const entries: GateEntry[] = clashes.map((clash) => {
    const lesson = byId.get(clash.lessonId)!;
    const base = lessonLabel(lesson);
    if (clash.kind === 'TEACHER') {
      const busyAt = `${WEEKDAY[clash.busy.dayOfWeek]} ${clash.busy.startTime}–${clash.busy.endTime}`;
      const walk = clash.busy.travelMinutes ? `, restid ${clash.busy.travelMinutes} min` : '';
      return {
        label: `${base}: ${teachers.get(clash.teacherId) ?? 'läraren'} har en lektion på ${schoolName.get(clash.busy.schoolId) ?? 'en annan skola'} ${busyAt}${walk}`,
        masterLessonId: lesson.id,
        teacherId: clash.teacherId,
      };
    }
    if (clash.kind === 'LENT_ROOM') {
      const lentAt = `${WEEKDAY[clash.window.dayOfWeek]} ${clash.window.startTime}–${clash.window.endTime}`;
      return {
        label: `${base}: ${rooms.get(clash.window.roomId) ?? 'salen'} är utlånad till ${schoolName.get(clash.window.schoolId) ?? 'en skola som har lämnat huvudmannen'} ${lentAt}`,
        masterLessonId: lesson.id,
      };
    }
    return {
      label: `${base}: ${rooms.get(clash.roomId) ?? 'salen'} är lånad av ${schoolName.get(ownerOfLocal.get(clash.roomId) ?? '') ?? 'en annan skola'}, och inget godkänt lån täcker lektionen`,
      masterLessonId: lesson.id,
    };
  });
  return { code: 'PUB_OTHER_SCHOOL', count: entries.length, entries };
}
