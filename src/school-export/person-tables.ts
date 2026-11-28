import { Prisma, type PrismaClient } from '@prisma/client';
import type { AccessKind } from '../access-log/access-log';
import { STUDENT_BELOW, STUDENT_KEYS } from '../common/removal-inventory';
import { idForms, normalize, type TermIndex } from './free-text';

/**
 * Registerutdrag (GDPR art. 15): every table that holds a row about a person,
 * and what the extract does with it. The whole-school export's eight data
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
 *   - COVERED by one of the eight data files, which say it better (ids
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
   * The rows are about somebody else (`column`: a pupil, or a colleague a decision was about) and a member of staff acts in
   * them. When that person is not one of the persons asked for, their id and the columns in `hides` (their state) are empty,
   * and only the act is the extract's: who did it and when. Without it a teacher's extract would carry the pupils the teacher
   * marked found in a drill (M1 of the review), and a rektor's the level, the exception and the note of every teacher the
   * rektor assessed (g409-L-5). The name is the first user's, the pupil; the mechanism is the same for a colleague (aboutColleague).
   * Where `column` is not the person asked for, the id of the person in any other person column of the row is empty too: a teacher who
   * reported their own absence and was taken back by an administrator stands in the administrator's row twice.
   */
  pupil?: { column: string; hides: readonly string[] };
  /** Rows that belong to a person through a parent row: [column, parent table, parent's person column]. */
  through?: ReadonlyArray<readonly [string, string, string]>;
  /**
   * Columns that hold the data of somebody who is not a user and so is not the person asked for (an association's
   * contact person, Lokal): written "(dold)" where the cell has something, as a secret is. The copy must not harm
   * another's rights (GDPR art. 15.4), and the row is the registrar's act, not the hirer's data.
   */
  thirdParty?: readonly string[];
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

/**
 * The rows are a decision or a change a member of staff made about a colleague (`column`: the colleague), and hold the colleague's
 * HR data in `hides`: see PersonDump.pupil, the same mechanism. In the extract of the one who decided, the colleague and what
 * was decided about them are not the extract's (GDPR art. 15.4: the copy must not harm anyone else's rights), only that the
 * person decided, on which row and when. In the colleague's own extract, and in the extract of a person who decided about
 * themself, everything stays.
 */
const aboutColleague = (decision: PersonTableDecision, column: string, hides: readonly string[]): PersonTableDecision =>
  aboutPupil(decision, column, hides);

/**
 * K7b: WHICH TABLES WHERE A MEMBER OF STAFF ACTS AGAINST A COLLEAGUE ARE ABOUT THE COLLEAGUE, and which are the extract's whole. The test
 * is what the row says about the colleague, checked against the schema and against what the page shows and to whom:
 *
 *   - the colleague's HR data (what the page shows only to a reader with HR-läs: tjänst %, nedsättning, löne-id, the rektor's
 *     assessment of the level), and
 *   - health: that a teacher was away, when, and in which category (a built-in category is "Sjukdom"; the migration of the absences calls
 *     it health data, GDPR art. 9, and lets an administrator and the absent teacher read it and nobody else).
 *
 * A table with either is about the colleague: AssignmentScopeAssessments, TeacherEmploymentLogs (R1b), and TeacherAbsences,
 * TeacherAbsenceCovers and SupervisionCovers (K7b). An administrator of any profile reads the absences, since the expedition registers
 * them, so the expedition clerk who registered a year of sick leave must not be handed it back as a document in their own name.
 *
 * A table with neither is the extract's whole, and says so below: UserRoleChanges, SubstitutePoolMembers, ClassTeacherAppointments and
 * PublicTimetableLinks. person-tables.spec.ts pins both lists, and requires every column of the first kind to be the act or the
 * colleague's.
 */

/** The rows hold somebody else's data in these columns: see PersonDump.thirdParty. */
const withThirdParty = (decision: PersonTableDecision, columns: readonly string[]): PersonTableDecision =>
  'dump' in decision ? { dump: { ...decision.dump, thirdParty: columns } } : decision;

