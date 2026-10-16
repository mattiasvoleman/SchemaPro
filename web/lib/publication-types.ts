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
  "PUB_PARKED",
  "PUB_UNPLACED",
  "PUB_UNSTAFFED",
  "PUB_NO_TEACHER",
  "PUB_NO_ROOM",
  "PUB_STAFFING_REFUSE",
  "PUB_TIMPLAN",
  "PUB_BLOCK_SPLIT",
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
};

export type TeacherDisplay = "NONE" | "SIGNATURE" | "NAME";

/** GET/PUT /publication-settings (PublicationSettingsResponse). */
export interface PublicationSettings extends GatePolicy {
  publishMode: PublishMode;
  /** False when the school has no row: every value is the default. */
  stored: boolean;
  publicViewerEnabled: boolean;
  publicGroups: boolean;
  publicTeachers: boolean;
  publicRooms: boolean;
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

export type PublicScopeKind = "GROUP" | "TEACHER" | "ROOM";

export type PublicLinkNotShown =
  | "VIEWER_OFF"
  | "SCOPE_OFF"
  | "TEACHER_HIDDEN"
  | "NO_SIGNATURE"
  | "GROUP_TOO_SMALL"
  | "YEAR_ENDED";

export interface PublicLink {
  id: string;
  academicYearId: string;
  kind: PublicScopeKind;
  /** The class or group, teacher or room; null = an index of them. */
  targetId: string | null;
  label: string | null;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  /** Why an unrevoked link answers the viewer's 404 (the gateway's own rule), or null. */
  notShownBecause: PublicLinkNotShown | null;
  /** Whether the school's websites may frame this link (app.public_timetable_embed's rule). */
  embeddable: boolean;
}

export interface PublicLinkInput {
  academicYearId: string;
  kind: PublicScopeKind;
  targetId?: string;
  label?: string;
}
