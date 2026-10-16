import { Prisma, type PrismaClient } from '@prisma/client';
import { zonedTimeToUtc } from '../../common/utils/time';
import { metaOf, type Model } from './model';
import { dayOf } from './slice';

/**
 * S1's Attendance and Absence (SS12000-närvaro, migration 20261114090000),
 * read under the service principal and built field by field as
 * docs/integration-api.md "Attendances and Absences" says.
 *
 * WHAT LEAVES. An Attendance is one AttendanceRecords row: the lesson
 * (calendarEvent), the pupil (student), whether it is reported, and minutes
 * present, absent with a valid reason (giltig) and absent without (ogiltig),
 * by the närvarorapport's rule (lessonMinutes, minutesOf). An Absence is one
 * AbsenceReports row: the pupil, when, and whether it is a day of a granted
 * leave ("Beviljad ledighet", AbsenceReports.grantedLeave) or a reported
 * absence ("Anmäld frånvaro").
 *
 * READ THROUGH THE DATABASE'S TWO FUNCTIONS. The provider has no arm on
 * AttendanceRecords or AbsenceReports; app.ss12000_attendances and
 * app.ss12000_absences answer the columns below and nothing else, only to a
 * key that may read them (app.service_reads_attendance), only of the service
 * principal's school, only of active pupils (and attendance only of the
 * emitted years, calendar events' rule).
 *
 * NEVER ANSWERED, so never emitted: AttendanceRecords.note and recordedById
 * (S1's reporter: a member of staff's activity, not the pupil's attendance);
 * AttendanceRecords.recordedAt (S1's reportedTimestamp: the register stamps
 * it anew at every save, so it says when the register was last saved);
 * AbsenceReports.note, type (SICK, APPOINTMENT, OTHER: a reason by another
 * name) and reportedById (S1's registeredBy: a guardian's id to a key that
 * may not even see guardians); every column of LeaveRequests, the reason
 * above all. S1's absenceReason and otherAttendanceMinutes are never written.
 *
 * WHO. A pupil who is not active is not emitted, and their rows were buried
 * with the deactivation (app.ss12000_v_attendance_pupils). Purged rows are
 * gone from the tables, and gallring's DELETE buried them. Both are recorded
 * once a school has ever shared, also while it does not, so an integration
 * that reads again when the school starts again is told of them.
 *
 * WHEN. meta.modified is never before the moment the school's current run
 * of sharing began: a school that starts, or starts again, reads as
 * modified then, so an incremental read from before reads it whole.
 */

/** LATE counts this many minutes ogiltig frånvaro, as the närvarorapport does. */
export const LATE_MINUTES = 15;

export type AttendanceStatus = 'UNKNOWN' | 'PRESENT' | 'ABSENT' | 'LATE' | 'EXCUSED';

/**
 * A lesson's length in whole minutes, as the närvarorapport counts it
 * (web/app/[locale]/(app)/admin/reports/attendance-report.tsx): rounded,
 * and 0 for a lesson that does not end after it starts.
 */
export function lessonMinutes(startsAt: Date, endsAt: Date): number {
  const minutes = (endsAt.getTime() - startsAt.getTime()) / 60_000;
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
}

export interface AttendanceMinutes {
  attendanceMinutes: number;
  validAbsenceMinutes: number;
  invalidAbsenceMinutes: number;
}

/**
 * The närvarorapport's rule, per lesson: PRESENT is present all of it;
 * ABSENT is ogiltig all of it; EXCUSED is giltig all of it; LATE is
 * LATE_MINUTES ogiltig (at most the lesson) and present the rest. UNKNOWN
 * is not reported, and has no minutes.
 */
export function minutesOf(status: AttendanceStatus, minutes: number): AttendanceMinutes | null {
  switch (status) {
    case 'PRESENT':
      return { attendanceMinutes: minutes, validAbsenceMinutes: 0, invalidAbsenceMinutes: 0 };
    case 'ABSENT':
      return { attendanceMinutes: 0, validAbsenceMinutes: 0, invalidAbsenceMinutes: minutes };
    case 'EXCUSED':
      return { attendanceMinutes: 0, validAbsenceMinutes: minutes, invalidAbsenceMinutes: 0 };
    case 'LATE': {
      const late = Math.min(LATE_MINUTES, minutes);
      return { attendanceMinutes: minutes - late, validAbsenceMinutes: 0, invalidAbsenceMinutes: late };
    }
    default:
      return null;
  }
}

