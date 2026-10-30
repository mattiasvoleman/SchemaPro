import { createHash } from 'node:crypto';
import { Prisma, type LessonRecurrence, type PrismaClient } from '@prisma/client';
import { SLOT_MINUTES } from '../common/solver-grid';
import { busyBlocks, clockOf } from './other-school-busy';
import { borrowedReservations, lentReservations, type ApprovedWindow } from './room-loan-windows';

/**
 * Delade lokaler och lärare in the generator and the room optimisation: the
 * other schools' hold on this school's teachers and rooms, as the recurring
 * UNAVAILABLE reservations the engine already keeps.
 *
 *   TEACHER_BUSY   a shared teacher's lessons at another school of the
 *                  huvudman, the walk between the schools on both sides
 *                  (app.shared_teacher_busy, other-school-busy.ts);
 *   ROOM_LENT      a room of this school in an approved window of a loan to
 *                  another school;
 *   ROOM_BORROWED  this school's own room for a borrowed one, outside the
 *                  approved windows (room-loan-windows.ts).
 *
 * The engine's contract does not change: a hold is a reservation row like
 * one a school writes, on an anonymous teacher or room. Nothing of the other
 * school reaches the engine beyond the times. Each hold has an id of its own
 * that exists in no table (holdId): the gateway puts it through the
 * constraint map like a row's id, so a refusal that names the reservation
 * comes back to it, and reads the line as the other school's
 * (OTHER_SCHOOL_*), never as a reservation of the school's own.
 *
 * A school without another school of its huvudman reads one empty answer and
 * sends exactly the payload it sent before.
 *
 * The reads run in the generator's own transaction, under the scheduler's
 * principal: an administrator, who reads Schemaläggning and Planering, which
 * is what app.shared_teacher_busy and the loans' arms ask.
 */

export type HoldKind = 'TEACHER_BUSY' | 'ROOM_LENT' | 'ROOM_BORROWED';

export interface OtherSchoolHold {
  /** An id of its own, in no table: what the constraint map carries. */
  holdId: string;
  kind: HoldKind;
  resourceKind: 'TEACHER' | 'ROOM';
  /** This school's own Users row or room. */
  resourceId: string;
  dayOfWeek: number;
  /** 'HH:MM:SS', on the slot grid. */
  startTime: string;
  endTime: string;
  /** The other schools the hold is about, by name, in name order. */
  schools: string[];
}

export interface OtherSchoolHolds {
  holds: OtherSchoolHold[];
}

const EMPTY: OtherSchoolHolds = { holds: [] };
/** The name a hold gives a borrower that has left the huvudman, which the school can no longer read. */
const LEFT_HUVUDMAN = 'en skola som har lämnat huvudmannen';