const staff = (columns: readonly string[], through?: PersonDump['through']) => dump(columns, 'EMPLOYMENT', through);
const away = (columns: readonly string[], through?: PersonDump['through']) => dump(columns, 'STAFF_ABSENCES', through);

/**
 * Every table of the removal's inventory, decided. Keyed by table name as the
 * catalogue has it.
 */
export const SUBJECT_ACCESS: Readonly<Record<string, PersonTableDecision>> = {
  // The eight data files.
  AttendanceRecords: { covered: 'data/narvaro.csv (the pupil\'s marks; the marks a teacher recorded are the pupils\' data, not the teacher\'s)' },
  GuardianStudents: { covered: 'data/kopplingar.csv' },
  AbsenceReports: { covered: 'data/franvaroanmalningar.csv' },
  LeaveRequests: { covered: 'data/ledigheter.csv' },
  // The answers of the guardians a school asked to consent to a leave request (20270205091000): no role reads the table, so
  // the file asks the database's own function for an administrator who decides (app.leave_consents_export).
  LeaveConsents: { covered: 'data/samtycken.csv (the guardian\'s own answers: whether they consented, and when)' },
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
  // K7b, whole: the role, the administrator profile, HR-läs and whether an administrator teaches are what the people page shows every
  // administrator (UserRoleChanges is `readOnly` in admin-areas.ts), and the row is the record of who gave whom which authority. It holds
  // no HR figure, no health category and no free text. Not the colleague's HR data in the sense of hr-visibility.ts.
  UserRoleChanges: dump(['userId', 'actorId']),
  PersonProtections: dump(['userId']),
  // The person's code in the löneunderlag while marked (20270206091000): theirs, as the mark is.
  PayrollPseudonyms: dump(['userId']),
  // The periods the person has been inactive (20270210090000): theirs, as the dates they left and came back are.
  UserDeactivations: dump(['userId']),
  RoomBookings: dump(['bookedById', 'decidedById']),
  // Lokal (20270204091000): what a member of staff booked of a resource and decided, and the series of
  // external bookings they registered. The series carries the hirer's name, telephone number and address;
  // the hirer is not a user and has no extract of their own, so their details are in the extract of the
  // person who registered them only as the school's own record of who it let to.
  ResourceBookings: dump(['bookedById', 'decidedById']),
  ExternalBookings: withThirdParty(dump(['registeredById']), ['organisation', 'contactName', 'contactPhone', 'contactEmail', 'purpose', 'note']),
  RoomLoans: dump(['decidedById', 'requestedById']),
  HuvudmanSchools: dump(['acceptedById']),
  HuvudmanSchoolEvents: dump(['byUserId']),
  SchoolExports: dump(['requestedById']),

  // Staff: the post, the duties, the lessons and the cover.
  TeacherEmployments: staff(['userId']),
  // Rektorns bedömning av en lärares omfattning (20270306090000): the teacher's own level, exception, day and note are the
  // teacher's (their extract has the row whole, the rektor's id in decidedById included). In the extract of the rektor who
  // decided, the row is the act: that a decision was made, on which row and when. The teacher, the level, the exception, the day
  // and the note are a colleague's HR data (the page shows them only to a reader with HR-läs) and are empty (g409-L-5, K7).
  AssignmentScopeAssessments: aboutColleague(staff(['userId', 'decidedById']), 'userId', ['teachingLevelHours', 'exceptionKind', 'ownInitiativeOn', 'note']),
  TeacherEmploymentPeriods: staff(['userId']),
  // A tjänst's history: the row before and after is the whole post (percentages, reduction, note, löne-id). In the extract of the
  // administrator who wrote the change, the teacher, the post and the version are a colleague's and are empty; the act stays: which
  // kind of row, whether it was made, changed or removed, and when.
  TeacherEmploymentLogs: aboutColleague(staff(['userId', 'actorId']), 'userId', ['entityId', 'version', 'before', 'after']),
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
  // Förlägg delade lektioner (20270208090000): the lessons placed as the teacher's, at the day, time and room the school chose.
  TeachingRequirementPlacements: dump(['teacherId']),
  // Släppt för motorn (20270226090000): who released a post, and when. The mark itself is the school's.
  TeachingRequirementReleases: dump(['releasedById']),
  MasterLessons: dump(['teacherId', 'coTeacherId']),
  Ss12000DutyLinks: dump(['userId']),
  SupervisionShifts: away(['userId']),
  // A pass the board decided on a date because its teacher was away (20261210090000). The occurrence (where, when) is the vikarie's own
  // duty, read from this row (the pass itself is its teacher's), and what was decided and by whom is the act. Which teacher was away,
  // which pass was theirs and which absence it was are the colleague's (K7b): the extract of the one who decided and of the vikarie has
  // the pass and not the teacher.
  SupervisionCovers: aboutColleague(
    away(['substituteId', 'decidedByUserId', 'absentTeacherId'], [['shiftId', 'SupervisionShifts', 'userId']]),
    'absentTeacherId',
    ['shiftId', 'absenceId'],
  ),
  // That a teacher was away is health data (GDPR art. 9; the reason is a category, "Sjukdom" among them), read by an administrator and the
  // absent teacher and nobody else. In the extract of the one who registered or took back a registration (an expedition clerk who registered
  // a year of sick leave) the teacher, the period, whether it was whole days and the category are empty, and who registered it, who took it
  // back and when stay. A teacher who reported or took back their own absence is empty in that column of someone else's row too (K7b).
  TeacherAbsences: aboutColleague(away(['userId', 'createdByUserId', 'withdrawnByUserId']), 'userId', ['startsAt', 'endsAt', 'wholeDays', 'reasonId']),
  // What was decided about one lesson of an absence (20261012100000): the lesson, what was decided (a substitute, cancelled, supervised
  // study, a co-teacher), the substitute and who decided are the act. The teacher who was away, the absence, the teachers the decision took
  // off the lesson (json that names the teacher) and the lesson's note as it was before the decision replaced it (free text, written by
  // whoever wrote the lesson's note, and nothing says it names nobody) are the colleague's (K7b). A substitute reads no row of this table in the app and an administrator and the absent teacher do.
  TeacherAbsenceCovers: aboutColleague(
    dump(['decidedByUserId', 'substituteId', 'absentTeacherId'], 'STAFF_ABSENCES', [], ['removedTeachers']),
    'absentTeacherId',
    ['absenceId', 'removedTeachers', 'previousNote'],
  ),
  // K7b, whole: that the person is in the pool of substitutes the cover board draws from (a timvikarie, or a teacher who also covers) is
  // all the row says, and every administrator reads the pool by name. No availability, no category and no figure: those are
  // SubstituteAvailabilities, which are the person's own.
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
  // Checklistor (20270129091000): what a pupil has been instructed in and has consented to (the pupil's own extract), and what
  // a member of staff gave, wrote or made (theirs). A list is named by its class and its title, which are the school's. Both
  // tables are about a pupil and a member of staff acts in them: in the staff member's extract the pupil, the note and the
  // reason of a voided proof, and the answer (what the guardian decided, who gave it, when, and what was written beside it) are
  // empty, and only the act stays: who ticked or wrote, when, on which template or list (granskning #288, M1).
  InstructionProofs: aboutPupil(dump(['studentId', 'instructorId', 'recordedById', 'voidedById']), 'studentId', ['note', 'voidReason']),
  ConsentEntries: aboutPupil(dump(['studentId', 'recordedById']), 'studentId', ['kind', 'givenOn', 'givenBy', 'note']),
  ConsentLists: dump(['createdById']),
  SharedTeacherMarks: dump(['teacherId']),
  // Klasslärarens schema (20270128090000): whom a class was given to and who gave it, and the drafts a klasslärare wrote
  // or published (their words are the dates and hours they asked for, and a note of at most 200 characters).
  // K7b, whole: which class was given to whom and who gave it: every administrator reads the table and the teacher reads their own row
  // (the two arms of 20270128090000). An assignment of work: no HR figure, no health category and no free text.
  ClassTeacherAppointments: dump(['userId', 'appointedByUserId']),
  ClassTeacherChanges: dump(['authorId', 'publishedByUserId']),
  ScheduleActivityTeachers: dump(['teacherId']),
  // Provplanering (20270127090000): the watch a teacher keeps at an exam (room and exam in the row's keys).
  ExamInvigilators: dump(['teacherId']),
  ExamSittings: {
    excluded:
      'En sal ett prov skrivs i, med antalet skrivande och bokningen som håller salen. Ingen person står på raden; vakterna i salen är ExamInvigilators, som registerutdraget lämnar ut efter lärarens nyckel.',
  },

  // What the person decided, published or wrote.
  // K7b, whole as to a colleague: a link to the school's published timetable of a teacher, a class, a room or a pupil. What a teacher's
  // published timetable shows is the school's own act to publish, and the link's token is "(dold)". A link of kind STUDENT (a pupil's week
  // behind a code) names a pupil, who is not a colleague and is not decided here: it is the extract's whole, as it was before K7b.
  PublicTimetableLinks: dump(['targetTeacherId', 'targetStudentId', 'createdByUserId']),
  PublicTimetableHidden: dump(['targetStudentId']),
  TimplanStatementPublications: dump(['publishedByUserId']),
  TimetablePublications: dump(['publishedByUserId']),
  CancellationBatches: dump(['createdByUserId', 'reversedByUserId']),
  ScheduleActivities: dump(['createdByUserId', 'removedByUserId']),
  Exams: dump(['createdByUserId']),
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
  // A run keeps teacher ids in json too: subjectIds in its conflicts, notes and the params of its summary and its failure, and teacherIds
  // and resourceIds in the analysis that offers changes (the review of #385, L-9). Read as StaffingSearchRuns' checkpoint is.
  OptimizationJobs: dump(['actorId'], 'PEOPLE', [], ['conflicts', 'notes', 'suggestions', 'conflictSummaryParams', 'errorParams']),
  ScheduleCandidateRuns: dump(['createdById']),
  // Lärarval F3 (20270227090000): who asked for a search, and the moves it kept (a lead's teacher id, in json) for a day.
  StaffingSearchRuns: dump(['createdById'], 'PEOPLE', [], ['checkpoint']),
  ScheduleChangeLogs: dump(['actorId']),
  ScheduleVersions: dump(['createdById']),
  Ss12000Sources: dump(['createdById']),
  Ss12000SyncRuns: dump(['appliedById', 'requestedById']),
  IntegrationKeyWebhookSecrets: { excluded: 'Bär bara en krypterad hemlighet och vem som satte den. Ingen administratör kan läsa tabellen och hemligheten lämnas aldrig ut.' },
  Ss12000SourceSecrets: { excluded: 'Bär bara en krypterad hemlighet och vem som satte den. Ingen administratör kan läsa tabellen och hemligheten lämnas aldrig ut.' },
  // Den utgående kön (H3, 20270309090000): id:n på de personer en notis gäller, så länge notisen väntar på att skickas.
  OutboundNotices: {
    excluded:
      'Kön med utgående mejl och push. Raden bär id:n på de personer en notis gäller och mejlets text, och bara medan notisen väntar på att skickas: samma id:n och samma text som personens notiser.csv och mejlet redan har, och ingen adress och ingen token. När notisen är skickad eller har gett upp, högst 20 timmar efter att den lades in, töms raden på allt om en person (en CHECK i databasen håller det), och det som blir kvar är några tal utan person som tas bort efter sju dagar. En person som tas bort innan raden planeras får ingenting skickat (adressen läses ur Users när raden planeras). En rad som redan är planerad bär adressen i sin plan och mejlar personen vid ett omförsök, så länge raden väntar (högst 20 timmar).',
  },
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
  OutboundNotices: ['recipientIds'],
  PersonProtectionEvents: ['actorId', 'userId'],
  PublishedLessons: ['coTeacherId', 'studentIds', 'teacherId'],
  ScheduleCandidateRuns: ['createdById'],
  StaffingSearchRuns: ['createdById'],
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
// claimedBy is the API process that ran a Generera run (host:pid:random, OptimizationJobs): the platform's own name for an
// instance, which is nothing the person asked for and nothing a school should read, so it is written (dold) as a secret is.
const SECRET = /token|secret|password|hash|apikey|claimedby/i;

/** The rows of `file.table` that are the persons' `ids`, as the table has them (column order kept). */
export async function readTable(
  tx: PrismaClient,
  schoolId: string,
  file: TableFile,
  ids: readonly string[],
  /** The school's other users: the ids of them that a json column names are not written (see narrowToPersons). */
  strangers: ReadonlySet<string> = new Set(),
): Promise<Array<Record<string, unknown>>> {
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
  const asked = new Set(ids.map((id) => id.toLowerCase()));
  return rows.map((row) => {
    const parsed = JSON.parse(row.j) as Record<string, unknown>;
    // A column that holds json is read by the persons it names (`inside`), and one run's json names a whole school: a row is in the
    // extract because the person is in it, and the others in it are theirs and not the extract's (GDPR art. 15.4).
    for (const column of file.dump.inside ?? []) {
      if (column in parsed) parsed[column] = narrowToPersons(parsed[column], asked, strangers);
    }
    return parsed;
  });
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A json value of a row that names persons, as the persons asked for may be given it: the entries of a list that name one of them, and
 * in every entry only them. A Generera run keeps the unkept wishes, the limits and the walks of every teacher of the school in one
 * column (subjectIds), the analysis of the run keeps the teachers of its caps (teacherIds): the extract of one teacher named in it must
 * not carry the others' entries, or the others' ids (a colleague's limit on teaching in a row is HR data that the page shows only to
 * a reader with HR-läs). A list of ids loses the school's other users' ids; a list of entries keeps those that name a person asked
 * for; an id of a stranger on its own is written "(annan person)". Anything else is as it was.
 */
export function narrowToPersons(value: unknown, asked: ReadonlySet<string>, strangers: ReadonlySet<string>): unknown {
  const mentionsAsked = (entry: unknown): boolean => {
    const text = JSON.stringify(entry).toLowerCase();
    for (const id of asked) if (text.includes(id)) return true;
    return false;
  };
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return UUID_TEXT.test(node) && strangers.has(node.toLowerCase()) ? '(annan person)' : node;
    if (Array.isArray(node)) {
      if (node.length > 0 && node.every((entry) => typeof entry === 'string')) {
        return node.filter((entry: string) => !(UUID_TEXT.test(entry) && strangers.has(entry.toLowerCase())));
      }
      if (node.some((entry) => entry !== null && typeof entry === 'object')) return node.filter(mentionsAsked).map(walk);
      return node;
    }
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([key, entry]) => [key, walk(entry)]));
    }
    return node;
  };
  return walk(value);
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
 * (PersonDump.pupil). The same for the colleague of a table about a colleague (aboutColleague). Returns how many cells that held
 * something were emptied.
 */
export function emptyPupilPart(file: TableFile, rows: Array<Record<string, unknown>>, asked: ReadonlySet<string>): number {
  const pupil = file.dump.pupil;
  if (!pupil) return 0;
  let emptied = 0;
  for (const row of rows) {
    const about = row[pupil.column];
    if (typeof about !== 'string' || asked.has(about)) continue;
    // The person may stand in another person column of the same row, as the one who registered or took back (a teacher who reported their
    // own absence and was taken back by an administrator): the extract of the administrator must not carry them there either.
    const elsewhere = file.dump.columns.filter((column) => column !== pupil.column && row[column] === about);
    for (const column of [pupil.column, ...pupil.hides, ...elsewhere]) {
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
