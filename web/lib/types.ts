// Domain types mirrored from the Prisma schema (subset used by the web UI).

export type UserRole = "STUDENT" | "TEACHER" | "SCHOOL_ADMIN" | "GUARDIAN";
export type AbsenceReportType = "SICK" | "APPOINTMENT" | "OTHER";
export type LeaveRequestStatus = "PENDING" | "APPROVED" | "REJECTED";
/** A room type the school owns and names itself. */
export interface RoomType {
  id: string;
  name: string;
  /** Present only for the six values that predate school-owned types. */
  legacyKey?: string | null;
  _count?: { rooms: number; subjects: number };
}
export type LessonStatus = "SCHEDULED" | "CANCELLED" | "COMPLETED" | "RESCHEDULED";
export type AttendanceStatus = "UNKNOWN" | "PRESENT" | "ABSENT" | "LATE" | "EXCUSED";
/**
 * GRADE_LEVEL is the one target that is not a row anywhere: there is no
 * "årskurs 5" to point at, so such a rule carries a year range instead of an
 * id. One rule covers a whole stage, and it also reaches a teaching group whose
 * own year is unset but whose members are in that stage — which a rule aimed at
 * a single group never could.
 */
export type ConstraintResource =
  | "TEACHER"
  | "ROOM"
  | "STUDENT_GROUP"
  | "GRADE_LEVEL";
export type ConstraintType = "UNAVAILABLE" | "PREFERRED_FREE" | "PREFERRED_BUSY";

export interface Profile {
  id: string;
  authId: string;
  schoolId: string;
  role: UserRole;
  firstName: string;
  lastName: string;
  email: string;
  studentGroupId: string | null;
}

export interface School {
  id: string;
  name: string;
  slug: string;
  timezone: string;
}

export interface Subject {
  id: string;
  name: string;
  code: string | null;
  color: string | null;
  /** When set, the optimizer only places this subject in rooms of this type. */
  requiredRoomTypeId: string | null;
  /**
   * The Skolverket ämneskod this school subject feeds (NationalSubject.code),
   * or null for a subject outside the national timplan. A group code (NO, SO)
   * is legal: lågstadiet teaches NO as one subject.
   */
  nationalCode: string | null;
  /**
   * False for Mentorstid, Resurs and the like — time that must not join any
   * undervisningstid sum. The column is NOT NULL with default true.
   */
  countsTowardTimplan: boolean;
}

// ---------------------------------------------------------------------------
// The national timplan — reference data, no schoolId, read-only for every role.
// Mirrors NationalTimplansResponse in src/resources/national-timplans.service.ts.
// ---------------------------------------------------------------------------

export type SchoolForm =
  | "GRUNDSKOLA"
  | "ANPASSAD_GRUNDSKOLA_AMNEN"
  | "ANPASSAD_GRUNDSKOLA_AMNESOMRADEN"
  | "SPECIALSKOLA"
  | "SAMESKOLA";

export type TimplanStage = "LAG" | "MELLAN" | "HOG" | "LAG_MELLAN";

export interface NationalSubject {
  code: string;
  /** Swedish, as the statute spells it. */
  name: string;
  /** BI/FY/KE -> NO, GE/HI/RE/SH -> SO; null for a flat subject or a group. */
  parentCode: string | null;
  isGroup: boolean;
}

export interface NationalTimplanEntry {
  subjectCode: string;
  stage: TimplanStage;
  hours: number;
  minimumHoursPerChild: number | null;
  protectedFromReduction: boolean;
}

export interface NationalTimplanVersion {
  id: string;
  code: string;
  sfs: string;
  title: string;
  schoolForm: SchoolForm;
  totalHours: number;
  skolansValHours: number | null;
  reductionCapPercent: number | null;
  appliesFromCohortTerm: string;
  supersededByCode: string | null;
  /** Empty for a lydelse whose fördelning is not published yet (SFS 2025:729). */
  entries: NationalTimplanEntry[];
}

export interface NationalTimplans {
  versions: NationalTimplanVersion[];
  subjects: NationalSubject[];
}

