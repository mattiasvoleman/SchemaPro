/**
 * Publicering: a MIRROR of what the gateway answers (src/publication, PUB-A).
 *
 * Kept apart from lib/types.ts so that only the pages that publish carry it:
 * /admin/publishing, /admin/cancellations and the timetable's lazily fetched
 * review dialog. Each interface names its gateway source; a field added there
 * is added here by hand, as for the other mirrors.
 */

export type PublishMode = "DIRECT" | "DRAFT";
export type GateMode = "WARN" | "REFUSE";
export type GateSeverity = "INFO" | "WARN" | "REFUSE";

/** src/publication/publication-gates.ts GATE_CODES, in its order. */
export const GATE_CODES = [
  "PUB_CALENDAR_REFUSED",
  "PUB_CLASHES",
  "PUB_OTHER_SCHOOL",
  "PUB_PARKED",
  "PUB_UNPLACED",
  "PUB_UNSTAFFED",
  "PUB_NO_TEACHER",
  "PUB_NO_ROOM",
  "PUB_STAFFING_REFUSE",
  "PUB_TIMPLAN",
  "PUB_BLOCK_SPLIT",
  "PUB_EMPTY_HALF",
  "PUB_DEVIATIONS",
  "PUB_RANGE_OVERLAP",
  "PUB_RANGE_GAP",
  "PUB_WEEK_SPLIT",
  "PUB_DAY_OPS_LOST",
  "PUB_FROM_IN_PAST",
  "PUB_LUNCH_NOT_SET",
  "PUB_NOTHING_TO_PUBLISH",
] as const;
export type GateCode = (typeof GATE_CODES)[number];

/** The policy columns (GATE_POLICY_KEYS), each WARN or REFUSE. */
export const GATE_POLICY_KEYS = [
  "gateClashes",
  "gateParked",
  "gateUnplaced",
  "gateUnstaffed",
  "gateMissingTeacher",
  "gateMissingRoom",
  "gateStaffing",
  "gateTimplan",
  "gateOverlap",
  "gatePast",
  "gateLunch",
  "gateWeekSplit",
  "gateGap",
  "gateDayOpsLost",
  "gateEmptyHalf",
  "gateOtherSchool",
  "gateDeviations",
] as const;
export type GatePolicyKey = (typeof GATE_POLICY_KEYS)[number];
export type GatePolicy = Record<GatePolicyKey, GateMode>;

/** Which gate a policy column settles (GATE_COLUMN, read the other way). */
export const GATE_OF_POLICY: Record<GatePolicyKey, GateCode> = {
  gateClashes: "PUB_CLASHES",
  gateParked: "PUB_PARKED",
  gateUnplaced: "PUB_UNPLACED",
  gateUnstaffed: "PUB_UNSTAFFED",
  gateMissingTeacher: "PUB_NO_TEACHER",
  gateMissingRoom: "PUB_NO_ROOM",
  gateStaffing: "PUB_STAFFING_REFUSE",
  gateTimplan: "PUB_TIMPLAN",
  gateOverlap: "PUB_RANGE_OVERLAP",
  gatePast: "PUB_FROM_IN_PAST",
  gateLunch: "PUB_LUNCH_NOT_SET",
  gateWeekSplit: "PUB_WEEK_SPLIT",
  gateGap: "PUB_RANGE_GAP",
  gateDayOpsLost: "PUB_DAY_OPS_LOST",
  gateEmptyHalf: "PUB_EMPTY_HALF",
  gateOtherSchool: "PUB_OTHER_SCHOOL",
  gateDeviations: "PUB_DEVIATIONS",
};

export type TeacherDisplay = "NONE" | "SIGNATURE" | "NAME";

/**
 * Schemavisarens lägen (src/publication/viewer-modes.ts, 20270118090000).
 *
 * WHO may look: anyone who holds a link or a code (EVERYONE), or only a
 * signed-in teacher or administrator of the school (STAFF).
 * HOW each kind of schedule is shown: OFF (not at all), LIST (a list the
 * visitor picks from) or CODE (Fritext-ID: only to the holder of the exact
 * code, no list). A pupil is never LIST.
 */
export type ViewerAudience = "STAFF" | "EVERYONE";
export type ViewerMode = "OFF" | "LIST" | "CODE";

/** The five kinds of schedule, in the order the page lists them: a class and a teaching group are both StudentGroups. */
export const VIEWER_KINDS = ["CLASS", "GROUP", "TEACHER", "STUDENT", "ROOM"] as const;
export type ViewerKind = (typeof VIEWER_KINDS)[number];

/** The settings column of each kind (VIEWER_MODE_KEYS). */
export const VIEWER_MODE_KEYS = {
  CLASS: "viewerClassMode",
  GROUP: "viewerGroupMode",
  TEACHER: "viewerTeacherMode",
  STUDENT: "viewerStudentMode",
  ROOM: "viewerRoomMode",
} as const satisfies Record<ViewerKind, string>;
export type ViewerModeKey = (typeof VIEWER_MODE_KEYS)[ViewerKind];

