import { Prisma, type PrismaClient } from '@prisma/client';
import type { AccessKind } from '../access-log/access-log';
import { STUDENT_BELOW, STUDENT_KEYS } from '../common/removal-inventory';

/**
 * Registerutdrag (GDPR art. 15): every table that holds a row about a person,
 * and what the extract does with it. The whole-school export's seven data
 * files cover what a school holds in bulk; the rest of what Rastra keeps about
 * a person is in tables a school never exports, and an extract that said "all
 * your data" and left them out would say what is not true.
 *
 * ONE LIST, THE REMOVAL'S. Which tables hold a person is already told, key by
 * key, by src/common/removal-inventory.ts (STUDENT_KEYS: every foreign key to
 * Users, held to pg_constraint by scripts/test/probe-massatgarder.ts; and the
 * tables a level down). This file decides, for each of those tables, one of
 * four things, and person-tables.spec.ts fails on a table that is in the
 * removal's list and not decided here, on a decision for a table that is not
 * in it, and on a dump that leaves out a person column the removal names. A
 * table added to the schema with a key to Users therefore fails a test until
 * somebody has said what an extract does with it.
 *
 *   - DUMPED: the rows where a person column is one of the persons asked for,
 *     every column, as the table has them (data/person/<table>.csv). A
 *     column that holds a token, a secret or a hash is written "(dold)".
 *   - COVERED by one of the seven data files, which say it better (ids
 *     resolved to addresses, the lesson's date and subject).
 *   - ACCOUNT: the person's own notice settings, devices and calendar feeds,
 *     which no administrator can read (no arm of row-level security), so an
 *     extract cannot hold them; it says they exist and are the person's to see
 *     in the app. The removal's dialog says the same of them.
 *   - EXCLUDED, with its reason.
 *
 * Skyddad identitet: a cell that holds a marked person's id (other than the
 * person the extract is about) is emptied, and counted in the manifest.
 */

export type PersonTableDecision =
  | { dump: PersonDump }
  | { covered: string }
  | { account: string }
  | { excluded: string };

export interface PersonDump {
  /** Columns holding a person: a row is the person's when any of them is one asked for. */
  columns: readonly string[];
  /** Rows that belong to a person through a parent row: [column, parent table, parent's person column]. */
  through?: ReadonlyArray<readonly [string, string, string]>;
  kind: AccessKind;
}

const dump = (
  columns: readonly string[],
  kind: AccessKind = 'PEOPLE',
  through: PersonDump['through'] = [],
): PersonTableDecision => ({ dump: { columns, kind, through } });

const staff = (columns: readonly string[], through?: PersonDump['through']) => dump(columns, 'EMPLOYMENT', through);
const away = (columns: readonly string[], through?: PersonDump['through']) => dump(columns, 'STAFF_ABSENCES', through);

/**
 * Every table of the removal's inventory, decided. Keyed by table name as the
 * catalogue has it.
 */
export const SUBJECT_ACCESS: Readonly<Record<string, PersonTableDecision>> = {
  // The seven data files.
  AttendanceRecords: { covered: 'data/narvaro.csv (the pupil\'s marks; the marks a teacher recorded are the pupils\' data, not the teacher\'s)' },
  GuardianStudents: { covered: 'data/kopplingar.csv' },
  AbsenceReports: { covered: 'data/franvaroanmalningar.csv' },
  LeaveRequests: { covered: 'data/ledigheter.csv' },
  Notifications: { covered: 'data/notiser.csv' },
  PersonalDataAccess: { covered: 'data/laslogg.csv (who read about the person, and what the person read)' },

  // Pupils.
  AbsenceWatchFindings: dump(['studentId'], 'ATTENDANCE'),
  MasterLessonStudents: dump(['studentId'], 'ROSTER'),
  CalendarLessonStudents: dump(['studentId'], 'ROSTER'),
  StudentGroupMembers: dump(['studentId'], 'ROSTER'),
  StudentEnrollments: dump(['studentId'], 'ROSTER'),
  TimplanStatements: dump(['studentId'], 'TEACHING_TIME'),

  // Anyone.
  UserRoleChanges: dump(['userId']),
  PersonProtections: dump(['userId']),
  RoomBookings: dump(['bookedById', 'decidedById']),
  RoomLoans: dump(['decidedById', 'requestedById']),
  HuvudmanSchools: dump(['acceptedById']),
  HuvudmanSchoolEvents: dump(['byUserId']),
  SchoolExports: dump(['requestedById']),

  // Staff: the post, the duties, the lessons and the cover.
  TeacherEmployments: staff(['userId']),
  TeacherEmploymentPeriods: staff(['userId']),
  TeacherEmploymentLogs: staff(['userId']),
  TeacherDuties: staff(['userId']),
  TeacherDutySlots: staff([], [
    ['teacherDutyId', 'TeacherDuties', 'userId'],
    ['availabilityConstraintId', 'AvailabilityConstraints', 'userId'],
  ]),
  TeacherWorkRules: dump(['userId']),
  TeacherSubjectQualifications: dump(['userId']),
  TeacherPublicLabels: dump(['userId']),
  AvailabilityConstraints: dump(['userId']),
  CalendarLessonTeachers: dump(['teacherId']),
  TeachingRequirements: dump(['teacherId', 'coTeacherId']),
  TeachingRequirementShares: dump(['teacherId']),
  MasterLessons: dump(['teacherId', 'coTeacherId']),
  Ss12000DutyLinks: dump(['userId']),
  SupervisionShifts: away(['userId']),
  SupervisionCovers: away(['substituteId', 'decidedByUserId', 'absentTeacherId'], [['shiftId', 'SupervisionShifts', 'userId']]),
  TeacherAbsences: away(['userId', 'createdByUserId', 'withdrawnByUserId']),
  TeacherAbsenceCovers: away(['decidedByUserId', 'substituteId', 'absentTeacherId']),
  SubstitutePoolMembers: away(['userId', 'createdByUserId']),
  SubstituteAvailabilities: away(['userId']),
  CoverRequestRecipients: away(['userId']),
  CoverConfirmations: away(['userId']),
  CoverRequestLessons: away([], [['absenceId', 'TeacherAbsences', 'userId']]),
  CoverRequests: dump(['requestedByUserId', 'acceptedByUserId']),
  SharedTeacherMarks: dump(['teacherId']),
  ScheduleActivityTeachers: dump(['teacherId']),

  // What the person decided, published or wrote.
  PublicTimetableLinks: dump(['targetTeacherId', 'createdByUserId']),
  TimplanStatementPublications: dump(['publishedByUserId']),
  TimetablePublications: dump(['publishedByUserId']),
  CancellationBatches: dump(['createdByUserId', 'reversedByUserId']),
  ScheduleActivities: dump(['createdByUserId', 'removedByUserId']),
  RetentionDecisions: dump(['decidedById']),
  LeaveDelegationDecisions: dump(['decidedById']),
  AttendanceSharingDecisions: dump(['decidedById']),
  LocalTimplans: dump(['decidedByUserId', 'gradeSpanSetByUserId']),
  LessonLogs: dump(['writtenById']),
  LessonSubstituteNotes: dump(['writtenById']),

  // The person's own account: no administrator reads it.
  NotificationOptOuts: { account: 'noticeSettings' },
  DevicePushTokens: { account: 'pushDevices' },
  PushTickets: { account: 'pushDevices' },
  LeaveRequestNotices: { account: 'notices' },
  CalendarFeeds: { account: 'calendarFeeds' },
};

