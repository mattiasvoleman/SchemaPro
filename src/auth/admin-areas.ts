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
  // Delade lokaler och lärare: the minutes to another school of the huvudman,
  // as the sites'. A room loan is read by every administrator and written by
  // none: app.room_loan_request/_decide/_withdraw/_revoke ask PLANERING.
  SchoolTravelTimes: only('PLANERING'),
  RoomLoans: readOnly,
  // A school's word that its own teacher is shared with another school of
  // the huvudman: a mark is made or removed, never changed.
  SharedTeacherMarks: just('PLANERING', 'insert', 'delete'),
  Schools: just('PLANERING', 'update'),
  StaffingPolicies: only('PLANERING'),
  StudentGroupMembers: only('PLANERING'),
  StudentGroups: only('PLANERING'),
  Subjects: only('PLANERING'),
  // Rastvaktsschema: the areas and the passes, written as the uppdrag are.
  SupervisionAreas: only('PLANERING'),
  SupervisionShifts: only('PLANERING'),
  TeacherDuties: only('PLANERING'),
  // A link is deleted and made again, never updated (no UPDATE grant).
  TeacherDutySlots: just('PLANERING', 'insert', 'delete'),
  TeacherSubjectQualifications: only('PLANERING'),
  TeacherWorkRules: only('PLANERING'),
  // Parallella block: requirements taught side by side, part of the timplan.
  TeachingBlocks: only('PLANERING'),
  // Delade lektioner: which of a post's lessons another teacher takes, as the post.
  TeachingRequirementShares: only('PLANERING'),
  // Förlagda poster: the day, time and room a school gave one of a post's lessons, as the post.
  TeachingRequirementPlacements: only('PLANERING'),
  TeachingRequirements: only('PLANERING'),

  // Schemaläggning: the grundschema, its versions, and what Generera writes.
  LunchSittings: only('SCHEMALAGGNING'),
  MasterLessonGroups: only('SCHEMALAGGNING'),
  MasterLessonStudents: only('SCHEMALAGGNING'),
  MasterLessons: only('SCHEMALAGGNING'),
  OptimizationJobs: only('SCHEMALAGGNING'),
  // Schemaförslag (20261125090000): a candidate is stored once and removed
  // with its run, never changed (no UPDATE grant).
  ScheduleCandidateRuns: only('SCHEMALAGGNING'),
  ScheduleCandidates: just('SCHEMALAGGNING', 'insert', 'delete'),
  ScheduleChangeLogs: just('SCHEMALAGGNING', 'insert'),
  ScheduleVersions: only('SCHEMALAGGNING'),
  // Klasslärarens schema (20270128090000): the appointment and the open times are the schemaläggare's
  // to make; the school's option to let a klasslärare publish is Publicering's, and a draft is written
  // by the klasslärare alone, so an administrator only publishes it (the status) or discards it.
  ClassTeacherAppointments: only('SCHEMALAGGNING'),
  ClassTeacherOpenTimes: only('SCHEMALAGGNING'),
  ClassTeacherSettings: just('PUBLICERING', 'insert', 'update'),
  ClassTeacherChanges: just('PUBLICERING', 'update', 'delete'),

  // Publicering: what is published, to whom, and Schemavisaren.
  PublicTimetableLinks: only('PUBLICERING'),
  // Schemavisarens lägen (20270118090000): a schedule hidden, or shown again; never edited.
  PublicTimetableHidden: just('PUBLICERING', 'insert', 'delete'),
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
  // Frånvarobevakning (20261231090100): the switch and the limits are Drift's, as the
  // attendance and the leave they count. The findings are written by
  // app.absence_watch_evaluate and the ledger by app.absence_watch_digest: no
  // administrator's write reaches either, and the switch is never deleted.
  // Kvittens (20270117091000): the switch and the reminder time are Drift's, as the leave and the
  // notices they sit beside. A request and its receipts are written once, by the author, in one
  // transaction; no administrator changes or removes one (a job and gallring do).
  AckReceipts: just('DRIFT', 'insert'),
  AckRequests: just('DRIFT', 'insert'),
  AckSettings: just('DRIFT', 'insert', 'update'),
  // Checklistor (20270129091000): the templates, the ticks, the lists and their answers are Drift's, as the
  // notices and the leave they sit beside. A template is made and retired (update) and never removed; a proof, a
  // list and an answer are written once, and no administrator changes or removes one: a tick made in error is
  // voided and a list closed by two functions, and gallring removes (the pupil's own, once they have left).
  ConsentAsks: just('DRIFT', 'insert'),
  ConsentEntries: just('DRIFT', 'insert'),
  ConsentLists: just('DRIFT', 'insert'),
  InstructionProofs: just('DRIFT', 'insert'),
  InstructionTemplates: just('DRIFT', 'insert', 'update'),
  AbsenceWatchDigests: readOnly,
  AbsenceWatchFindings: readOnly,
  AbsenceWatchLimits: only('DRIFT'),
  AbsenceWatchSettings: just('DRIFT', 'insert', 'update'),
  // Rapporteringsgrad (20270112090100): the switches and the limit are Drift's, as
  // the attendance they count. The days are written by app.reporting_compute and
  // the weekly ledger by app.reporting_digest: no administrator's write reaches
  // either, and the settings are never deleted. ReportingReminders is not here:
  // it has no administrator's arm at all (only app.reporting_remind reads or
  // writes it), and section 106 lists the tables an arm reaches.
  ReportingDigests: readOnly,
  ReportingSettings: just('DRIFT', 'insert', 'update'),
  TeacherReportingDays: readOnly,
  // Måltidskollen (20270123090000): the cut-off, the letter's switch and the kitchen's address are
  // Drift's, as the attendance and the leave the counts rest on. The settings are never deleted:
  // the letter is turned off. The counts are not stored: app.meal_counts reads them.
  KitchenSettings: just('DRIFT', 'insert', 'update'),
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
  // Schemabrytande aktivitet (20270101090000): an avbokning's, so Drift's.
  ScheduleActivities: only('DRIFT'),
  ScheduleActivityLessons: only('DRIFT'),
  ScheduleActivityTeachers: only('DRIFT'),
  // Provplanering (20270127090000): an exam becomes an activity, so Drift's.
  ExamGroups: only('DRIFT'),
  ExamInvigilators: only('DRIFT'),
  ExamPlanSettings: only('DRIFT'),
  ExamRooms: only('DRIFT'),
  ExamSittings: only('DRIFT'),
  Exams: only('DRIFT'),
  CoverSettings: only('DRIFT'),
  LeaveRequests: only('DRIFT'),
  // Lektionslogg (20261203090000): rektor removes a log that should not
  // stand; the lesson's teachers write it through arms of their own.
  // LessonSubstituteNotes has no administrator's arm at all: no
  // administrator reads or writes a note to the substitute.
  LessonLogs: only('DRIFT'),
  Notifications: just('DRIFT', 'insert'),
  // Vikariefrågan (20270102091000): a request to colleagues, its lessons, its
  // recipients and the vikarie's confirmations. Drift sends and ends them; a
  // line and a confirmation are written once, no arm updates them, and no
  // administrator's arm deletes (gallring and the school's removal do).
  CoverConfirmations: just('DRIFT', 'insert'),
  CoverRequestLessons: just('DRIFT', 'insert'),
  CoverRequestRecipients: just('DRIFT', 'insert', 'update'),
  CoverRequests: just('DRIFT', 'insert', 'update'),
  // Krisläge (20270113091000): an alarm is started and ended by those who write
  // Drift and whom the school let start one (app.crisis_may_start, a narrower
  // question than the area, held in section 351); its lists are written once, in
  // the alarm's own transaction, and a mark is appended. Nothing is changed or
  // deleted by an arm: the lists follow the marks by trigger, and gallring removes
  // an alarm with everything on it.
  CrisisAlarms: just('DRIFT', 'insert', 'update'),
  CrisisCallTeachers: just('DRIFT', 'insert'),
  CrisisCalls: just('DRIFT', 'insert'),
  CrisisPupils: just('DRIFT', 'insert'),
  CrisisReports: just('DRIFT', 'insert'),
  // Elevens lektion för dagen (20270122091000): a pupil moved to a parallel
  // lesson for a day. Read by every administrator and written by none: the
  // doors (app.lesson_pupil_move, app.lesson_pupil_move_undo) ask Drift
  // themselves, and a teacher who teaches either lesson or mentors the pupil
  // may move them too, which no administrator's arm could say.
  LessonPupilMoves: readOnly,
  RoomBookings: only('DRIFT'),
  SubstituteAvailabilities: only('DRIFT'),
  SubstitutePoolMembers: only('DRIFT'),
  // Rastvakt i vardagen (20261210090000): the board's decisions on an
  // absent rastvakt's passes, Drift's as the lessons' are.
  SupervisionCovers: only('DRIFT'),
  TeacherAbsenceCovers: only('DRIFT'),
  TeacherAbsenceReasons: only('DRIFT'),
  TeacherAbsences: only('DRIFT'),
  TimplanCredits: only('DRIFT'),

  // Personal: the roster.
  GuardianStudents: only('PERSONAL'),
  // Skyddad identitet (20270107090000): a mark is set by Personal's writers
  // and removed by those who decide (lifting a protection is a decision),
  // never changed. Its history is written by a trigger.
  // update: the register's kind on the sync's mark, in an administrator's apply (20270111090000).
  PersonProtections: { insert: ['PERSONAL'], update: ['PERSONAL'], delete: ['DECIDES'] },
  PersonProtectionEvents: readOnly,
  // Hela skolans data (20270114090000): ordered, read and withdrawn by those who decide, and by nobody else;
  // the pieces are read by them while the file is fresh and written by the job's functions alone.
  SchoolExports: { insert: ['DECIDES'], update: [], delete: ['DECIDES'], read: ['DECIDES'] },
  SchoolExportChunks: { ...readOnly, read: ['DECIDES'] },
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
  // Krisläge: who may start an alarm and whether the guardians are told is a
  // decision (20270113091000).
  CrisisSettings: just('DECIDES', 'insert', 'update'),
  // Skolans dag (20270116090000): what the school's teachers have of the page is a decision. The
  // administrators' read of it is not a write, and the row goes with the school.
  SchoolDaySettings: just('DECIDES', 'insert', 'update'),
  LeaveDelegationDecisions: just('DECIDES', 'insert'),
  RetentionDecisions: just('DECIDES', 'insert'),
  TeacherEmploymentPeriods: only('DECIDES'),
  TeacherEmployments: only('DECIDES'),
  // Analys och planering (20270130090000): the skoldelar a payroll is booked on
  // and the cost of an hour in a personalkategori are the school's economy,
  // decided like the tjänst % of a post. Every administrator reads both.
  SchoolParts: only('DECIDES'),
  StaffCostRates: only('DECIDES'),

  // Read by every administrator; written by a trigger or a job.
  GallringRuns: readOnly,
  GuardianStudentHistory: readOnly,
  Ss12000SubscriptionDeliveries: readOnly,
  StudentEnrollments: readOnly,
  TeacherEmploymentLogs: readOnly,
  UserRoleChanges: readOnly,
  // Huvudman (20261212090000): who owns or asks for the school, and their
  // history. Written only by the decision's functions (the school's decider,
  // app.current_user_decides() inside app.school_accepts_huvudman and its
  // siblings), never by an arm.
  HuvudmanSchoolEvents: readOnly,
  HuvudmanSchoolRequests: readOnly,
  HuvudmanSchools: readOnly,

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