/** GET/PUT /publication-settings (PublicationSettingsResponse). */
export interface PublicationSettings extends GatePolicy {
  publishMode: PublishMode;
  /** False when the school has no row: every value is the default. */
  stored: boolean;
  /** Schemavisarens lägen: who may look, and how each kind is shown. A school with no row: STAFF, and every kind OFF. */
  viewerAudience: ViewerAudience;
  viewerClassMode: ViewerMode;
  viewerGroupMode: ViewerMode;
  viewerTeacherMode: ViewerMode;
  viewerStudentMode: ViewerMode;
  viewerRoomMode: ViewerMode;
  publicTeacherDisplay: TeacherDisplay;
  publicShowMeals: boolean;
  publicMinGroupSize: number;
  /** Embedding (20261102090000): per scope, and the websites that may frame the viewer. */
  publicEmbedGroups: boolean;
  publicEmbedTeachers: boolean;
  publicEmbedRooms: boolean;
  publicEmbedOrigins: string[];
  /** Kalenderprenumeration (20261112091000): per audience; turning one off revokes its feeds. */
  calendarFeedTeachers: boolean;
  calendarFeedStudents: boolean;
  calendarFeedGuardians: boolean;
}

export type PublicationSettingsInput = Partial<Omit<PublicationSettings, "publishMode" | "stored">>;

export interface GateEntry {
  /** What the admin reads: "Matematik · 7B, mån 08:00", never a pupil. */
  label: string;
  masterLessonId?: string;
  requirementId?: string;
  teacherId?: string;
  calendarLessonId?: string;
  from?: string;
  to?: string;
}

export interface GateItem {
  code: GateCode;
  severity: GateSeverity;
  count: number;
  /** At most 20; `count` says how many there were. */
  items: GateEntry[];
  params: Record<string, string | number>;
}

export type PublicationKind = "PUBLISH" | "LEGACY_PUBLISH" | "BASELINE" | "REFILL";

export interface PublicationRow {
  id: string;
  kind: PublicationKind;
  outcome: "PUBLISHED" | "REFUSED";
  publishMode: PublishMode;
  validFrom: string;
  validTo: string;
  publishedAt: string;
  publishedByUserId: string | null;
  created: number;
  cancelled: number;
  skipped: number;
  moved: number;
  removed: number;
  adopted: number;
  lessonCount: number | null;
  gates: GateItem[];
  acknowledgedWarnings: boolean;
}

export interface ValiditySegment {
  publicationId: string;
  from: string;
  to: string;
}

/** GET /publications?academicYearId= (PublicationTimeline). */
export interface PublicationTimeline {
  academicYearId: string;
  /** The school's today: "valid now" is judged on it. */
  today: string;
  publications: PublicationRow[];
  /** Which publication is valid when, earliest first. */
  segments: ValiditySegment[];
  validNow: string | null;
}

/** CalendarService's PublishResult. */
export interface PublishResult {
  created: number;
  cancelled: number;
  skipped: number;
  fromDate: string;
  toDate: string;
}

export interface DraftCounts {
  moved: number;
  removed: number;
  adopted: number;
  cancelledByMove: number;
  cancelledByBatch: number;
}

/** POST /publications/preview. */
export interface PublicationPreview {
  academicYearId: string;
  publishMode: PublishMode;
  validFrom: string;
  validTo: string;
  result: PublishResult;
  draft?: DraftCounts;
  gates: GateItem[];
  refused: boolean;
  needsAcknowledgement: boolean;
  /** Sent back as expectedDigest, so the publish is what was previewed. */
  digest: string;
}

/** POST /publications. */
export interface PublicationOutcome {
  publication: PublicationRow;
  result: PublishResult;
  draft?: DraftCounts;
  gates: GateItem[];
}

export interface PublishInput {
  academicYearId: string;
  validFrom: string;
  validTo: string;
  acknowledgeWarnings?: boolean;
  expectedDigest?: string;
}

/** A grundschema lesson as the draft state shows it (DraftLessonView). */
export interface DraftLesson {
  id: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  isParked: boolean;
}

/** GET /publications/state?academicYearId= (DraftState). */
export interface DraftState {
  academicYearId: string;
  publishMode: PublishMode;
  publicationId: string | null;
  added: DraftLesson[];
  changed: Array<{ before: DraftLesson; after: DraftLesson }>;
  removed: DraftLesson[];
  pendingRemovals: number;
}

/** POST /publication-settings/mode. */
export interface ModeSwitchResult {
  publishMode: PublishMode;
  baselines: Array<{ academicYearId: string; publicationId: string; validFrom: string; validTo: string; lessonCount: number }>;
}

