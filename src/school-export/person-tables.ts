import { Prisma, type PrismaClient } from '@prisma/client';
import type { AccessKind } from '../access-log/access-log';
import { STUDENT_BELOW, STUDENT_KEYS } from '../common/removal-inventory';
import { idForms, normalize, type TermIndex } from './free-text';

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
 * THE TABLES WITHOUT A KEY. A table that keeps a person's id without a foreign
 * key to Users (history that has to outlive the person, snapshots, the logs of
 * a school's own integrations) is not in the removal's inventory, since the
 * catalogue does not name it, and an extract that went by the inventory alone
 * would leave it out while saying "all". WITHOUT_KEY lists those columns, each
 * table decided the same four ways, and scripts/test/probe-school-export.ts
 * (k-i0) holds the list to the catalogue: a uuid column named like a person
 * (…UserId, …TeacherId, …StudentId, …GuardianId, …ById, actorId) with no key to
 * Users that is not decided here fails the probe.
 *
 * Skyddad identitet: a cell that holds a marked person's id (other than the
 * person the extract is about), or names one in free text, is emptied and
 * counted in the manifest. In the extract of a protected person every cell that
 * holds the id of any other user of the school is.
 */

export type PersonTableDecision =
  | { dump: PersonDump }
  | { covered: string }
  | { account: string }
  | { excluded: string };

export interface PersonDump {
  /** Columns holding a person: a row is the person's when any of them is one asked for. */
  columns: readonly string[];
  /** Columns of json holding person ids: a row is the person's when the json names one asked for. */
  inside?: readonly string[];
  /**
   * The rows are about a pupil (`column`) and a member of staff acts in them. When the pupil is not one of the persons asked
   * for, the pupil's id and the columns in `hides` (the pupil's state) are empty, and only the act is the extract's: who did
   * it and when. Without it a teacher's extract would carry the pupils the teacher marked found in a drill (M1 of the review).
   */
  pupil?: { column: string; hides: readonly string[] };
  /** Rows that belong to a person through a parent row: [column, parent table, parent's person column]. */
  through?: ReadonlyArray<readonly [string, string, string]>;
  kind: AccessKind;
}

const dump = (
  columns: readonly string[],
  kind: AccessKind = 'PEOPLE',
  through: PersonDump['through'] = [],
  inside: readonly string[] = [],
): PersonTableDecision => ({ dump: { columns, kind, through, inside } });

