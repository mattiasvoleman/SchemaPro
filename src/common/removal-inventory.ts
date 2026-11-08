import { Prisma, type PrismaClient } from '@prisma/client';

/*
 * WHAT HANGS ON A ROW THAT IS DELETED: every foreign key in the catalogue
 * that points at a group (StudentGroups) or a person (Users), and what a bulk
 * delete's dry run says of it (Massåtgärder, src/common/bulk.ts).
 *
 * Taken from pg_constraint, not from schema.prisma: 26 of the keys to Users
 * and StudentGroups are written in migrations alone and never declared there.
 * Two checks hold this list to the database:
 *  - scripts/test/probe-massatgarder.ts (the Database job) reads pg_constraint
 *    and fails on any key to either table that is missing here, on any key
 *    here that is gone, and on an ON DELETE that differs;
 *  - removal-inventory.spec.ts (the API job) fails on a relation
 *    schema.prisma declares that is missing here, so a key added the Prisma
 *    way fails before the database job runs.
 *
 * EVERY KEY IS TOLD. A key is
 *  - COUNTED into a consequence the dialog names, or into otherRows /
 *    otherLinks, which it gives as a number ("och 3 andra uppgifter");
 *  - ACCOUNT: the person's own notices, settings, devices and calendar feeds,
 *    which no administrator reads (no SELECT arm of theirs, or no grant). The
 *    dialog names them as kinds, never with a number, rather than counting
 *    what it cannot see;
 *  - UNCOUNTED, with why: a key no row of the kind deleted can hold, or one
 *    whose rows are read only with a record of their own;
 *  - REFUSES: ON DELETE RESTRICT, which the single route's check refuses
 *    before the delete (recordedATimplanDecision).
 * So "nothing else depends on them" is said only when it is true.
 *
 * AND A LEVEL DOWN. The rows a delete takes are deleted in turn, and the
 * keys to them are followed too: GROUP_BELOW and STUDENT_BELOW hold every key
 * in the catalogue to a table the delete reaches through CASCADE keys, at
 * any depth (the probe walks the catalogue's cascade). Each is counted into
 * a consequence of its own, goes WITH rows a line of the dialog names (and
 * that line says it as a kind), or keeps its row UNLINKED (SET NULL).
 *
 * COUNTED THE SAME WAY THEY ARE CHECKED. The dry run counts a key's rows with
 * SQL built from the table and the key's first column here, the same names
 * the probe holds to the catalogue, under the caller's RLS. One statement per
 * table: a row a table holds through two keys (an absence report a pupil
 * reported about themselves) is counted once. The names are constants of this
 * file, never input.
 */

export type OnDelete = 'CASCADE' | 'SET NULL' | 'RESTRICT';

/** One foreign key as pg_constraint has it: the referencing table and its columns. */
export interface RowKey {
  table: string;
  /** The key's columns in the catalogue's order; the first names the row. */
  columns: readonly string[];
  onDelete: OnDelete;
}

/** How a dry run tells a key's rows. */
export type Telling<Kind extends string> =
  | { counted: Kind }
  | { account: string }
  | { uncounted: string }
  | { refuses: string };

export interface InventoryKey<Kind extends string> extends RowKey {
  tell: Telling<Kind>;
}

const key = <Kind extends string>(
  table: string,
  columns: readonly string[],
  onDelete: OnDelete,
  tell: Telling<Kind>,
): InventoryKey<Kind> => ({ table, columns, onDelete, tell });

/** The consequences a group delete counts by key (GroupRemovalConsequences adds the rest). */
export type GroupKeyKind =
  | 'halves'
  | 'requirements'
  | 'masterLessons'
  | 'calendarLessons'
  | 'availabilityConstraints'
  | 'sharedLessons'
  | 'memberships'
  | 'lunchSittings'
  | 'calendarBreaks'
  | 'timplanCredits'
  | 'publicLinks'
  | 'homePupils'
  | 'successors'
  | 'mentorDuties'
  | 'consentLists'
  | 'enrolments'
  | 'classTeacher';

