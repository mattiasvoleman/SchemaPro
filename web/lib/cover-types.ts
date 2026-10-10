/*
 * The cover board's wire shapes (src/cover), as the gateway answers them.
 *
 * Mirrored by hand, like lib/publication-types.ts: the gateway's types live in
 * a Nest build the web does not import. Each name says which gateway type it
 * copies, so a change there has one place to look here.
 *
 * NONE OF THESE CARRIES A REASON except `Absence.reasonId`, which the gateway
 * reads under RLS for the admin and the absent teacher only. The board, the
 * candidates, the proposal, the counter and the hours never name one.
 */

export type CoverStatus = "OPEN" | "COVERED" | "CANCELLED" | "HANDLED";
export type CoverDecisionKind = "SUBSTITUTE" | "CANCELLED" | "SUPERVISED_STUDY" | "CO_TEACHER";
export type CoverPersonKind = "STAFF" | "POOL";
export type PoolPreference = "PREFER" | "NEUTRAL" | "LAST_RESORT";
export type AbsencePhase = "PLANNED" | "ONGOING" | "ENDED" | "WITHDRAWN";
export type TeacherRole = "LEAD" | "ASSISTANT" | "SUBSTITUTE";

export interface AbsenceCounts {
  open: number;
  covered: number;
  cancelled: number;
  handled: number;
  passedOpen: number;
}

/** teacher-absences.service.ts AbsenceView. */
export interface Absence {
  id: string;
  userId: string;
  startsAt: string;
  endsAt: string;
  wholeDays: boolean;
  /** Admin and the absent teacher only (RLS); null = "ej angiven". */
  reasonId: string | null;
  status: "ACTIVE" | "WITHDRAWN";
  phase: AbsencePhase;
  selfReported: boolean;
  createdAt: string;
  counts: AbsenceCounts;
}

/** CreateAbsenceDto. Times absent = whole days. */
export interface AbsenceInput {
  userId: string;
  from: string;
  to: string;
  startTime?: string;
  endTime?: string;
  reasonId?: string | null;
}

/** UpdateAbsenceDto: no userId — an absence never changes person. */
export interface AbsencePatch {
  from?: string;
  to?: string;
  startTime?: string | null;
  endTime?: string | null;
  reasonId?: string | null;
  undoDecisionsOutside?: boolean;
}

/** cover-settings.service.ts ReasonView. */
export interface AbsenceReason {
  id: string;
  /** SICK, CHILD_CARE, WORK_TRAVEL, PROFESSIONAL_DEVELOPMENT, OTHER — or null for the school's own. */
  builtin: string | null;
  label: string | null;
  sortOrder: number;
  archived: boolean;
}

/** CoverSettingsView. */
export interface CoverSettings {
  poolPreference: PoolPreference;
  teacherSelfReport: boolean;
}

/** cover-board.ts BoardItem: one (absence, lesson) pair. */
export interface BoardItem {
  absenceId: string;
  absentTeacherId: string;
  absentRole: TeacherRole | null;
  lessonId: string;
  date: string;
  startsAt: string;
  endsAt: string;
  subjectId: string;
  studentGroupId: string;
  extraGroupIds: string[];
  roomId: string | null;
  lessonStatus: "SCHEDULED" | "CANCELLED" | "COMPLETED" | "RESCHEDULED";
  cancelCause: string | null;
  teachers: { teacherId: string; role: TeacherRole }[];
  substituteId: string | null;
  decision: CoverDecisionKind | null;
  decidedAt: string | null;
  status: CoverStatus;
  decisionStale: boolean;
  passed: boolean;
  outsideAbsence: boolean;
}

/** cover.service.ts BoardResponse. */
export interface Board {
  from: string;
  to: string;
  items: BoardItem[];
  summary: AbsenceCounts;
  absences: { id: string; userId: string; startsAt: string; endsAt: string }[];
}

export interface CoverMessage {
  code: string;
  params: Record<string, string | number>;
}

/** cover-rank.ts RankReason. */
export interface RankReason extends CoverMessage {
  points: number;
}

/** cover-suggestions.service.ts Candidate. */
export interface Candidate {
  userId: string;
  kind: CoverPersonKind;
  score: number;
  qualificationKind: "LEGITIMATION" | "BEHORIG" | "TILLATEN" | null;
  reasons: RankReason[];
  counter: { weekLessons: number; termLessons: number };
  load: { weekMinutes: number; targetMinutes: number | null };
}

export interface Candidates {
  lessonId: string;
  candidates: Candidate[];
  excluded: { userId: string; codes: CoverMessage[] }[];
}

/** day-proposal.ts DayProposal plus the controller's date and basis. */
export interface DayProposal {
  date: string;
  basis: string;
  items: { lessonId: string; absenceId: string; userId: string; score: number; reasons: RankReason[] }[];
  unassigned: { lessonId: string; absenceId: string; why: "NO_FEASIBLE_CANDIDATE" | "CONSUMED" }[];
}

export interface DecisionInput {
  lessonId: string;
  absenceId: string;
  kind: CoverDecisionKind;
  substituteId?: string;
  expected: CoverStatus;
}

export interface BulkInput {
  action: "CANCELLED" | "SUPERVISED_STUDY" | "UNDO";
  items: { lessonId: string; absenceId: string; expected: CoverStatus }[];
}

/** cover-reports.service.ts CounterView. */
export interface CounterRow {
  userId: string;
  kind: CoverPersonKind;
  weekLessons: number;
  weekMinutes: number;
  termLessons: number;
  termMinutes: number;
  heldTermMinutes: number;
}

/** HoursRow: a held cover, Fas 3's DELIVERED SUBSTITUTE row. */
export interface HoursRow {
  lessonId: string;
  userId: string;
  kind: CoverPersonKind;
  date: string;
  startsAt: string;
  endsAt: string;
  minutes: number;
  subjectId: string;
  studentGroupId: string;
  roomId: string | null;
}

export interface Hours {
  from: string;
  to: string;
  rows: HoursRow[];
  summary: { userId: string; kind: CoverPersonKind; lessons: number; minutes: number }[];
  planned: { userId: string; lessons: number; minutes: number }[];
  /** Held covers credited to a substitute who was away themself: left out of `rows`, to check. */
  toCheck: HoursRow[];
}

/** AvailabilityView: a window a pool member can work, dated or weekly. */
export interface PoolWindow {
  id: string;
  userId: string;
  date: string | null;
  dayOfWeek: number | null;
  startTime: string;
  endTime: string;
}

export interface PoolWindowInput {
  userId?: string;
  date?: string;
  dayOfWeek?: number;
  startTime: string;
  endTime: string;
}