/** The kinds of account the extract names without rows, in the order its README says them. */
export const ACCOUNT_KINDS: Readonly<Record<string, string>> = {
  noticeSettings: 'Notisinställningar (vilka notiser personen vill ha)',
  pushDevices: 'Enheter som tar emot push-notiser',
  notices: 'Personens egen kopia av ledighetsnotiser',
  calendarFeeds: 'Kalenderflöden som personen har skapat',
};

/** Every table the removal's inventory names: a key to Users, or a table a level down from one. */
export function inventoriedTables(): string[] {
  return [...new Set([...STUDENT_KEYS.map((key) => key.table), ...STUDENT_BELOW.map((key) => key.table)])].sort();
}

/** A table an extract dumps, with its file. */
export interface TableFile {
  table: string;
  path: string;
  dump: PersonDump;
}

export function tableFiles(): TableFile[] {
  return Object.entries(SUBJECT_ACCESS)
    .flatMap(([table, decision]) => ('dump' in decision ? [{ table, path: `data/person/${table.toLowerCase()}.csv`, dump: decision.dump }] : []))
    .sort((a, b) => a.table.localeCompare(b.table));
}

/** The inventoried table that has no schoolId column (a loan names two schools): row-level security keeps it to the school's own. The probe holds this to the catalogue. */
export const WITHOUT_SCHOOL_COLUMN: ReadonlySet<string> = new Set(['RoomLoans']);

const identifier = (name: string): Prisma.Sql => Prisma.raw(`"${name.replace(/"/g, '""')}"`);
const SECRET = /token|secret|password|hash|apikey/i;

/** The rows of `file.table` that are the persons' `ids`, as the table has them (column order kept). */
export async function readTable(tx: PrismaClient, schoolId: string, file: TableFile, ids: readonly string[]): Promise<Array<Record<string, unknown>>> {
  const list = Prisma.sql`${[...ids]}::uuid[]`;
  const conditions: Prisma.Sql[] = [
    ...file.dump.columns.map((column) => Prisma.sql`t.${identifier(column)} = ANY(${list})`),
    ...(file.dump.through ?? []).map(
      ([column, parent, parentColumn]) =>
        Prisma.sql`t.${identifier(column)} IN (SELECT p."id" FROM ${identifier(parent)} p WHERE p.${identifier(parentColumn)} = ANY(${list}))`,
    ),
  ];
  const rows = await tx.$queryRaw<Array<{ j: string }>>(
    Prisma.sql`SELECT to_json(t)::text AS j FROM ${identifier(file.table)} t
                WHERE ${WITHOUT_SCHOOL_COLUMN.has(file.table) ? Prisma.sql`true` : Prisma.sql`t."schoolId" = ${schoolId}::uuid`}
                  AND (${Prisma.join(conditions, ' OR ')})`,
  );
  return rows.map((row) => JSON.parse(row.j) as Record<string, unknown>);
}

/** A cell of a dumped row. A token, secret or hash is hidden; a marked person's id is emptied. */
export function cellOf(column: string, value: unknown, markedOut: ReadonlySet<string>): { text: string; held: boolean } {
  if (value === null || value === undefined) return { text: '', held: false };
  if (SECRET.test(column)) return { text: '(dold)', held: false };
  if (typeof value === 'string') return markedOut.has(value) ? { text: '', held: true } : { text: value, held: false };
  if (typeof value === 'object') {
    const text = JSON.stringify(value);
    for (const id of markedOut) if (text.includes(id)) return { text: '', held: true };
    return { text, held: false };
  }
  return { text: String(value), held: false };
}
