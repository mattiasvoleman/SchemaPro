import { AdminArea, AdminProfile } from '@prisma/client';

/**
 * Roller i skolan: which administrator writes what.
 *
 * The areas themselves are the Prisma enum `AdminArea`, which is also the
 * database's type, so the list exists once. This module holds the matrix the
 * gateway enforces (@Area, @Decides) and that the database states in
 * app.admin_profile_writes() and app.admin_profile_decides() (migration
 * 20261110090000). They are held equal three ways:
 *
 *   - admin-areas.spec.ts reads the migration's function and compares it;
 *   - the same spec compares web/lib/admin-areas.ts, the web's copy;
 *   - the RLS suite's role × table matrix (section 116), generated from
 *     TABLE_WRITE_GATES below by scripts/test/generate-rls-area-matrix.ts,
 *     runs every profile against every table in the database.
 *
 * Every profile reads every area. Tjänst % and nedsättning are the one read
 * that is narrower: FULL, REKTOR and HR-läs (profileReadsHr).
 *
 * LASARE, the läsare (Läsbehörighet, 20261120100000), writes no area and
 * decides nothing: the read-only staff role. Every write it attempts is
 * refused by name, and the web opens every page to it read-only.
 */

/** Every area, in the enum's order. */
export const ADMIN_AREAS: readonly AdminArea[] = Object.values(AdminArea);

/** Which areas each profile writes. app.admin_profile_writes() in the database. */
export const PROFILE_WRITES: Readonly<Record<AdminProfile, readonly AdminArea[]>> = {
  FULL: ['PLANERING', 'SCHEMALAGGNING', 'PUBLICERING', 'DRIFT', 'PERSONAL', 'INTEGRATIONER'],
  REKTOR: ['PLANERING', 'SCHEMALAGGNING', 'PUBLICERING', 'DRIFT', 'PERSONAL', 'INTEGRATIONER'],
  SCHEMALAGGARE: ['PLANERING', 'SCHEMALAGGNING', 'PUBLICERING', 'DRIFT'],
  EXPEDITION: ['DRIFT', 'PERSONAL'],
  LASARE: [],
};

/**
 * Who owns the decisions: who is an administrator and with which profile,
 * HR-läs, tjänst % and nedsättning, and dataskydd (gallring). Rektor, and
 * full, which is what every administrator was before profiles.
 * app.admin_profile_decides() in the database.
 */
export const PROFILE_DECIDES: Readonly<Record<AdminProfile, boolean>> = {
  FULL: true,
  REKTOR: true,
  SCHEMALAGGARE: false,
  EXPEDITION: false,
  LASARE: false,
};

/** The areas' names in Swedish copy, as the menu and the 403s say them. */
export const AREA_LABELS: Readonly<Record<AdminArea, string>> = {
  PLANERING: 'Planering',
  SCHEMALAGGNING: 'Schemaläggning',
  PUBLICERING: 'Publicering',
  DRIFT: 'Drift',
  PERSONAL: 'Personal',
  INTEGRATIONER: 'Integrationer',
};

/** The profiles' names in Swedish copy. */
export const PROFILE_LABELS: Readonly<Record<AdminProfile, string>> = {
  FULL: 'Fullständig administratör',
  REKTOR: 'Rektor',
  SCHEMALAGGARE: 'Schemaläggare',
  EXPEDITION: 'Expedition',
  LASARE: 'Läsare',
};

/** Each profile as the one who does something, in a Swedish sentence: "Det gör rektor eller en schemaläggare." */
const PROFILE_DOERS: Readonly<Record<AdminProfile, string>> = {
  REKTOR: 'rektor',
  FULL: 'en fullständig administratör',
  SCHEMALAGGARE: 'en schemaläggare',
  EXPEDITION: 'expeditionen',
  LASARE: 'en läsare',
};

/**
 * Who writes the area, as a Swedish list: "rektor, en fullständig
 * administratör eller en schemaläggare". Rektor first, then full, then the
 * narrower profiles in the enum's order; read off PROFILE_WRITES, so a
 * profile that gains an area is named without a second edit.
 */