/**
 * Whether the request's key may read `scope` now: the key's own school, not
 * revoked, holding the scope, at a school whose decision in force shares
 * attendance. The database's question (app.service_reads_attendance), which
 * the two read functions and the versions' and tombstones' arms ask too, so
 * the gateway's 403 and what the database answers never disagree.
 */
export async function serviceReadsAttendance(tx: PrismaClient, scope: 'attendances.read' | 'absences.read'): Promise<boolean> {
  const [row] = await tx.$queryRaw<Array<{ reads: boolean }>>(Prisma.sql`SELECT app.service_reads_attendance(${scope}) AS reads`);
  return row?.reads === true;
}

/**
 * Whether the request's key may read the removals of `scope`'s resource
 * (app.service_reads_attendance_removals): as serviceReadsAttendance, but
 * at a school that has ever shared rather than one that shares now. Its
 * tombstones are an id and when it went, the instruction to delete what the
 * integration holds, so /deletedEntities answers them also while the school
 * has stopped, and its other categories with them.
 */
export async function serviceReadsAttendanceRemovals(tx: PrismaClient, scope: 'attendances.read' | 'absences.read'): Promise<boolean> {
  const [row] = await tx.$queryRaw<Array<{ reads: boolean }>>(Prisma.sql`SELECT app.service_reads_attendance_removals(${scope}) AS reads`);
  return row?.reads === true;
}

// ---------------------------------------------------------------------------
// Attendances: read and paged in SQL (a school records hundreds of thousands
// a year, and S1 gives /attendances no window).
// ---------------------------------------------------------------------------

export interface AttendanceRow {
  id: string;
  calendarLessonId: string;
  studentId: string;
  status: AttendanceStatus;
  createdAt: Date;
  startsAt: Date;
  endsAt: Date;
  studentGroupId: string;
  /** meta, as the database reckons it: never null while the school shares. */
  versionCreatedAt: Date | null;
  versionModifiedAt: Date | null;
}

export interface AttendanceQuery {
  ids?: readonly string[];
  lessons?: readonly string[];
  students?: readonly string[];
  /** The lesson's own group: the organisation filter, resolved to groups. */
  groups?: readonly string[];
  createdBefore?: string;
  createdAfter?: string;
  modifiedBefore?: string;
  modifiedAfter?: string;
  /** Keyset: ids after this one, ascending. */
  after?: string;
  /** At most this many rows. */
  limit?: number;
}

/**
 * app.ss12000_attendances' arguments, in its order, a filter not asked being
 * NULL: the index of each among the statement's values, so the specs'
 * in-memory school can answer the call by position. meta.modified
 * (versionModifiedAt) is the version's or the moment the school's current
 * run of sharing began, whichever is later, and the meta bounds compare it
 * at the millisecond an ISO string carries (S1: before inclusive, after
 * exclusive). The function's comment says how it is planned.
 */
export const ATTENDANCE_ARGUMENTS = {
  ids: 0,
  lessons: 1,
  students: 2,
  groups: 3,
  createdBefore: 4,
  createdAfter: 5,
  modifiedBefore: 6,
  modifiedAfter: 7,
  after: 8,
  limit: 9,
} as const;

export async function readAttendances(tx: PrismaClient, query: AttendanceQuery): Promise<AttendanceRow[]> {
  const lists = [query.ids, query.lessons, query.students, query.groups];
  if (lists.some((list) => list !== undefined && list.length === 0)) return [];
  const uuids = (list: readonly string[] | undefined) => (list === undefined ? null : [...list]);
  return tx.$queryRaw<AttendanceRow[]>(Prisma.sql`
    SELECT * FROM app.ss12000_attendances(
      ${uuids(query.ids)}::uuid[], ${uuids(query.lessons)}::uuid[], ${uuids(query.students)}::uuid[], ${uuids(query.groups)}::uuid[],
      ${query.createdBefore ?? null}::timestamptz, ${query.createdAfter ?? null}::timestamptz,
      ${query.modifiedBefore ?? null}::timestamptz, ${query.modifiedAfter ?? null}::timestamptz,
      ${query.after ?? null}::uuid, ${query.limit ?? null}::integer)`);
}