export interface Room {
  id: string;
  name: string;
  code: string | null;
  capacity: number | null;
  roomTypeId: string | null;
  /** Inclusive year range the room may host; null at either end means no limit. */
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  requiresApproval: boolean;
  /**
   * Where the room is, for the room optimisation: which building, and which
   * floor of it. Both optional and school-authored — a school that fills in
   * neither still gets its room changes counted, just not the stairs.
   *
   * The floor is only ever compared for equality, so it does not matter
   * whether a school calls its ground floor 0 or 1 as long as every room
   * agrees. Null means unknown, and an unknown floor never counts as a climb.
   */
  building: string | null;
  floor: number | null;
}

export type RoomBookingStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";

export interface RoomBooking {
  id: string;
  roomId: string;
  bookedById: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: RoomBookingStatus;
  decidedById: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export interface AcademicYear {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isActive: boolean;
  /**
   * The läsår this one was rolled from (2026/27 → 2027/28), or null for a
   * year created by hand. Written once, by the rollover, and held by the
   * database: a year has at most one successor, and the link is never
   * re-pointed (migration 20261007150000).
   */
  predecessorId: string | null;
  /**
   * The årskurs that left school when this year was rolled into: activation
   * calls a pupil whose class has no successor a graduate at or above it and
   * unplaced below it. A label only — nothing is moved on its account.
   */
  graduatingGradeLevel: number | null;
}

/**
 * What kind of non-teaching day a break is. Both mean "no lessons"; the
 * difference is only what the school calls it, and it is worth carrying because
 * "Studiedag" on a pupil's empty week answers a different question than "Lov".
 */
export type BreakKind = "HOLIDAY" | "STAFF_DAY";

/**
 * A named stretch of days the school is not teaching (SchoolBreaks).
 *
 * Both dates are INCLUSIVE — a one-day studiedag has startDate === endDate —
 * and both are the plain YYYY-MM-DD the DATE column holds, from either door:
 * Supabase renders it that way and the API cuts its own instant to match (see
 * src/resources/school-breaks.service.ts, toResponse). So these compare as
 * strings and go straight into an `<input type="date">`, exactly like a
 * requirement's period.
 *
 * The grade span is all-or-nothing: both null is the whole school, which is
 * what a lov almost always is. It is the same shape as an availability
 * constraint's GRADE_LEVEL range for the same reason — a year is a property of
 * a group's members, so there is no row to point at.
 *
 * Structurally this is lib/teaching-hours.ts's `ClosedRange`, which is why a
 * list of these can be handed to annualMinutes without mapping.
 */
export interface SchoolBreak {
  id: string;
  academicYearId: string;
  name: string;
  kind: BreakKind;
  startDate: string;
  endDate: string;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
}

/** A home class (7A) or a teaching group cutting across classes (Ma71). */
export type StudentGroupKind = "CLASS" | "TEACHING_GROUP";

export interface StudentGroup {
  id: string;
  academicYearId: string;
  name: string;
  kind: StudentGroupKind;
  gradeLevel: number | null;
}

export interface Person {
  id: string;
  role: UserRole;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  isActive: boolean;
  /**
   * When the invitation email was last sent, or null for somebody who has
   * been added to the roster but never contacted. They cannot sign in until
   * an admin invites them.
   */
  invitedAt: string | null;
  studentGroupId: string | null;
}

export interface TeachingRequirement {
  id: string;
  academicYearId: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  /** Optional second teacher scheduled together with the lead (co-teaching). */
  coTeacherId: string | null;
  lessonsPerWeek: number;
  minutesPerLesson: number;
  /**
   * Minutes the PUPILS are occupied before the lesson and after it — ombyte
   * before idrotten, dusch and ombyte after it. 0..60, and 0 for every subject
   * that needs none, which is nearly all of them.
   *
   * OUTSIDE the lesson, not part of it: 60 minutes of teaching with 10 before
   * and 20 after occupies the class for 90 and is still 60 minutes of
   * teaching, so `minutesPerLesson` keeps its number and so does every hour
   * figure derived from it (lib/teaching-hours.ts reads neither of these).
   *
   * And only the pupils. The teacher may take the slot on either side and the
   * sal stands empty while the class is in the omklädningsrummet — which is
   * why lib/conflicts.ts widens the group arm alone and leaves TEACHER and
   * ROOM on the teaching span.
   */
  minutesBefore: number;
  minutesAfter: number;
  /**
   * How much of the row each teacher is CHARGED in tjänstefördelningen, 0..200
   * and 100 for nearly every row — Skola24's "Justera längd för lärare (%)".
   *
   * A charge, not a length: 50 on a co-teacher who is in the room for every
   * minute of a lesson says the school counts half of that time against their
   * post, and the lesson, the pupils' hours and the grid are untouched. Neither
   * number reaches the schedule engine (ai-engine-contract.spec.ts).
   */
  teacherLoadPercent: number;
  coTeacherLoadPercent: number;
  /**
   * Which weeks the subject is read over
 — said once on the requirement and
   * inherited by every lesson generated from it, rather than corrected lesson
   * by lesson in the master timetable afterwards.
   */
  recurrence: LessonRecurrence;
  /**
   * YYYY-MM-DD, or null for the academic year's own boundary.
   *
   * Date-only from BOTH doors now. Supabase always rendered the DATE column
   * this way; the POST/PATCH response from NestJS used to send the same field
   * as "2027-01-11T00:00:00.000Z", so the shape of a requirement depended on
   * whether you had just saved it or just reloaded. The instant is cut at its
   * source (src/resources/teaching-requirements.service.ts, toResponse) rather
   * than here — see that comment for why the server and not the client.
   *
   * Consumers may therefore compare these as strings, which lib/teaching-hours.ts
   * and lib/ics.ts both do, and hand them straight to an `<input type="date">`.
   */
  startDate: string | null;
  endDate: string | null;
}

export interface AvailabilityConstraint {
  id: string;
  resourceType: ConstraintResource;
  userId: string | null;
  roomId: string | null;
  studentGroupId: string | null;
  /** Inclusive year range for a GRADE_LEVEL rule; null at an open end. */
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  dayOfWeek: number | null;
  date: string | null;
  startTime: string;
  endTime: string;
  type: ConstraintType;
  reason: string | null;
}

/**
 * A ramtid: the hours one stage of the school may be taught in.
 *
 * Re-exported from lib/frame-times.ts, which owns the shape because it owns the
 * rules that read it — the intersection, the overlap match, the closed day. A
 * second declaration here would be a second thing to keep in step.
 */
export type { FrameTime } from "@/lib/frame-times";

/**
 * A lunchsittning: the window one stage of the school may eat in.
 *
 * Re-exported from lib/lunch-servings.ts, which owns the shape because it owns
 * the rules that read it — the union across spans and the weekday shadow.
 */
export type { LunchServing } from "@/lib/lunch-servings";
export type { Rast } from "@/lib/rasts";

/**
 * A teacher's own working time: the lunch they are owed and the night between
 * two teaching days.
 *
 * Re-exported from lib/teacher-work-rules.ts, which owns the shape because it
 * owns the rules that read it — the all-or-nothing lunch trio, the bounds and
 * what an empty field means. Unlike every other per-teacher row in this file it
 * is something the school OWES the teacher rather than an hour the teacher
 * closes, which is why it is not an AvailabilityConstraint.
 */
export type { TeacherWorkRule } from "@/lib/teacher-work-rules";

/** A published rast as PostgREST returns it. */
export interface CalendarRast {
  id: string;
  studentGroupId: string;
  name: string;
  /** YYYY-MM-DD */
  date: string;
  startsAt: string;
  endsAt: string;
}

/** WISH pays a price; LOCK forbids everywhere else. */
export type { RoomRuleKind } from "@/lib/queries";

/**
 * The lunch the solver gave one group on one weekday.
 *
 * Distinct from a LunchServing, which is the WINDOW a school declared. This is
 * the placement inside it, and the reason both exist is that the school writes
 * one and the solver writes the other.
 */
/** A dated meal, as publish materialised it. */
export interface CalendarLunch {
  id: string;
  studentGroupId: string;
  /** YYYY-MM-DD */
  date: string;
  startsAt: string;
  endsAt: string;
}

export interface LunchSitting {
  id: string;
  studentGroupId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  headcount: number;
  /**
   * Whether the SOLVER wrote this row. False for a meal the school placed by
   * hand in the Grundschema — which the next run keeps, and pins where it is.
   */
  isGenerated: boolean;
}

/**
 * The school's lunch rules and the size of its dining hall — one row, so the
 * hooks read and write it as a single value rather than a collection.
 *
 * These used to live in one administrator's browser under
 * `schemapro.scheduleRules`, which meant a colleague pressing "generera" ran
 * under different rules and nothing anywhere said so.
 */
export interface LunchSettings {
  id: string;
  lunchEnabled: boolean;
  /**
   * HH:MM. The API serialises the `@db.Time` column rather than passing the row
   * through — Prisma reads one as a `Date` at 1970-01-01, and the endpoint used
   * to send "1970-01-01T11:00:00.000Z" under this very field. The comment here
   * said HH:MM:SS, which it never was.
   */
  lunchStartTime: string;
  lunchEndTime: string;
  lunchMinutes: number;
  /** Null means the school has no seat limit worth modelling. */
  diningSeats: number | null;
  maxLessonsPerDayPerGroup: number | null;
}

export type LessonRecurrence = "ALL_WEEKS" | "ODD_WEEKS" | "EVEN_WEEKS";

export interface MasterLesson {
  id: string;
  academicYearId: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  /** Optional second teacher (co-teaching); published as ASSISTANT. */
  coTeacherId: string | null;
  roomId: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  /** Locked lessons survive regeneration and are pinned on the grid. */
  isLocked: boolean;
  /**
   * Set aside on the tray. Occupies nothing — not on the grid, not in a clash
   * check, not published — and keeps its day and time only as a memory of
   * where it was, so it can be put back.
   */
  isParked: boolean;
  /** Which weeks the lesson runs; ISO week parity, not a count from the start. */
  recurrence: LessonRecurrence;
  /** YYYY-MM-DD, or null for the academic year's own boundary. */
  startDate: string | null;
  endDate: string | null;
  /** Additional classes attending (beyond the primary group). */
  extraGroupIds: string[];
  /** Individual participating students (electives across classes). */
  studentIds: string[];
}

export interface CalendarLessonRow {
  id: string;
  subjectId: string;
  studentGroupId: string;
  roomId: string | null;
  date: string;
  startsAt: string;
  endsAt: string;
  status: LessonStatus;
  note: string | null;
}

export interface AttendanceRecordRow {
  id: string;
  calendarLessonId: string;
  studentId: string;
  status: AttendanceStatus;
  recordedAt: string | null;
  note: string | null;
}

export interface GuardianLink {
  id: string;
  guardianId: string;
  studentId: string;
}

export interface AbsenceReport {
  id: string;
  studentId: string;
  reportedById: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  type: AbsenceReportType;
  note: string | null;
  createdAt: string;
}

export interface LeaveRequest {
  id: string;
  studentId: string;
  requestedById: string;
  startDate: string;
  endDate: string;
  reason: string;
  status: LeaveRequestStatus;
  decidedById: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Tjänstefördelning (src/staffing). Three school-owned tables and the enums
// they share; the computed report's shape lives in lib/teacher-load.ts, which
// owns the arithmetic that produces it.
// ---------------------------------------------------------------------------

/** OFF says nothing, WARN flags, REFUSE is a 409 at the write — Fas 2 for the last. */
export type StaffingCheckMode = "OFF" | "WARN" | "REFUSE";
/** MINUTES is the base model; FACTOR enables per-subject weights in Fas 3. */
export type StaffingLoadModel = "MINUTES" | "FACTOR";
/** Ferietjänst (Bilaga M) or semestertjänst (40 h weeks all year). */
export type TeacherContractKind = "FERIE" | "SEMESTER";
/**
 * Legitimerad och behörig, behörig utan legitimation, or får undervisa enligt
 * rektors beslut. Never defaulted: which of the three a teacher holds is a fact
 * about a person, stated by the school.
 */
export type TeacherQualificationKind = "LEGITIMATION" | "BEHORIG" | "TILLATEN";
/**
 * Whether a schema may be generated while a timplanspost has no teacher. Two
 * values, not the check modes' three: a generation starts or it does not.
 */
export type UnstaffedGenerationMode = "ALLOW" | "REFUSE";

/**
 * One row per school, like LunchSettings. The riktmärke is the one field with
 * no default: null means the school has not chosen a weekly teaching measure
 * and every teacher reads NO_TARGET.
 */
export interface StaffingPolicy {
  id: string;
  fullTimeTeachingMinutesPerWeek: number | null;
  fullTimeRegulatedHoursPerYear: number;
  fullTimeAnnualHours: number;
  workDaysPerYear: number;
  /** One decimal; the API sends it as a number. */
  semesterHoursPerWeek: number;
  qualificationMode: StaffingCheckMode;
  overAllocationMode: StaffingCheckMode;
  overAllocationTolerancePercent: number;
  loadModel: StaffingLoadModel;
  unstaffedGeneration: UnstaffedGenerationMode;
}

/** A teacher's post for ONE läsår; percentages carry up to three decimals. */
export interface TeacherEmployment {
  id: string;
  userId: string;
  academicYearId: string;
  employmentPercent: number;
  reductionPercent: number;
  contractKind: TeacherContractKind;
  /** The teacher's own riktmärke, overriding the policy's derivation. Null: derive. */
  teachingTargetMinutesPerWeek: number | null;
  /** Lärarsignatur, 1..8 characters, unique per school and year where set. */
  signature: string | null;
  note: string | null;
}

/** One behörighet per (teacher, subject): an inclusive grade span and a kind. */
export interface TeacherQualification {
  id: string;
  userId: string;
  subjectId: string;
  minGradeLevel: number;
  maxGradeLevel: number;
  kind: TeacherQualificationKind;
  /** yyyy-mm-dd or null — tidsbegränsad legitimation. */
  validFrom: string | null;
  validTo: string | null;
  note: string | null;
}

/** What an övrigt uppdrag is, as the gateway's TeacherDutyKind enum names it. */
export type TeacherDutyKind =
  | "MENTORSKAP"
  | "AMNESANSVAR"
  | "FORSTELARARE"
  | "RASTVAKT"
  | "PEDAGOGISK_LUNCH"
  | "APT_KONFERENS"
  | "VFU_HANDLEDNING"
  | "APL"
  | "ANNAT";

/** The weekly time an uppdrag keeps free in the schema; HH:MM. */
export interface TeacherDutySlot {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

/**
 * An uppdrag for one teacher and one läsår — mentorskap 7B, APT, rastvakt.
 *
 * `blockedSlot` is read back from the linked UNAVAILABLE constraint the
 * gateway writes in the same transaction; the client never names that
 * constraint, and `blockedConstraintId` is only there so a constraint list
 * can say which rows an uppdrag holds.
 */
export interface TeacherDuty {
  id: string;
  userId: string;
  academicYearId: string;
  kind: TeacherDutyKind;
  label: string;
  minutesPerWeek: number;
  /** Counted toward the teaching target (resurstid a school chooses to count). */
  countsAsTeaching: boolean;
  subjectId: string | null;
  studentGroupId: string | null;
  blockedConstraintId: string | null;
  blockedSlot: TeacherDutySlot | null;
  note: string | null;
}

/**
 * One finding a staffing write came back with: a code from the engine
 * catalogue and the values its sentence is written from. WARN mode returns
 * these beside the saved row; REFUSE mode returns the same code and params
 * in a 409 instead.
 */
export interface StaffingWarning {
  code: string;
  params: Record<string, string | number>;
}

/** One person who could take a timplanspost, from GET /staffing/suggest-teachers. */
export interface TeacherCandidate {
  userId: string;
  qualificationKind: TeacherQualificationKind | null;
  teachesSubjectAlready: boolean;
  teachesGroupAlready: boolean;
  currentlyAssigned: boolean;
  /** target − counted after taking the row; null without a target. */
  remainingMinutesPerWeek: number | null;
  /** Taking the row would pass target × (1 + tolerance). */
  wouldExceed: boolean;
  status: "UNDER" | "OK" | "OVER" | "NO_TARGET";
}

export interface TeacherSuggestions {
  requirementId: string;
  subjectId: string;
  studentGroupId: string;
  gradeSpan: { min: number; max: number } | null;
  teacherMinutesPerWeek: number;
  qualificationsRecorded: boolean;
  /** Ranked: qualification, teaches the group, room left. */
  candidates: TeacherCandidate[];
}

// ---------------------------------------------------------------------------
// Läsårsrullning (src/year-rollover)
//
// The answers of POST /academic-years/:id/rollover/preview and
// /activation/preview, as the gateway's planners shape them
// (src/year-rollover/rollover-plan.ts, RolloverPlan without `writes`, and
// activation-plan.ts, ActivationPlan without `writes`). Codes are English
// tokens the web translates (years.problems.*, years.reasons.*); names of
// groups, subjects and years arrive as written; pupils and teachers arrive
// as ids only, and the page names them from usePeople.
// ---------------------------------------------------------------------------

export type RolloverOutcomeCode = "PROMOTE" | "CARRY" | "SKIP" | "GRADUATE" | "INTAKE";

export interface RolloverProblem {
  code: string;
  blocking: boolean;
  params: Record<string, string | number | string[]>;
}

export interface RolloverPlannedGroup {
  sourceGroupId: string;
  sourceName: string;
  kind: StudentGroupKind;
  sourceGradeLevel: number | null;
  outcome: RolloverOutcomeCode;
  targetName: string | null;
  targetGradeLevel: number | null;
  /** INTAKE: the new class opened beside the promotion, same name and grade. */
  intakeName: string | null;
  nameStatus: string | null;
  noGrade: boolean;
  error: string | null;
  collision: boolean;
  caseCollision: boolean;
  homePupils: number;
  membersCopied: number;
  membersExcluded: { graduating: number; noSuccessor: number };
  membersStranded: number;
  requirementsCarried: number;
  volumeFindings: { subjectId: string; subjectName: string; carried: number; planned: number }[];
  volumePlanName: string | null;
}

/**
 * One årskurs of the new year's timplan per årskurs, and why it follows that
 * plan: CARRIED from the grade a class moves up from (a draft stays a draft),
 * DEFAULT (no cohort moves in: the newest decided plan for the lydelse the
 * entering cohort started under), or KEPT (no decided plan covers the grade,
 * so it keeps this year's). Every grade of the new year has a plan.
 */
export interface RolloverPlannedTimplan {
  gradeLevel: number;
  reason: "CARRIED" | "DEFAULT" | "KEPT";
  fromGradeLevel: number | null;
  localTimplanId: string;
  planName: string;
  planStatus: "DRAFT" | "DECIDED";
  /** DEFAULT: a later-decided plan skipped because its lydelse applies only to later cohorts. */
  laterPlan: { name: string; appliesFromCohortTerm: string } | null;
}

export interface RolloverRequirementRow {
  sourceRequirementId: string;
  subjectName: string;
  groupName: string;
}

export interface RolloverPreview {
  source: { id: string; name: string; startDate: string; endDate: string };
  target: {
    name: string;
    startDate: string;
    endDate: string;
    dateShiftDays: number;
    crossesIsoWeek53: boolean;
  };
  graduatingGradeLevel: number | null;
  graduatingGradeSource: "REQUEST" | "TIMPLAN" | "CLASSES" | "NONE";
  graduatingGradeConflict: { timplan: number[]; classes: number | null } | null;
  groups: RolloverPlannedGroup[];
  requirements: {
    carried: number;
    notCarried: number;
    periodShifted: number;
    periodBoundAnchored: number;
    periodDropped: (RolloverRequirementRow & { startDate: string | null; endDate: string | null })[];
    teachersCleared: (RolloverRequirementRow & {
      role: "TEACHER" | "CO_TEACHER";
      teacherId: string;
      reason: "INACTIVE" | "SAME_TEACHER_TWICE" | "NOT_QUALIFIED";
    })[];
    qualificationWarnings: (RolloverRequirementRow & {
      role: "TEACHER" | "CO_TEACHER";
      teacherId: string;
      grades: string;
    })[];
    oddEvenRows: number;
  };
  breaks: {
    sourceBreakId: string;
    name: string;
    startDate: string;
    endDate: string;
    proposedStart: string | null;
    proposedEnd: string | null;
    anchor: "CHRISTMAS" | "EASTER" | "ISO_WEEK" | "NONE";
    fits: boolean;
    selected: boolean;
    startDateToWrite: string | null;
    endDateToWrite: string | null;
  }[];
  classRules: {
    sourceConstraintId: string;
    sourceGroupName: string;
    targetGroupName: string;
    dayOfWeek: number;
    startTime: string;
    endTime: string;
    stageChange: boolean;
  }[];
  timplans: RolloverPlannedTimplan[];
  skipped: { model: string; reason: string; count: number | null }[];
  problems: RolloverProblem[];
  blocking: boolean;
  planHash: string;
}

/** The request of both rollover calls; execute adds G (required) and planHash. */
export interface RolloverOptions {
  name: string;
  startDate: string;
  endDate: string;
  graduatingGradeLevel?: number;
  groups?: { sourceGroupId: string; outcome?: "PROMOTE" | "CARRY" | "SKIP" | "INTAKE"; name?: string }[];
  carryTeachingGroups?: boolean;
  carryTeachingGroupMembers?: boolean;
  keepTeachers?: boolean;
  carryClassRules?: boolean;
  breaks?: { sourceBreakId: string; startDate?: string; endDate?: string }[];
}

export interface RolloverResult {
  academicYear: AcademicYear;
  counts: {
    groups: number;
    members: number;
    requirements: number;
    breaks: number;
    classRules: number;
    timplans: number;
  };
  planHash: string;
}

export interface ActivationProblem {
  code: "YEAR_ACTIVATION_TOO_EARLY" | "YEAR_IS_SUPERSEDED" | "MEMBERSHIPS_OUT_OF_DATE";
  /** MEMBERSHIPS_OUT_OF_DATE is a notice; the other two refuse the activation. */
  blocking: boolean;
  params: Record<string, string | number>;
}

export interface ActivationPreview {
  year: { id: string; name: string; isActive: boolean };
  currentlyActive: { id: string; name: string } | null;
  chain: { id: string; name: string; endDate: string }[];
  /** With the pupils' ids (no names), so an active year's stragglers can be named. */
  moves: {
    fromGroupId: string;
    fromGroupName: string;
    toGroupId: string;
    toGroupName: string;
    count: number;
    studentIds: string[];
  }[];
  graduates: { count: number; studentIds: string[] };
  unplaced: {
    count: number;
    studentIds: string[];
    pupils: { studentId: string; fromGroupId: string; reason: "NO_SUCCESSOR" | "SUCCESSOR_NOT_A_CLASS" }[];
  };
  alreadyInYear: number;
  inLaterYear: number;
  otherOrNone: number;
  inactiveUntouched: number;
  problems: ActivationProblem[];
  blocking: boolean;
  planHash: string;
}

/**
 * GET /academic-years/:id/rosters — the förberäknade klasslistor the gateway's
 * roster readers use for the year (src/year-rollover/projected-rosters.ts).
 *
 * PROJECTED for a rolled year whose predecessor is the active year and whose
 * activation would move somebody: `homeClasses` holds exactly the pupils that
 * activation moves, each with the class it would give them — null for one who
 * graduates or is left without a class — sorted by id. Everyone else keeps the
 * studentGroupId they have. CURRENT for every other readable year, with an
 * empty list: its rows already are its rosters.
 */
export interface YearRosters {
  academicYearId: string;
  basis: "CURRENT" | "PROJECTED";
  homeClasses: { studentId: string; studentGroupId: string | null }[];
  counts: { moved: number; graduates: number; unplaced: number };
  /** planActivation's MEMBERSHIPS_OUT_OF_DATE for the same plan; zeros when none. */
  membershipsOutOfDate: { missing: number; stale: number };
}

export interface ActivationResult {
  year: { id: string; name: string; isActive: true };
  moved: number;
  graduated: number;
  unplaced: number;
}