/** Every key to StudentGroups. Each is counted, but the class's monthly sums, which no administrator reads row by row. */
export const GROUP_KEYS: readonly InventoryKey<GroupKeyKind>[] = [
  key('StudentGroups', ['halfOfId', 'schoolId'], 'CASCADE', { counted: 'halves' }),
  key('TeachingRequirements', ['studentGroupId', 'schoolId'], 'CASCADE', { counted: 'requirements' }),
  key('MasterLessons', ['studentGroupId', 'schoolId'], 'CASCADE', { counted: 'masterLessons' }),
  key('CalendarLessons', ['studentGroupId', 'schoolId'], 'CASCADE', { counted: 'calendarLessons' }),
  key('AvailabilityConstraints', ['studentGroupId', 'schoolId'], 'CASCADE', { counted: 'availabilityConstraints' }),
  key('MasterLessonGroups', ['studentGroupId', 'schoolId'], 'CASCADE', { counted: 'sharedLessons' }),
  key('CalendarLessonGroups', ['studentGroupId', 'schoolId'], 'CASCADE', { counted: 'sharedLessons' }),
  key('StudentGroupMembers', ['studentGroupId', 'schoolId'], 'CASCADE', { counted: 'memberships' }),
  key('LunchSittings', ['studentGroupId', 'schoolId'], 'CASCADE', { counted: 'lunchSittings' }),
  key('CalendarLunches', ['studentGroupId', 'schoolId'], 'CASCADE', { counted: 'calendarBreaks' }),
  key('CalendarRasts', ['studentGroupId', 'schoolId'], 'CASCADE', { counted: 'calendarBreaks' }),
  key('TimplanCredits', ['studentGroupId', 'schoolId'], 'CASCADE', { counted: 'timplanCredits' }),
  key('PublicTimetableLinks', ['targetGroupId', 'schoolId'], 'CASCADE', { counted: 'publicLinks' }),
  // Counted with the group's links: both are the viewer's rows about the group (a mark that hides it from Schemavisaren, 20270118090000).
  key('PublicTimetableHidden', ['targetGroupId', 'schoolId'], 'CASCADE', { counted: 'publicLinks' }),
  key('Users', ['studentGroupId'], 'SET NULL', { counted: 'homePupils' }),
  // The class's monthly sums (20270121090000): written by the nightly count and read through the statistics' doors only, with no policy
  // for an administrator to count them by, and no pupil in a row. They go with the class.
  key('AbsenceStatsMonths', ['studentGroupId', 'schoolId'], 'CASCADE', {
    uncounted: 'the sums of a class’s months, with no pupil in a row, read only through the statistics’ doors (RLS 390): they go with the class',
  }),
  key('StudentGroups', ['predecessorId', 'schoolId'], 'SET NULL', { counted: 'successors' }),
  key('TeacherDuties', ['studentGroupId', 'schoolId'], 'SET NULL', { counted: 'mentorDuties' }),
  // A consent list belongs to a class (Checklistor, 20270129091000). The list and its answers are kept when the class
  // goes, as the record of who consented to what: the list only loses the class it was made for.
  key('ConsentLists', ['studentGroupId', 'schoolId'], 'SET NULL', { counted: 'consentLists' }),
  key('StudentEnrollments', ['studentGroupId', 'academicYearId', 'schoolId'], 'SET NULL', { counted: 'enrolments' }),
  // Klasslärarens schema (20270128090000): the class's klasslärare, the hours open to them and their drafts go with the class.
  key('ClassTeacherAppointments', ['studentGroupId', 'academicYearId', 'schoolId'], 'CASCADE', { counted: 'classTeacher' }),
  key('ClassTeacherOpenTimes', ['studentGroupId', 'academicYearId', 'schoolId'], 'CASCADE', { counted: 'classTeacher' }),
  key('ClassTeacherChanges', ['studentGroupId', 'academicYearId', 'schoolId'], 'CASCADE', { counted: 'classTeacher' }),
];

/** The consequences a pupil delete counts by key (StudentRemovalConsequences adds the rest). */
export type StudentKeyKind =
  | 'memberships'
  | 'enrolments'
  | 'guardianLinks'
  | 'absenceReports'
  | 'leaveRequests'
  | 'attendanceMarks'
  | 'lessonParticipations'
  | 'teachingTimeStatements'
  | 'otherRows'
  | 'otherLinks';

/**
 * A key a pupil holds no row by in the app's use (a member of staff's post,
 * a booking, a guardian's link): counted in otherRows all the same, so a row
 * left from an earlier role is said rather than taken unsaid.
 */