type Obj = Record<string, unknown> & { id: string };

/** The database's meta of a row (both functions answer it the same way). */
function versionOf(row: { createdAt: Date; versionCreatedAt: Date | null; versionModifiedAt: Date | null }) {
  return row.versionModifiedAt ? { createdAt: row.versionCreatedAt ?? row.createdAt, modifiedAt: row.versionModifiedAt } : undefined;
}

/** An S1 Attendance, or null when its pupil is not emitted. */
export function attendanceObject(model: Model, row: AttendanceRow): Obj | null {
  const student = model.personRef(row.studentId);
  if (!student) return null;
  const minutes = minutesOf(row.status, lessonMinutes(row.startsAt, row.endsAt));
  return {
    id: row.id,
    meta: metaOf(versionOf(row), row.createdAt, null),
    calendarEvent: { id: row.calendarLessonId },
    student,
    isReported: minutes !== null,
    ...(minutes ?? {}),
  };
}

// ---------------------------------------------------------------------------
// Absences: a school's reported and granted days, read whole (tens of
// thousands at most) and filtered in memory as the other resources are.
// ---------------------------------------------------------------------------

export interface AbsenceRow {
  id: string;
  studentId: string;
  /** YYYY-MM-DD. */
  date: string;
  /** HH:MM:SS on the school's clock, or null. */
  startTime: string | null;
  endTime: string | null;
  grantedLeave: boolean;
  createdAt: Date;
  /** meta, as app.ss12000_attendances has it. */
  versionCreatedAt: Date | null;
  versionModifiedAt: Date | null;
}

/** The school's absences of active pupils; only those ids, or those pupils', when asked. */
export async function readAbsences(tx: PrismaClient, only: { ids?: readonly string[]; students?: readonly string[] } = {}): Promise<AbsenceRow[]> {
  if (only.ids?.length === 0 || only.students?.length === 0) return [];
  const uuids = (list: readonly string[] | undefined) => (list === undefined ? null : [...list]);
  return tx.$queryRaw<AbsenceRow[]>(Prisma.sql`SELECT * FROM app.ss12000_absences(${uuids(only.ids)}::uuid[], ${uuids(only.students)}::uuid[])`);
}

/**
 * The absence as two instants in the school's timezone. Without both times
 * it is the whole day, local midnight to the next (the rule
 * AttendanceService.coveredBy applies to a lesson). A span that does not end
 * after it starts, which AbsenceReports_ends_after_it_starts refuses since
 * 20261114090000 but an older row may hold, is the whole day too: an absence
 * reported for the day, never an endTime before its startTime.
 */
export function absenceSpan(row: Pick<AbsenceRow, 'date' | 'startTime' | 'endTime'>, timeZone: string): { startTime: Date; endTime: Date } {
  if (row.startTime && row.endTime && row.endTime > row.startTime) {
    return { startTime: zonedTimeToUtc(row.date, row.startTime, timeZone), endTime: zonedTimeToUtc(row.date, row.endTime, timeZone) };
  }
  const next = new Date(`${row.date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { startTime: zonedTimeToUtc(row.date, '00:00:00', timeZone), endTime: zonedTimeToUtc(dayOf(next), '00:00:00', timeZone) };
}

export const ABSENCE_TYPE = {
  granted: 'Beviljad ledighet',
  reported: 'Anmäld frånvaro',
} as const;

/** An S1 Absence, or null when its pupil is not emitted. */
export function absenceObject(model: Model, row: AbsenceRow): Obj | null {
  const student = model.personRef(row.studentId);
  if (!student) return null;
  const span = absenceSpan(row, model.school.timezone);
  return {
    id: row.id,
    meta: metaOf(versionOf(row), row.createdAt, null),
    startTime: span.startTime.toISOString(),
    endTime: span.endTime.toISOString(),
    type: row.grantedLeave ? ABSENCE_TYPE.granted : ABSENCE_TYPE.reported,
    student,
  };
}