/** POST /publications/refill. */
export interface RefillOutcome {
  result: PublishResult;
  gates: GateItem[];
  publicationId: string;
}

// ---------------------------------------------------------------------------
// Bulk avbokning (src/publication/cancellation-batches.service.ts)
// ---------------------------------------------------------------------------

export type BatchScope = "SCHOOL" | "GRADES" | "GROUPS";
export type BatchCause = "EVENT" | "MANUAL";

/** POST /cancellation-batches/preview (CancellationSelectionDto). */
export interface CancellationSelection {
  academicYearId: string;
  name: string;
  cause: BatchCause;
  fromDate: string;
  toDate: string;
  startTime?: string;
  endTime?: string;
  scope: BatchScope;
  minGradeLevel?: number;
  maxGradeLevel?: number;
  groupIds?: string[];
}

export interface CancellationInput extends CancellationSelection {
  expectedDigest?: string;
  credit?: { minutes: number; subjectId?: string };
  /** One digest per person the batch touches, and another when it is taken back. Sent only when ticked. */
  notify?: true;
}

export interface BatchLesson {
  id: string;
  date: string;
  startsAt: string;
  endsAt: string;
  subjectName: string;
  groupName: string;
}

export interface CancellationPreview {
  matched: number;
  /** The first 50, in time order. */
  lessons: BatchLesson[];
  excluded: { started: number; notScheduled: number; attendance: number };
  /** GRADES: groups with no year of their own; their lessons are left. */
  ungradedGroups: string[];
  /** Dates a credit would be written for (whole days ahead of today only). */
  creditDates: string[];
  digest: string;
  /** Who the optional digest would reach; absent from a gateway that predates it. */
  audience?: { pupils: number; guardians: number; teachers: number };
}

export interface CancellationBatch {
  id: string;
  name: string;
  cause: BatchCause;
  fromDate: string;
  toDate: string;
  startTime: string | null;
  endTime: string | null;
  scope: BatchScope;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  groupIds: string[];
  cancelled: number;
  createdAt: string;
  createdByUserId: string | null;
  reversedAt: string | null;
  reinstated: number;
  skippedRoomTaken: number;
  credits: number;
  /** Unreversed and ahead: lessons in its range and scope written since. */
  addedSince: number;
  /** It sent a digest, so its reversal sends one too. */
  notifies?: boolean;
}

export interface ReversePreview {
  reinstate: number;
  /** People the reversal's digest reaches: 0 for a batch that sent none. */
  notify?: number;
  skippedRoomTaken: Array<{ lessonId: string; date: string; roomId: string; by: "LESSON" | "BOOKING" }>;
  /** Rows whose lesson the grundschema has moved since: deleted, the week has it where it runs now. */
  removedTemplateMoved: Array<{ lessonId: string; date: string }>;
  notReinstatable: number;
  creditsDeleted: number;
}

// ---------------------------------------------------------------------------
// Schemavisaren (src/publication/public-links.service.ts)
// ---------------------------------------------------------------------------

/** A link's kind: GROUP is a class or a teaching group (told apart by the target's own kind). */
export type PublicScopeKind = "GROUP" | "TEACHER" | "ROOM" | "STUDENT";

/**
 * Why an unrevoked link still answers the viewer's one 404 to a visitor
 * (the gateway's notShownReasons). The audience is not one of them: a viewer
 * for staff is every link's, and the page says so once.
 */
export type PublicLinkNotShown =
  | "VIEWER_OFF"
  | "SCOPE_OFF"
  | "INDEX_NOT_LISTED"
  | "TEACHER_HIDDEN"
  | "TARGET_HIDDEN"
  | "PROTECTED"
  | "TARGET_GONE"
  | "NO_SIGNATURE"
  | "GROUP_TOO_SMALL"
  | "YEAR_ENDED";

export interface PublicLink {
  id: string;
  academicYearId: string;
  kind: PublicScopeKind;
  /** The class or group, teacher, room or pupil; null = a list of that kind. */
  targetId: string | null;
  label: string | null;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  /** Why an unrevoked link answers the viewer's 404 (the gateway's own rule), or null. */
  notShownBecause: PublicLinkNotShown | null;
  /** Whether the school's websites may frame this link (app.public_timetable_embed's rule); never a pupil's. */
  embeddable: boolean;
}

export interface PublicLinkInput {
  academicYearId: string;
  kind: PublicScopeKind;
  /** Absent: a list of the kind (a pupil's link always names the pupil). */
  targetId?: string;
  /** The page's title (a pupil's: "Barn 1"); a teacher's link takes none. */
  label?: string;
}

/** The kinds of schedule hidden one by one besides a teacher's (PUT /viewer-hidden/:kind/:id). */
export type HiddenKind = "group" | "room" | "student";

/** GET /viewer-hidden: the ids hidden from Schemavisaren, per kind. */
export interface HiddenTargets {
  groups: string[];
  rooms: string[];
  students: string[];
}