/** The rows are about a pupil: see PersonDump.pupil. */
const aboutPupil = (decision: PersonTableDecision, column: string, hides: readonly string[]): PersonTableDecision =>
  'dump' in decision ? { dump: { ...decision.dump, pupil: { column, hides } } } : decision;

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
  // Elevens lektion för dagen (20270122091000): the days a pupil was moved to a parallel lesson, and the moves a
  // member of staff made. A pupil's lessons are theirs, whoever moved them, but the row is about a pupil and a
  // member of staff acts in it: in the extract of the one who moved the pupil, the pupil, the two lessons and the
  // mark the move displaced (a status and a free note about a child, written by a colleague) are not the extract's,
  // only who moved and when (the review of #281, MEDEL-2). In the pupil's own, everything stays.
  LessonPupilMoves: aboutPupil(dump(['studentId', 'movedById'], 'ROSTER'), 'studentId', ['displacedMark', 'fromLessonId', 'toLessonId']),
  StudentGroupMembers: dump(['studentId'], 'ROSTER'),
  StudentEnrollments: dump(['studentId'], 'ROSTER'),
  TimplanStatements: dump(['studentId'], 'TEACHING_TIME'),

  // Anyone.
  UserRoleChanges: dump(['userId', 'actorId']),
  PersonProtections: dump(['userId']),
  RoomBookings: dump(['bookedById', 'decidedById']),
  RoomLoans: dump(['decidedById', 'requestedById']),
  HuvudmanSchools: dump(['acceptedById']),
  HuvudmanSchoolEvents: dump(['byUserId']),
  SchoolExports: dump(['requestedById']),

  // Staff: the post, the duties, the lessons and the cover.
  TeacherEmployments: staff(['userId']),
  TeacherEmploymentPeriods: staff(['userId']),
  TeacherEmploymentLogs: staff(['userId', 'actorId']),
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
  TeacherAbsenceCovers: dump(['decidedByUserId', 'substituteId', 'absentTeacherId'], 'STAFF_ABSENCES', [], ['removedTeachers']),
  SubstitutePoolMembers: away(['userId', 'createdByUserId']),
  SubstituteAvailabilities: away(['userId']),
  CoverRequestRecipients: away(['userId']),
  CoverConfirmations: away(['userId']),
  CoverRequestLessons: away([], [['absenceId', 'TeacherAbsences', 'userId']]),
  CoverRequests: dump(['requestedByUserId', 'acceptedByUserId']),
  // Kvittens (20270117091000): what a guardian was asked and when they confirmed (and the pupil it was about), and the
  // requests a member of staff wrote. The text of a request addressed to a person reaches them through their notices
  // (data/notiser.csv carries the title); the body is the sender's own writing and is in the sender's extract.
  AckReceipts: dump(['guardianId', 'studentId'], 'GUARDIANS'),
  AckRequests: dump(['authorId']),
  SharedTeacherMarks: dump(['teacherId']),
  // Klasslärarens schema (20270128090000): whom a class was given to and who gave it, and the drafts a klasslärare wrote
  // or published (their words are the dates and hours they asked for, and a note of at most 200 characters).
  ClassTeacherAppointments: dump(['userId', 'appointedByUserId']),
  ClassTeacherChanges: dump(['authorId', 'publishedByUserId']),
  ScheduleActivityTeachers: dump(['teacherId']),

  // What the person decided, published or wrote.
  PublicTimetableLinks: dump(['targetTeacherId', 'targetStudentId', 'createdByUserId']),
  PublicTimetableHidden: dump(['targetStudentId']),
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

  // Rapporteringsgrad (20270112090100): a teacher's held and reported lessons per day, and the ledger of the reminders.
  TeacherReportingDays: dump(['teacherId'], 'EMPLOYMENT'),
  ReportingReminders: {
    excluded:
      'En liggare över vilka lektioner en lärare påmints om. Ingen roll kan läsa tabellen (bara databasens påminnelsefunktion rör den), så en administratör kan inte lämna ut den; raderna följer med personen när hen tas bort.',
  },
  // Krisläge (20270113091000): who started and ended an alarm, the teacher on a call, the pupil on its list and the state they
  // were reported in, and the reports themselves. A person who is removed keeps their rows without them; the rows are theirs.
  CrisisAlarms: dump(['startedByUserId', 'endedByUserId']),
  CrisisCallTeachers: dump(['teacherId']),
  CrisisPupils: aboutPupil(dump(['studentId', 'stateByUserId'], 'ROSTER'), 'studentId', ['priorAbsentSource', 'state']),
  CrisisReports: aboutPupil(dump(['studentId', 'byUserId'], 'ROSTER'), 'studentId', ['state', 'foundInCallId']),

  // Tables that keep a person's id without a key to Users (WITHOUT_KEY): history, logs and the acts of a school's integrations.
  GuardianStudentHistory: dump(['guardianId', 'studentId', 'unlinkedById'], 'GUARDIANS'),
  PersonProtectionEvents: dump(['userId', 'actorId']),
  IntegrationApiKeys: dump(['createdById']),
  OptimizationJobs: dump(['actorId']),
  ScheduleCandidateRuns: dump(['createdById']),
  ScheduleChangeLogs: dump(['actorId']),
  ScheduleVersions: dump(['createdById']),
  Ss12000Sources: dump(['createdById']),
  Ss12000SyncRuns: dump(['appliedById', 'requestedById']),
  IntegrationKeyWebhookSecrets: { excluded: 'Bär bara en krypterad hemlighet och vem som satte den. Ingen administratör kan läsa tabellen och hemligheten lämnas aldrig ut.' },
  Ss12000SourceSecrets: { excluded: 'Bär bara en krypterad hemlighet och vem som satte den. Ingen administratör kan läsa tabellen och hemligheten lämnas aldrig ut.' },
  PublishedLessons: {
    excluded:
      'En kopia av lektionerna så som de såg ut vid varje publicering (lärare, grupper och elever per lektion). Personens lektioner står i MasterLessons, MasterLessonStudents och närvaron; kopian tillför inga uppgifter om personen utöver vilka versioner som publicerats.',
  },

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

/**
 * The person columns that have no foreign key to Users, by table: history that outlives the person, snapshots, and the
 * acts of a school's integrations. Every table here is decided in SUBJECT_ACCESS, and every column of a table that is
 * dumped is one that table's dump reads. Held to the catalogue by scripts/test/probe-school-export.ts (k-i0).
 */
export const WITHOUT_KEY: Readonly<Record<string, readonly string[]>> = {
  GuardianStudentHistory: ['guardianId', 'studentId', 'unlinkedById'],
  IntegrationApiKeys: ['createdById'],
  IntegrationKeyWebhookSecrets: ['setById'],
  OptimizationJobs: ['actorId'],
  PersonProtectionEvents: ['actorId', 'userId'],
  PublishedLessons: ['coTeacherId', 'studentIds', 'teacherId'],
  ScheduleCandidateRuns: ['createdById'],
  ScheduleChangeLogs: ['actorId'],
  ScheduleVersions: ['createdById'],
  Ss12000SourceSecrets: ['setById'],
  Ss12000Sources: ['createdById'],
  Ss12000SyncRuns: ['appliedById', 'requestedById'],
  TeacherAbsenceCovers: ['removedTeachers'],
  TeacherEmploymentLogs: ['actorId'],
  UserRoleChanges: ['actorId'],
};