export function writersOf(area: AdminArea): string {
  const order: AdminProfile[] = ['REKTOR', 'FULL', ...Object.values(AdminProfile).filter((p) => p !== 'REKTOR' && p !== 'FULL')];
  const names = order.filter((profile) => profileWrites(profile, area)).map((profile) => PROFILE_DOERS[profile]);
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} eller ${names[names.length - 1]}`;
}

export function profileWrites(profile: AdminProfile | null | undefined, area: AdminArea): boolean {
  return profile != null && PROFILE_WRITES[profile].includes(area);
}

export function profileDecides(profile: AdminProfile | null | undefined): boolean {
  return profile != null && PROFILE_DECIDES[profile];
}

/** May the profile read tjänst % and nedsättning? Deciders, and HR-läs. */
export function profileReadsHr(
  profile: AdminProfile | null | undefined,
  hrRead: boolean | null | undefined,
): boolean {
  return profileDecides(profile) || (profile != null && hrRead === true);
}

/** A write gate: an area, or the decisions. */
export type WriteGate = AdminArea | 'DECIDES';

/** The gates on an administrator's insert, update and delete of one table. */
export interface TableWriteGates {
  insert: readonly WriteGate[];
  update: readonly WriteGate[];
  delete: readonly WriteGate[];
  /**
   * Who reads the table, when it is not every administrator. The one such
   * table is the läslogg (PersonalDataAccess): who has read whose personal
   * data is dataskydd's, so the decisions'.
   */
  read?: readonly WriteGate[];
}

/** All three commands behind one gate: the tables whose admin arm was FOR ALL. */
const only = (gate: WriteGate): TableWriteGates => ({ insert: [gate], update: [gate], delete: [gate] });
/** Some commands behind one gate, the rest refused to every administrator as before. */
const just = (gate: WriteGate, ...commands: (keyof TableWriteGates)[]): TableWriteGates => ({
  insert: commands.includes('insert') ? [gate] : [],
  update: commands.includes('update') ? [gate] : [],
  delete: commands.includes('delete') ? [gate] : [],
});
/** Read by every administrator, written by none (a trigger or a job writes it). */
const readOnly: TableWriteGates = { insert: [], update: [], delete: [] };

/**
 * Every table an administrator's arm reaches, and the gate migration
 * 20261110100000 put on each write. A profile may make the write when it
 * holds any one of the command's gates; a command with no gate is one no
 * administrator had before either, and stays refused to every profile. The
 * RLS matrix (section 116) runs every profile against every cell, and
 * section 106 holds this list to the catalogue: no table missing, no command
 * an arm admits that is not here.
 *
 * Two tables are not a single area:
 *  - Users: the roster is PERSONAL, and a planner (PLANERING) may move a
 *    pupil between classes, which is what Aktivera does; a trigger holds
 *    that update to the class alone. Creating, changing or removing an
 *    administrator, and any role, profile or HR-läs, is a decision besides
 *    (Users_administrators_are_decided).
 *  - TeacherEmployments: the post holds tjänst % and nedsättning, which only
 *    a decider writes.
 */
export const TABLE_WRITE_GATES: Readonly<Record<string, TableWriteGates>> = {
  // Planering: grunddata, the timplan and every rule the generator reads.
  AcademicYears: only('PLANERING'),
  AcademicYearTimplans: only('PLANERING'),
  AvailabilityConstraints: only('PLANERING'),
  FrameTimes: only('PLANERING'),
  LocalTimplanEntries: only('PLANERING'),
  LocalTimplans: only('PLANERING'),
  LunchServings: only('PLANERING'),
  LunchSettings: only('PLANERING'),
  Rasts: only('PLANERING'),
  RoomPreferenceRooms: only('PLANERING'),
  RoomPreferences: only('PLANERING'),
  RoomTypes: only('PLANERING'),
  Rooms: only('PLANERING'),
  SchoolBreaks: only('PLANERING'),
  // Skolenheter: the school's units and their codes, grunddata.
  SchoolUnits: only('PLANERING'),
  // Skolområden och restid: the sites, and the minutes between them, as the rooms.
  SiteTravelTimes: only('PLANERING'),
  Sites: only('PLANERING'),
  Schools: just('PLANERING', 'update'),
  StaffingPolicies: only('PLANERING'),
  StudentGroupMembers: only('PLANERING'),
  StudentGroups: only('PLANERING'),
  Subjects: only('PLANERING'),
  TeacherDuties: only('PLANERING'),
  // A link is deleted and made again, never updated (no UPDATE grant).
  TeacherDutySlots: just('PLANERING', 'insert', 'delete'),
  TeacherSubjectQualifications: only('PLANERING'),
  TeacherWorkRules: only('PLANERING'),
  // Parallella block: requirements taught side by side, part of the timplan.
  TeachingBlocks: only('PLANERING'),
  TeachingRequirements: only('PLANERING'),

  // Schemaläggning: the grundschema, its versions, and what Generera writes.
  LunchSittings: only('SCHEMALAGGNING'),
  MasterLessonGroups: only('SCHEMALAGGNING'),
  MasterLessonStudents: only('SCHEMALAGGNING'),
  MasterLessons: only('SCHEMALAGGNING'),
  OptimizationJobs: only('SCHEMALAGGNING'),
  ScheduleChangeLogs: just('SCHEMALAGGNING', 'insert'),
  ScheduleVersions: only('SCHEMALAGGNING'),

  // Publicering: what is published, to whom, and Schemavisaren.
  PublicTimetableLinks: only('PUBLICERING'),
  PublicationPendingRemovals: just('PUBLICERING', 'delete'),
  PublicationSettings: only('PUBLICERING'),
  PublishedLessons: just('PUBLICERING', 'insert', 'update'),
  PublishedLunchSittings: just('PUBLICERING', 'insert'),
  TeacherPublicLabels: only('PUBLICERING'),
  TimetablePublications: just('PUBLICERING', 'insert'),
  TimplanStatementPublications: only('PUBLICERING'),
  TimplanStatements: only('PUBLICERING'),

  // Drift: the dated school day. TimplanCredits are here because an
  // avbokning writes them (a friluftsdag that counts as teaching time).
  AbsenceReports: only('DRIFT'),
  AttendanceRecords: only('DRIFT'),
  CalendarLessonGroups: only('DRIFT'),
  CalendarLessonStudents: only('DRIFT'),
  CalendarLessonTeachers: only('DRIFT'),
  CalendarLessons: only('DRIFT'),
  CalendarLunches: only('DRIFT'),
  CalendarRasts: only('DRIFT'),
  CancellationBatchCredits: only('DRIFT'),
  CancellationBatchLessons: only('DRIFT'),
  CancellationBatches: only('DRIFT'),
  CoverSettings: only('DRIFT'),
  LeaveRequests: only('DRIFT'),
  Notifications: just('DRIFT', 'insert'),
  RoomBookings: only('DRIFT'),
  SubstituteAvailabilities: only('DRIFT'),
  SubstitutePoolMembers: only('DRIFT'),
  TeacherAbsenceCovers: only('DRIFT'),
  TeacherAbsenceReasons: only('DRIFT'),
  TeacherAbsences: only('DRIFT'),
  TimplanCredits: only('DRIFT'),

  // Personal: the roster.
  GuardianStudents: only('PERSONAL'),
  Users: { insert: ['PERSONAL'], update: ['PERSONAL', 'PLANERING'], delete: ['PERSONAL'] },

  // Integrationer: keys, SS12000 and the school's sign-in.
  IntegrationApiKeys: only('INTEGRATIONER'),
  SchoolSignInMethods: only('INTEGRATIONER'),
  Ss12000DutyLinks: just('INTEGRATIONER', 'insert', 'update'),
  Ss12000Sources: just('INTEGRATIONER', 'insert', 'update'),
  Ss12000Subscriptions: just('INTEGRATIONER', 'update'),
  Ss12000SyncChanges: just('INTEGRATIONER', 'update'),
  Ss12000SyncRuns: just('INTEGRATIONER', 'insert', 'update'),

  // The decisions. A delegation of leave decisions to the mentors is
  // rektor's (Mentorns ledighetsbeslut); a period of a post changes tjänst %
  // like the post (Tjänstens perioder); sharing pupils' attendance with
  // integrations rests on the school's konsekvensbedömning, like gallring
  // and sharing tjänst % (SS12000-närvaro, 20261114090000).
  AttendanceSharingDecisions: just('DECIDES', 'insert'),
  LeaveDelegationDecisions: just('DECIDES', 'insert'),
  RetentionDecisions: just('DECIDES', 'insert'),
  TeacherEmploymentPeriods: only('DECIDES'),
  TeacherEmployments: only('DECIDES'),

  // Read by every administrator; written by a trigger or a job.
  GallringRuns: readOnly,
  GuardianStudentHistory: readOnly,
  Ss12000SubscriptionDeliveries: readOnly,
  StudentEnrollments: readOnly,
  TeacherEmploymentLogs: readOnly,
  UserRoleChanges: readOnly,

  // Read by those who decide: the läslogg (20261026091000), dataskydd's.
  PersonalDataAccess: { ...readOnly, read: ['DECIDES'] },
};

/** May the profile make this write to this table? The matrix's own reading of TABLE_WRITE_GATES. */
export function profileWritesTable(
  profile: AdminProfile,
  table: string,
  command: 'insert' | 'update' | 'delete',
): boolean {
  const gates = TABLE_WRITE_GATES[table];
  if (!gates) return false;
  return gates[command].some((gate) =>
    gate === 'DECIDES' ? profileDecides(profile) : profileWrites(profile, gate),
  );
}