const others: Telling<StudentKeyKind> = { counted: 'otherRows' };
/** Who did something, kept without the person: counted in otherLinks. */
const kept: Telling<StudentKeyKind> = { counted: 'otherLinks' };
/** The person's own account, which no administrator reads. */
const account = (what: string): Telling<StudentKeyKind> => ({ account: what });

/** Every key to Users, told for a pupil. */
export const STUDENT_KEYS: readonly InventoryKey<StudentKeyKind>[] = [
  key('AttendanceRecords', ['studentId', 'schoolId'], 'CASCADE', { counted: 'attendanceMarks' }),
  // Frånvarobevakning: the limits a pupil has passed, counted from their attendance.
  key('AbsenceWatchFindings', ['studentId', 'schoolId'], 'CASCADE', others),
  key('MasterLessonStudents', ['studentId', 'schoolId'], 'CASCADE', { counted: 'lessonParticipations' }),
  key('CalendarLessonStudents', ['studentId', 'schoolId'], 'CASCADE', { counted: 'lessonParticipations' }),
  // Elevens lektion för dagen (20270122091000): the days a pupil was moved to a parallel lesson go with the pupil
  // (their arrival is a CalendarLessonStudents row above); a member of staff who moved a pupil is kept without them.
  key('LessonPupilMoves', ['studentId', 'schoolId'], 'CASCADE', others),
  key('LessonPupilMoves', ['movedById', 'schoolId'], 'SET NULL', kept),
  key('GuardianStudents', ['studentId', 'schoolId'], 'CASCADE', { counted: 'guardianLinks' }),
  key('GuardianStudents', ['guardianId', 'schoolId'], 'CASCADE', others),
  key('AbsenceReports', ['studentId', 'schoolId'], 'CASCADE', { counted: 'absenceReports' }),
  key('AbsenceReports', ['reportedById', 'schoolId'], 'CASCADE', { counted: 'absenceReports' }),
  key('LeaveRequests', ['studentId', 'schoolId'], 'CASCADE', { counted: 'leaveRequests' }),
  key('LeaveRequests', ['requestedById', 'schoolId'], 'CASCADE', { counted: 'leaveRequests' }),
  key('StudentGroupMembers', ['studentId', 'schoolId'], 'CASCADE', { counted: 'memberships' }),
  key('StudentEnrollments', ['studentId', 'schoolId'], 'CASCADE', { counted: 'enrolments' }),
  key('TimplanStatements', ['studentId', 'schoolId'], 'CASCADE', { counted: 'teachingTimeStatements' }),
  key('UserRoleChanges', ['userId', 'schoolId'], 'CASCADE', { counted: 'otherRows' }),
  key('RoomBookings', ['bookedById', 'schoolId'], 'CASCADE', others),
  key('CalendarLessonTeachers', ['teacherId', 'schoolId'], 'CASCADE', others),
  key('AvailabilityConstraints', ['userId', 'schoolId'], 'CASCADE', others),
  key('TeacherWorkRules', ['userId', 'schoolId'], 'CASCADE', others),
  key('TeacherEmployments', ['userId', 'schoolId'], 'CASCADE', others),
  key('TeacherSubjectQualifications', ['userId', 'schoolId'], 'CASCADE', others),
  key('TeacherDuties', ['userId', 'schoolId'], 'CASCADE', others),
  key('TeacherEmploymentLogs', ['userId', 'schoolId'], 'CASCADE', others),
  key('TeacherPublicLabels', ['userId', 'schoolId'], 'CASCADE', others),
  key('PublicTimetableLinks', ['targetTeacherId', 'schoolId'], 'CASCADE', others),
  // Schemavisaren for a pupil (20270118090000): the code that opens their week, and a mark that hides it.
  key('PublicTimetableLinks', ['targetStudentId', 'schoolId'], 'CASCADE', others),
  key('PublicTimetableHidden', ['targetStudentId', 'schoolId'], 'CASCADE', others),
  key('TeacherAbsences', ['userId', 'schoolId'], 'CASCADE', others),
  key('SubstitutePoolMembers', ['userId', 'schoolId'], 'CASCADE', others),
  key('Ss12000DutyLinks', ['userId', 'schoolId'], 'CASCADE', others),
  key('SupervisionShifts', ['userId', 'schoolId'], 'CASCADE', others),
  key('ScheduleActivityTeachers', ['teacherId', 'schoolId'], 'CASCADE', others),
  // Provplanering (20270127090000): the watch a teacher keeps at an exam goes with the person; the exam stays.
  key('ExamInvigilators', ['teacherId', 'schoolId'], 'CASCADE', others),
  key('SupervisionCovers', ['substituteId', 'schoolId'], 'CASCADE', others),
  // Vikariefrågan (20270102091000): a question they were asked and a pass they confirmed.
  key('CoverRequestRecipients', ['userId', 'schoolId'], 'CASCADE', others),
  // Krisläge (20270113091000): a pupil is on no list once removed; the marks and answers they made are kept without them.
  key('CrisisPupils', ['studentId', 'schoolId'], 'CASCADE', others),
  key('CoverConfirmations', ['userId', 'schoolId'], 'CASCADE', others),
  // Kvittens (20270117091000): the requests a guardian was asked, and the ones asked about a pupil, go with the person.
  key('AckReceipts', ['guardianId', 'schoolId'], 'CASCADE', others),
  key('AckReceipts', ['studentId', 'schoolId'], 'CASCADE', others),
  // Checklistor (20270129091000): a pupil's instruction proofs and answers on consent lists go with the pupil.
  key('InstructionProofs', ['studentId', 'schoolId'], 'CASCADE', others),
  key('ConsentEntries', ['studentId', 'schoolId'], 'CASCADE', others),
  key('SharedTeacherMarks', ['teacherId', 'schoolId'], 'CASCADE', others),
  // Klasslärarens schema (20270128090000): a teacher's appointment goes with them.
  key('ClassTeacherAppointments', ['userId', 'schoolId'], 'CASCADE', others),
  // Skyddad identitet (20270107090000): the mark goes with the person, counted like any other row.
  key('PersonProtections', ['userId', 'schoolId'], 'CASCADE', others),
  // Rapporteringsgrad (20270112090100): a teacher's held and reported lessons per day, counted like any
  // other row a person holds. The ledger of the lessons they were reminded of is read by no role at all
  // (only app.reporting_remind touches it, and the API role holds no grant on it), so a dry run under an
  // administrator's RLS cannot count it.
  key('TeacherReportingDays', ['teacherId', 'schoolId'], 'CASCADE', others),
  key('ReportingReminders', ['teacherId', 'schoolId'], 'CASCADE', {
    uncounted: 'a ledger of the lessons a teacher was reminded of, read by no role (RLS 347): the rows go with the person',
  }),
  key('Notifications', ['userId', 'schoolId'], 'CASCADE', account('notices')),
  key('NotificationOptOuts', ['userId', 'schoolId'], 'CASCADE', account('noticeSettings')),
  key('DevicePushTokens', ['userId', 'schoolId'], 'CASCADE', account('pushDevices')),
  key('LeaveRequestNotices', ['userId', 'schoolId'], 'CASCADE', account('notices')),
  // Ledighetspolicy (20270205091000): the answers of the guardians a school asked to consent to a leave request. No role
  // reads the table (RLS 449), so a dry run under an administrator's RLS cannot count it; the rows go with the person.
  key('LeaveConsents', ['guardianId', 'schoolId'], 'CASCADE', {
    uncounted: 'the answers of the guardians a school asked to consent to a leave request, read by no role (RLS 449): the rows go with the person',
  }),
  key('CalendarFeeds', ['studentId', 'schoolId'], 'CASCADE', account('calendarFeeds')),
  key('CalendarFeeds', ['userId', 'schoolId'], 'CASCADE', account('calendarFeeds')),
  key('TeachingRequirements', ['coTeacherId', 'schoolId'], 'SET NULL', kept),
  key('TeachingRequirements', ['teacherId', 'schoolId'], 'SET NULL', kept),
  key('MasterLessons', ['coTeacherId', 'schoolId'], 'SET NULL', kept),
  key('MasterLessons', ['teacherId', 'schoolId'], 'SET NULL', kept),
  key('AttendanceRecords', ['recordedById', 'schoolId'], 'SET NULL', kept),
  key('LeaveRequests', ['decidedById', 'schoolId'], 'SET NULL', kept),
  key('LeaveRequests', ['referredById', 'schoolId'], 'SET NULL', kept),
  key('RoomBookings', ['decidedById', 'schoolId'], 'SET NULL', kept),
  key('TimplanStatementPublications', ['publishedByUserId', 'schoolId'], 'SET NULL', kept),
  key('TimetablePublications', ['publishedByUserId', 'schoolId'], 'SET NULL', kept),
  key('CancellationBatches', ['createdByUserId', 'schoolId'], 'SET NULL', kept),
  key('CancellationBatches', ['reversedByUserId', 'schoolId'], 'SET NULL', kept),
  key('ScheduleActivities', ['createdByUserId', 'schoolId'], 'SET NULL', kept),
  key('ScheduleActivities', ['removedByUserId', 'schoolId'], 'SET NULL', kept),
  key('Exams', ['createdByUserId', 'schoolId'], 'SET NULL', kept),
  key('PublicTimetableLinks', ['createdByUserId', 'schoolId'], 'SET NULL', kept),
  key('TeacherAbsences', ['createdByUserId', 'schoolId'], 'SET NULL', kept),
  key('TeacherAbsences', ['withdrawnByUserId', 'schoolId'], 'SET NULL', kept),
  key('TeacherAbsenceCovers', ['decidedByUserId', 'schoolId'], 'SET NULL', kept),
  key('TeacherAbsenceCovers', ['substituteId', 'schoolId'], 'SET NULL', kept),
  key('SubstitutePoolMembers', ['createdByUserId', 'schoolId'], 'SET NULL', kept),
  key('RetentionDecisions', ['decidedById', 'schoolId'], 'SET NULL', kept),
  key('LeaveDelegationDecisions', ['decidedById', 'schoolId'], 'SET NULL', kept),
  key('AttendanceSharingDecisions', ['decidedById', 'schoolId'], 'SET NULL', kept),
  key('LessonLogs', ['writtenById', 'schoolId'], 'SET NULL', kept),
  key('TeachingRequirementShares', ['teacherId', 'schoolId'], 'SET NULL', kept),
  key('SupervisionCovers', ['decidedByUserId', 'schoolId'], 'SET NULL', kept),
  key('AckRequests', ['authorId', 'schoolId'], 'SET NULL', kept),
  // Klasslärarens schema (20270128090000): who appointed, who wrote a draft and who published it; the rows stay without them.
  key('ClassTeacherAppointments', ['appointedByUserId', 'schoolId'], 'SET NULL', kept),
  key('ClassTeacherChanges', ['authorId', 'schoolId'], 'SET NULL', kept),
  key('ClassTeacherChanges', ['publishedByUserId', 'schoolId'], 'SET NULL', kept),
  // Checklistor: what a member of staff wrote or gave stays without them (the tick, the answer, the list).
  key('InstructionProofs', ['instructorId', 'schoolId'], 'SET NULL', kept),
  key('InstructionProofs', ['recordedById', 'schoolId'], 'SET NULL', kept),
  key('InstructionProofs', ['voidedById', 'schoolId'], 'SET NULL', kept),
  key('ConsentEntries', ['recordedById', 'schoolId'], 'SET NULL', kept),
  key('ConsentLists', ['createdById', 'schoolId'], 'SET NULL', kept),
  key('CoverRequests', ['requestedByUserId', 'schoolId'], 'SET NULL', kept),
  key('CoverRequests', ['acceptedByUserId', 'schoolId'], 'SET NULL', kept),
  key('CrisisAlarms', ['startedByUserId', 'schoolId'], 'SET NULL', kept),
  key('CrisisAlarms', ['endedByUserId', 'schoolId'], 'SET NULL', kept),
  key('CrisisCallTeachers', ['teacherId', 'schoolId'], 'SET NULL', kept),
  key('CrisisPupils', ['stateByUserId', 'schoolId'], 'SET NULL', kept),
  key('CrisisReports', ['byUserId', 'schoolId'], 'SET NULL', kept),
  key('HuvudmanSchools', ['acceptedById', 'schoolId'], 'SET NULL', kept),
  key('HuvudmanSchoolEvents', ['byUserId', 'schoolId'], 'SET NULL', kept),
  // Hela skolans data (20270114090000): who ordered a copy of the school's data; the order stays without them.
  key('SchoolExports', ['requestedById', 'schoolId'], 'SET NULL', kept),
  key('RoomLoans', ['decidedById', 'ownerSchoolId'], 'SET NULL', kept),
  key('RoomLoans', ['requestedById', 'borrowerSchoolId'], 'SET NULL', kept),
  key('PersonalDataAccess', ['actorId', 'schoolId'], 'SET NULL', {
    uncounted:
      'the läslogg, read with a record of its own (ACCESS_LOG); a row that names the pupil as the reader stays, without them',
  }),
  key('LessonSubstituteNotes', ['writtenById', 'schoolId'], 'SET NULL', {
    uncounted: 'written only by a lesson’s teachers and read by no administrator (RLS 232): no pupil writes one',
  }),
  key('LocalTimplans', ['decidedByUserId', 'schoolId'], 'RESTRICT', {
    refuses: 'recordedATimplanDecision: a decided plan keeps the name of who decided it',
  }),
  key('LocalTimplans', ['gradeSpanSetByUserId', 'schoolId'], 'RESTRICT', {
    refuses: 'recordedATimplanDecision: a decided plan keeps the name of who set its årskurs span',
  }),
];