/** Columns the probe's catalogue scan finds by name that do not hold a user of the school, and why. */
export const NOT_A_USER: Readonly<Record<string, string>> = {
  'HuvudmanApiKeys.createdById': 'a member of the huvudman (HuvudmanMembers)',
  'HuvudmanSchoolRequests.requestedById': 'a member of the huvudman (HuvudmanMembers)',
  'HuvudmanSchools.requestedById': 'a member of the huvudman (HuvudmanMembers)',
  'HuvudmanSchoolEvents.byMemberId': 'a member of the huvudman (HuvudmanMembers)',
  'PersonalDataAccess.huvudmanMemberId': 'a member of the huvudman (HuvudmanMembers); the läslogg file carries it as huvudmannens_medlem',
};

/** Every table the removal's inventory names: a key to Users, or a table a level down from one. */
export function inventoriedTables(): string[] {
  return [...new Set([...STUDENT_KEYS.map((key) => key.table), ...STUDENT_BELOW.map((key) => key.table)])].sort();
}

/** The tables an extract leaves out, with the reason it states. */
export function excludedTables(): Array<{ table: string; reason: string }> {
  return Object.entries(SUBJECT_ACCESS)
    .flatMap(([table, decision]) => ('excluded' in decision ? [{ table, reason: decision.excluded }] : []))
    .sort((a, b) => a.table.localeCompare(b.table));
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
    ...(file.dump.inside ?? []).map(
      (column) => Prisma.sql`EXISTS (SELECT 1 FROM unnest(${[...ids]}::text[]) i WHERE t.${identifier(column)}::text LIKE '%' || i || '%')`,
    ),
  ];
  const rows = await tx.$queryRaw<Array<{ j: string }>>(
    Prisma.sql`SELECT to_json(t)::text AS j FROM ${identifier(file.table)} t
                WHERE ${WITHOUT_SCHOOL_COLUMN.has(file.table) ? Prisma.sql`true` : Prisma.sql`t."schoolId" = ${schoolId}::uuid`}
                  AND (${Prisma.join(conditions, ' OR ')})`,
  );
  return rows.map((row) => JSON.parse(row.j) as Record<string, unknown>);
}

/** What a dumped cell must not carry. */
export interface CellRules {
  /** Marked persons the extract is not about: their ids are never written. */
  markedOut: ReadonlySet<string>;
  /** Their names in both orders and their addresses, normalized (free-text.ts): free text that holds one is not written. */
  markedTerms: readonly string[];
  /** The extract of a protected person: the id of any user of the school who is not asked for is not written. */
  strangers?: ReadonlySet<string>;
  /**
   * The names (both orders) and addresses of the school's other users, or in an extract of someone not protected of its
   * other pupils and guardians: free text that holds one is not written (a teacher's note about a drill that names a pupil).
   */
  strangerTerms?: TermIndex;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function carries(value: string, rules: CellRules): boolean {
  const lower = value.toLowerCase();
  for (const id of idForms([...rules.markedOut])) if (lower.includes(id)) return true;
  if (rules.markedTerms.length > 0) {
    const spaced = normalize(value);
    for (const term of rules.markedTerms) if (term !== '' && spaced.includes(term)) return true;
  }
  if (rules.strangers && rules.strangers.size > 0) {
    for (const found of value.match(UUID) ?? []) if (rules.strangers.has(found.toLowerCase())) return true;
  }
  // A word or two is no name; the index is for text.
  if (rules.strangerTerms && rules.strangerTerms.size > 0 && value.length >= 5 && rules.strangerTerms.found(value)) return true;
  return false;
}

/**
 * The pupil's part of the rows of a table that is about a pupil, emptied in place where the pupil is not one of `asked`
 * (PersonDump.pupil). Returns how many cells that held something were emptied.
 */
export function emptyPupilPart(file: TableFile, rows: Array<Record<string, unknown>>, asked: ReadonlySet<string>): number {
  const pupil = file.dump.pupil;
  if (!pupil) return 0;
  let emptied = 0;
  for (const row of rows) {
    const about = row[pupil.column];
    if (typeof about !== 'string' || asked.has(about)) continue;
    for (const column of [pupil.column, ...pupil.hides]) {
      if (row[column] !== null && row[column] !== undefined) emptied += 1;
      row[column] = null;
    }
  }
  return emptied;
}

/** A cell of a dumped row. A token, secret or hash is hidden; so is a cell that carries a person the extract must not. */
export function cellOf(column: string, value: unknown, rules: CellRules): { text: string; held: boolean } {
  if (value === null || value === undefined) return { text: '', held: false };
  if (SECRET.test(column)) return { text: '(dold)', held: false };
  const text = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (typeof value !== 'number' && typeof value !== 'boolean' && carries(text, rules)) return { text: '', held: true };
  return { text, held: false };
}