/** A stable id for a hold: the same hold on the same run is the same id. */
export function holdId(schoolId: string, kind: HoldKind, resourceId: string, day: number, start: string, end: string): string {
  const hex = createHash('sha256').update(`delade:${schoolId}:${kind}:${resourceId}:${day}:${start}:${end}`).digest('hex');
  // A version-4-shaped uuid, so every reader of a constraint id takes it as one.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const day = (value: Date): string => value.toISOString().slice(0, 10);
const clock = (value: Date): string => value.toISOString().slice(11, 16);

/**
 * The holds for the year's dates, or none for a school without another
 * school of its huvudman. `teachers: false` reads the rooms' alone, for the
 * room optimisation, whose lessons keep their times.
 */
export async function readOtherSchoolHolds(
  tx: PrismaClient,
  academicYearId: string,
  schoolId: string,
  options: { teachers?: boolean } = {},
): Promise<OtherSchoolHolds> {
  const siblings = await tx.$queryRaw<Array<{ school_id: string; name: string }>>(
    Prisma.sql`SELECT school_id, name FROM app.sibling_schools()`,
  );
  if (siblings.length === 0) return EMPTY;
  const nameOf = new Map(siblings.map((row) => [row.school_id, row.name]));
  const year = await tx.academicYear.findUnique({ where: { id: academicYearId }, select: { startDate: true, endDate: true } });
  if (!year) return EMPTY;
  const from = day(year.startDate);
  const to = day(year.endDate);

  const busy = options.teachers === false ? [] : await tx.$queryRaw<
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
                 FROM app.shared_teacher_busy(${from}::date, ${to}::date)`,
  );
  // Every loan between this school and another of the huvudman the arms show.
  const loans = await tx.roomLoan.findMany({
    select: {
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

  const holds: OtherSchoolHold[] = [];
  // A borrower that has left the huvudman has no name to read: the owner
  // still holds the room for an approved loan until it ends the loan.
  const named = (ids: readonly string[]) =>
    [...new Set(ids.map((id) => nameOf.get(id) ?? LEFT_HUVUDMAN))].sort((a, b) => a.localeCompare(b, 'sv'));

  for (const block of busyBlocks(
    busy.map((row) => ({
      teacherId: row.teacher_id,
      schoolId: row.school_id,
      dayOfWeek: row.day_of_week,
      startTime: clock(row.start_time),
      endTime: clock(row.end_time),
      recurrence: row.recurrence,
      startDate: day(row.start_date),
      endDate: day(row.end_date),
      travelMinutes: row.travel_minutes,
    })),
    SLOT_MINUTES,
    from,
    to,
  )) {
    const start = clockOf(block.start);
    // 24:00 is no clock: the engine reads 23:59 as the end of the day.
    const end = block.end >= 24 * 60 ? '23:59:00' : clockOf(block.end);
    holds.push({
      holdId: holdId(schoolId, 'TEACHER_BUSY', block.teacherId, block.dayOfWeek, start, end),
      kind: 'TEACHER_BUSY',
      resourceKind: 'TEACHER',
      resourceId: block.teacherId,
      dayOfWeek: block.dayOfWeek,
      startTime: start,
      endTime: end,
      schools: named(block.schoolIds),
    });
  }

  const window = (loan: (typeof loans)[number], roomId: string): ApprovedWindow => ({
    roomId,
    dayOfWeek: loan.dayOfWeek,
    startTime: clock(loan.startTime),
    endTime: clock(loan.endTime),
    startDate: day(loan.startDate),
    endDate: day(loan.endDate),
  });
  const approved = loans.filter((loan) => loan.status === 'APPROVED');
  const lent = approved.filter((loan) => loan.ownerSchoolId === schoolId);
  for (const reservation of lentReservations(lent.map((loan) => window(loan, loan.roomId)), from, to)) {
    const borrowers = lent
      .filter((loan) => loan.roomId === reservation.roomId && loan.dayOfWeek === reservation.dayOfWeek)
      .map((loan) => loan.borrowerSchoolId);
    holds.push({
      holdId: holdId(schoolId, 'ROOM_LENT', reservation.roomId, reservation.dayOfWeek, reservation.startTime, reservation.endTime),
      kind: 'ROOM_LENT',
      resourceKind: 'ROOM',
      resourceId: reservation.roomId,
      dayOfWeek: reservation.dayOfWeek,
      startTime: reservation.startTime,
      endTime: reservation.endTime,
      schools: named(borrowers),
    });
  }

  // Every room the school holds a borrowed one by, whatever its loans' state:
  // a room whose loans are all ended takes no lesson at all. A request not
  // yet approved has no room (the approval makes it), so it holds nothing.
  const borrowedAll = loans.flatMap((loan) =>
    loan.borrowerSchoolId === schoolId && loan.localRoomId !== null ? [{ ...loan, localRoomId: loan.localRoomId }] : [],
  );
  const ownerOf = new Map(borrowedAll.map((loan) => [loan.localRoomId, loan.ownerSchoolId]));
  for (const reservation of borrowedReservations(
    [...ownerOf.keys()],
    borrowedAll.filter((loan) => loan.status === 'APPROVED').map((loan) => window(loan, loan.localRoomId)),
    from,
    to,
  )) {
    holds.push({
      holdId: holdId(schoolId, 'ROOM_BORROWED', reservation.roomId, reservation.dayOfWeek, reservation.startTime, reservation.endTime),
      kind: 'ROOM_BORROWED',
      resourceKind: 'ROOM',
      resourceId: reservation.roomId,
      dayOfWeek: reservation.dayOfWeek,
      startTime: reservation.startTime,
      endTime: reservation.endTime,
      schools: named([ownerOf.get(reservation.roomId)!]),
    });
  }
  return { holds };
}

/** The OTHER_SCHOOL_* code a hold's refusal is read as. */
export const HOLD_CODES: Readonly<Record<HoldKind, string>> = {
  TEACHER_BUSY: 'OTHER_SCHOOL_TEACHER_BUSY',
  ROOM_LENT: 'OTHER_SCHOOL_ROOM_LENT',
  ROOM_BORROWED: 'OTHER_SCHOOL_ROOM_BORROWED',
};


const DAY_PHRASE: Readonly<Record<number, string>> = {
  1: 'on Mondays',
  2: 'on Tuesdays',
  3: 'on Wednesdays',
  4: 'on Thursdays',
  5: 'on Fridays',
};

/**
 * A hold's line in English, the catalogue's sentence for its code
 * (optimization-engine/app/messages.py, held equal by
 * catalogue-sentences.spec.ts): the fallback a reader without a translation
 * shows. The web renders the code from its own catalogue with `params`.
 */
export function holdMessage(kind: HoldKind, params: Record<string, string | number>): string {
  const schools = String(params['schools'] ?? '');
  const when = `${DAY_PHRASE[Number(params['day'])] ?? `on day ${params['day']}`} ${params['start']}-${params['end']}`;
  switch (kind) {
    case 'TEACHER_BUSY':
      return (
        `A teacher named here also teaches at ${schools}: ${when}, the travel between the schools included, ` +
        `they are there, and lessons that have to be placed here do not fit beside it. Ask ${schools} ` +
        `to move the lesson, change the travel time under Rooms, The huvudman's other schools, or give ` +
        `the lessons here another teacher.`
      );
    case 'ROOM_LENT':
      return (
        `Room ${params['room']} is lent to ${schools} ${when}, and lessons that have to be placed here ` +
        `need it then. End the loan under Rooms, The huvudman's other schools, or let the lessons use ` +
        `another room.`
      );
    case 'ROOM_BORROWED':
      return (
        `Room ${params['room']} is borrowed from ${schools} and holds lessons only in the loan's times; ` +
        `${when} is outside them, and lessons that have to be placed need it then. Ask ${schools} for ` +
        `more times under Rooms, The huvudman's other schools, or let the lessons use another room.`
      );
  }
}