/** How a key a level down is told. */
export type BelowTelling<Kind extends string> =
  /** Counted into a consequence of its own. */
  | { counted: Kind }
  /** Goes with rows the dialog names by this line, which says it as a kind. */
  | { with: string }
  /** SET NULL: the row stays without the link, and why that is no loss to say. */
  | { unlinked: string };

/** A key to a table a delete reaches through CASCADE keys: `parent` is that table. */
export interface BelowKey<Kind extends string> extends RowKey {
  parent: string;
  tell: BelowTelling<Kind>;
}

const below = <Kind extends string>(
  parent: string,
  table: string,
  columns: readonly string[],
  onDelete: OnDelete,
  tell: BelowTelling<Kind>,
): BelowKey<Kind> => ({ parent, table, columns, onDelete, tell });

/** The kinds a group delete counts a level down (GroupRemovalConsequences). */
export type GroupBelowKind = 'attendanceMarks' | 'lessonLogs' | 'lessonMoves';

/**
 * The line of a group's dialog that names what hangs on its lessons and its
 * plan (bulk.groupConsequences.below in the web's messages), said whenever
 * one of GROUP_BELOW_PARENTS is counted.
 */
export const GROUP_BELOW_LINE = 'below';
const onTheLessons: BelowTelling<GroupBelowKind> = { with: GROUP_BELOW_LINE };

