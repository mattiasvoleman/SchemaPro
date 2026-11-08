import type { LessonCancelCause, TeacherAssignmentRole } from '@prisma/client';

/*
 * SKOLANS DAG I ETT SVEP — what the gateway answers. The web builds its
 * rutnät from exactly these, so they are the contract of the phase.
 *
 * Times are minutes since the school's local midnight of the block's DATE
 * (DST-safe: a lesson at 08:15 reads 495 on both sides of the clock change),
 * never instants; the date is the CalendarLessons.date column's.
 */

/** What the school lets a TEACHER have of Skolans dag (SchoolDaySettings.teacherView). */
export type TeacherView = 'NONE' | 'ROOMS' | 'ALL';

/** Which part of the answer the caller may read: an administrator has everything. */
export interface SchoolDayAccess {
  /** Hela schemat, ledig personal and the reasons: administrators only. */
  admin: boolean;
  /** Classes and teachers as rows (ALL, or an administrator). */
  grids: boolean;
  /** The free teachers (and the reasons teachers are busy): administrators only, because absence, uppdrag and rastvakt are theirs to read. */
  freeTeachers: boolean;
}

export interface BreakView {
  name: string;
  kind: 'HOLIDAY' | 'STAFF_DAY';
  /** null = the whole school; else the groups of the answer the lov covers (breakCoversGroup). */
  groupIds: string[] | null;
  /** The årskurs span a narrowed lov covers (prao åk 9), for the words; both null for the whole school. */
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
}

export interface GridDay {
  date: string;
  /** ISO weekday, 1 = Monday. */
  weekday: number;
  breaks: BreakView[];
}

export interface GridGroup {
  id: string;
  name: string;
  kind: 'CLASS' | 'TEACHING_GROUP';
  gradeLevel: number | null;
  halfOfId: string | null;
}

export interface GridTeacher {
  id: string;
  name: string;
}

export interface GridRoom {
  id: string;
  name: string;
  code: string | null;
}

export interface GridSubject {
  id: string;
  name: string;
}

export interface GridLesson {
  id: string;
  date: string;
  start: number;
  end: number;
  /** SCHEDULED and COMPLETED hold their time; CANCELLED and RESCHEDULED are drawn but free everyone (holdsTime). */
  status: 'SCHEDULED' | 'CANCELLED' | 'COMPLETED' | 'RESCHEDULED';
  /** Administrators only: a teacher is told the lesson is cancelled, not why (TEACHER_UNAVAILABLE would say a colleague is away). */
  cancelCause: LessonCancelCause | null;
  subjectId: string;
  groupId: string;
  extraGroupIds: string[];
  roomId: string | null;
  /**
   * Empty for a caller who may not see teachers (ROOMS). The role is the administrators': a teacher is not told
   * that a teacher holds the lesson in someone's place, and a teacher marked as having a protected identity is left out
   * without a count: no field says that someone is missing.
   */
  teachers: Array<{ id: string; role: TeacherAssignmentRole | null }>;
  /** The lesson is the replacement lesson of a schemabrytande aktivitet (D3). */
  activity: boolean;
}

export type BlockKind =
  /** A room booking (PENDING or APPROVED), on the room and on the person who booked it. */
  | 'BOOKING'
  /** A room that cannot be used then: a closure, or a borrowed room outside what the loan gives. */
  | 'CLOSED'
  /** A room lent to another school of the huvudman in an approved window of the loan (Delade lokaler). */
  | 'LOAN'
  /** A rastvaktspass (administrators). */
  | 'PASS'
  /** An uppdrag's slot (administrators; the label is the uppdrag's name, never its note). */
  | 'DUTY'
  /** A teacher's UNAVAILABLE row (administrators). */
  | 'UNAVAILABLE'
  /** An ACTIVE absence (administrators; a span, never the reason). */
  | 'ABSENT';

export interface GridBlock {
  resource: 'TEACHER' | 'ROOM';
  resourceId: string;
  date: string;
  start: number;
  end: number;
  kind: BlockKind;
  /** The booking's title or the uppdrag's name; null for the rest and for a reader who may not see it. */
  label: string | null;
}

export interface SchoolDayView {
  from: string;
  to: string;
  timezone: string;
  access: SchoolDayAccess;
  days: GridDay[];
  groups: GridGroup[];
  teachers: GridTeacher[];
  rooms: GridRoom[];
  subjects: GridSubject[];
  lessons: GridLesson[];
  blocks: GridBlock[];
}

/** Why a teacher is not free (the rules of the Vikarietavla that say occupied; cover-rules.ts occupancyFindings). */
export type TeacherBusyCode =
  | 'ABSENT'
  | 'BUSY_LESSON'
  | 'BUSY_SUPERVISION'
  | 'BUSY_DUTY'
  | 'UNAVAILABLE'
  | 'BOOKED_ROOM'
  | 'POOL_NOT_DECLARED';

export type RoomBusyCode =
  | 'ROOM_IN_USE'
  | 'ROOM_BOOKED'
  | 'ROOM_CLOSED'
  /** Lent to another school in an approved window of a loan (room-bookings/loan-holds.ts ROOM_LENT). */
  | 'ROOM_LENT'
  /** The school's own room for a borrowed one, and the approved loans do not cover the interval (ROOM_BORROWED_OUTSIDE_LOAN). */
  | 'ROOM_BORROWED_OUTSIDE_LOAN';

export interface FreeTeacher {
  id: string;
  name: string;
}

export interface FreeRoom {
  id: string;
  name: string;
  code: string | null;
}

export interface BusyTeacher extends FreeTeacher {
  reasons: TeacherBusyCode[];
}

export interface BusyRoom extends FreeRoom {
  reasons: RoomBusyCode[];
}

export interface FreeView {
  date: string;
  /** 'HH:MM'. */
  from: string;
  to: string;
  access: SchoolDayAccess;
  /** The lov that closes (part of) the day: nobody is free on a holiday, a studiedag is the staff's. */
  breaks: BreakView[];
  /** Free over the whole interval; null for a caller who may not see teachers (ROOMS). */
  teachers: FreeTeacher[] | null;
  rooms: FreeRoom[];
  /** Administrators only: who is not free and by which rule. */
  busyTeachers: BusyTeacher[] | null;
  busyRooms: BusyRoom[] | null;
  /** Substitute-pool members without a declared window over the interval, left out of the free teachers (POOL_NOT_DECLARED). */
  poolLeftOut: number;
  /** The rules that decided the answer, by name: shown on the page so that nobody has to guess. */
  rules: { teachers: TeacherBusyCode[]; rooms: RoomBusyCode[] };
}

export interface SchoolDaySettingsView {
  teacherView: TeacherView;
  /** Whether a guardian is told of a pupil's move to a parallel lesson (Elevens lektion för dagen); off until the school says so. */
  guardianNoticeOnMove: boolean;
}