/** Every key a level down from a group: what its lessons, plan rows and rules take with them. */
export const GROUP_BELOW: readonly BelowKey<GroupBelowKind>[] = [
  below('CalendarLessons', 'AttendanceRecords', ['calendarLessonId', 'schoolId'], 'CASCADE', { counted: 'attendanceMarks' }),
  below('CalendarLessons', 'LessonLogs', ['calendarLessonId', 'schoolId'], 'CASCADE', { counted: 'lessonLogs' }),
  below('CalendarLessons', 'CalendarLessonGroups', ['calendarLessonId', 'schoolId'], 'CASCADE', onTheLessons),
  below('CalendarLessons', 'CalendarLessonStudents', ['calendarLessonId', 'schoolId'], 'CASCADE', onTheLessons),
  // Elevens lektion för dagen: a lesson takes the moves off it and onto it.
  // (counted once, by the table: a move reached through both of its lessons is one move)
  below('CalendarLessons', 'LessonPupilMoves', ['fromLessonId', 'schoolId'], 'CASCADE', { counted: 'lessonMoves' }),
  below('CalendarLessons', 'LessonPupilMoves', ['toLessonId', 'schoolId'], 'CASCADE', { counted: 'lessonMoves' }),
  // ... and a move takes its arrival with it, told with the move.
  below('LessonPupilMoves', 'CalendarLessonStudents', ['moveId', 'schoolId'], 'CASCADE', { counted: 'lessonMoves' }),
  below('CalendarLessons', 'CalendarLessonTeachers', ['calendarLessonId', 'schoolId'], 'CASCADE', onTheLessons),
  below('CalendarLessons', 'CancellationBatchLessons', ['calendarLessonId', 'schoolId'], 'CASCADE', onTheLessons),
  below('CalendarLessons', 'ScheduleActivityLessons', ['calendarLessonId', 'schoolId'], 'CASCADE', onTheLessons),
  below('CalendarLessons', 'LessonSubstituteNotes', ['calendarLessonId', 'schoolId'], 'CASCADE', onTheLessons),
  below('CalendarLessons', 'PublicationPendingRemovals', ['calendarLessonId', 'schoolId'], 'CASCADE', onTheLessons),
  below('CalendarLessons', 'TeacherAbsenceCovers', ['calendarLessonId', 'schoolId'], 'CASCADE', onTheLessons),
  below('CalendarLessons', 'CoverRequestLessons', ['calendarLessonId', 'schoolId'], 'CASCADE', onTheLessons),
  below('CalendarLessons', 'CoverConfirmations', ['calendarLessonId', 'schoolId'], 'CASCADE', onTheLessons),
  below('CalendarLessons', 'CrisisCalls', ['calendarLessonId', 'schoolId'], 'SET NULL', {
    unlinked: 'a group on the list of an alarm that was going keeps its names and loses its lesson (Krisläge)',
  }),
  // Klasslärarens schema (20270128090000): a draft that names a lesson of the group keeps its words without it; the draft is counted by its own key to the group.
  below('CalendarLessons', 'ClassTeacherChanges', ['calendarLessonId', 'schoolId'], 'SET NULL', {
    unlinked: 'a klasslärare’s draft for a date keeps its words without the lesson, and goes by its own key to the class (classTeacher)',
  }),
  below('MasterLessons', 'ClassTeacherChanges', ['masterLessonId', 'schoolId'], 'SET NULL', {
    unlinked: 'a klasslärare’s draft for a template lesson keeps its words without the lesson, and goes by its own key to the class (classTeacher)',
  }),
  below('MasterLessons', 'MasterLessonGroups', ['masterLessonId', 'schoolId'], 'CASCADE', onTheLessons),
  below('MasterLessons', 'MasterLessonStudents', ['masterLessonId', 'schoolId'], 'CASCADE', onTheLessons),
  below('MasterLessons', 'CalendarLessons', ['masterLessonId', 'schoolId'], 'SET NULL', {
    unlinked: 'a calendar lesson made from the grundschema is the group’s own, and goes by its own key (calendarLessons)',
  }),
  below('TeachingRequirements', 'TeachingRequirementShares', ['requirementId', 'schoolId'], 'CASCADE', onTheLessons),
  below('TimplanCredits', 'CancellationBatchCredits', ['creditId', 'schoolId'], 'CASCADE', onTheLessons),
  below('AvailabilityConstraints', 'TeacherDutySlots', ['availabilityConstraintId', 'schoolId'], 'CASCADE', onTheLessons),
];

/** The group kinds whose rows have rows below them told by GROUP_BELOW_LINE. */
export const GROUP_BELOW_PARENTS = [
  'calendarLessons',
  'masterLessons',
  'requirements',
  'timplanCredits',
  'availabilityConstraints',
] as const satisfies readonly GroupKeyKind[];

/**
 * Every key a level down from a pupil. What a member of staff's rows take
 * (passes, covers, employment periods) goes with otherRows, of which a pupil
 * holds none; a leave request's notices go with the leave requests, and a
 * device's push receipts with the account's devices (the dialog's accounts
 * line).
 */
export const STUDENT_BELOW: readonly BelowKey<never>[] = [
  below('LeaveRequests', 'LeaveRequestNotices', ['leaveRequestId', 'schoolId'], 'CASCADE', { with: 'leaveRequests' }),
  // The guardians asked to consent to a request go with the request (a request deleted takes the answers; the contact is a column of it).
  below('LeaveRequests', 'LeaveConsents', ['leaveRequestId', 'schoolId'], 'CASCADE', { with: 'leaveRequests' }),
  below('DevicePushTokens', 'PushTickets', ['tokenId', 'schoolId'], 'CASCADE', { with: 'accounts' }),
  below('AvailabilityConstraints', 'TeacherDutySlots', ['availabilityConstraintId', 'schoolId'], 'CASCADE', { with: 'otherRows' }),
  below('TeacherDuties', 'TeacherDutySlots', ['teacherDutyId', 'schoolId'], 'CASCADE', { with: 'otherRows' }),
  below('SubstitutePoolMembers', 'SubstituteAvailabilities', ['userId', 'schoolId'], 'CASCADE', { with: 'otherRows' }),
  below('SupervisionShifts', 'SupervisionCovers', ['shiftId', 'schoolId'], 'CASCADE', { with: 'otherRows' }),
  below('TeacherAbsences', 'SupervisionCovers', ['absenceId', 'absentTeacherId', 'schoolId'], 'CASCADE', { with: 'otherRows' }),
  below('TeacherAbsences', 'TeacherAbsenceCovers', ['absenceId', 'absentTeacherId', 'schoolId'], 'CASCADE', { with: 'otherRows' }),
  below('TeacherAbsences', 'CoverRequestLessons', ['absenceId', 'schoolId'], 'CASCADE', { with: 'otherRows' }),
  below('TeacherAbsences', 'CoverConfirmations', ['absenceId', 'schoolId'], 'CASCADE', { with: 'otherRows' }),
  below('CrisisPupils', 'CrisisReports', ['callId', 'studentId'], 'CASCADE', { with: 'otherRows' }),
  // Elevens lektion för dagen: a pupil's move takes the pupil's arrival with it (the pupil's own arrival row is
  // counted above, by the pupil's key; this is the same row reached through the move).
  below('LessonPupilMoves', 'CalendarLessonStudents', ['moveId', 'schoolId'], 'CASCADE', { with: 'otherRows' }),
  // Provplanering (20270127090000): a booking made by a person who goes is cancelled with them, and the sitting of an exam
  // that booking held stays with its room and its writers, without the booking (its key is SET NULL); counted with the other rows.
  below('RoomBookings', 'ExamSittings', ['bookingId', 'schoolId'], 'SET NULL', { with: 'otherRows' }),
  below('TeacherEmployments', 'TeacherEmploymentPeriods', ['employmentId', 'schoolId', 'userId', 'academicYearId'], 'CASCADE', {
    with: 'otherRows',
  }),
];

/** The account kinds a pupil delete names without a number, in the order the dialog says them. */
export const STUDENT_ACCOUNT_KINDS = ['notices', 'noticeSettings', 'pushDevices', 'calendarFeeds'] as const;

const identifier = (name: string): Prisma.Sql => Prisma.raw(`"${name.replace(/"/g, '""')}"`);

/**
 * Counts, under the transaction's RLS, the rows `keys` hold for `ids`, kind
 * by kind: one statement per table, a row matched by any of the table's keys
 * of that kind counted once. Kinds in `skip` are counted by their caller.
 */
export async function countByKind<Kind extends string>(
  tx: PrismaClient,
  keys: readonly InventoryKey<Kind>[],
  ids: readonly string[],
  skip: readonly Kind[] = [],
): Promise<Record<Kind, number>> {
  const counts = {} as Record<Kind, number>;
  const byKindAndTable = new Map<Kind, Map<string, string[]>>();
  for (const entry of keys) {
    if (!('counted' in entry.tell)) continue;
    const kind = entry.tell.counted;
    counts[kind] = 0;
    if (skip.includes(kind)) continue;
    const tables = byKindAndTable.get(kind) ?? new Map<string, string[]>();
    tables.set(entry.table, [...(tables.get(entry.table) ?? []), entry.columns[0]!]);
    byKindAndTable.set(kind, tables);
  }
  if (ids.length === 0) return counts;
  for (const [kind, tables] of byKindAndTable) {
    for (const [table, columns] of tables) {
      const matches = Prisma.join(
        columns.map((column) => Prisma.sql`${identifier(column)} = ANY(${[...ids]}::uuid[])`),
        ' OR ',
      );
      const [row] = await tx.$queryRaw<{ n: number }[]>(
        Prisma.sql`SELECT count(*)::int AS n FROM ${identifier(table)} WHERE ${matches}`,
      );
      counts[kind] += row?.n ?? 0;
    }
  }
  return counts;
}

/**
 * The kinds whose count grew since the dry run the caller confirmed:
 * `expected` is that dry run's consequences, as the web sends them back. A
 * kind it did not name is not compared (an older client, or a kind added
 * since), and a count that fell is no reason to ask again.
 */
export function grownSince(
  expected: Record<string, unknown> | undefined,
  now: Record<string, number>,
): string[] {
  if (!expected) return [];
  return Object.entries(now)
    .filter(([kind, count]) => typeof expected[kind] === 'number' && count > (expected[kind] as number))
    .map(([kind]) => kind)
    .sort();
}
