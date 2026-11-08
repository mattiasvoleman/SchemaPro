/**
 * Klasslärarens schema (G5), the web's side of the vocabulary, the shapes and
 * the forms (/teacher/klass-schema and /admin/class-teachers).
 *
 * The gateway's src/class-teacher/class-teacher.types.ts says the same
 * reasons, kinds and codes, and class-teacher.contract.test.ts reads it and
 * fails when this file drifts. Free of React and of imports, so that test can
 * read it as it is.
 *
 * WHO DECIDES WHAT MAY BE CHANGED is the database's frame
 * (app.class_teacher_frame): nothing here works out whether a lesson is
 * editable. A lesson is editable when the gateway sent no refusal for it, and
 * a change is judged by the gateway's preview and check, not by this file. What
 * this file does is the form's own arithmetic (a split's minutes, an end after
 * its start), which spares a round trip and says the fault in words.
 */

// ---------------------------------------------------------------------------
// The vocabulary (src/class-teacher/class-teacher.types.ts)
// ---------------------------------------------------------------------------

export const FRAME_REASONS = [
  "NOT_APPOINTED",
  "LESSON_GONE",
  "OTHER_CLASS",
  "HALF_CLASS",
  "PARKED",
  "JOINT_LESSON",
  "OTHER_TEACHER",
  "BLOCK",
  "SHARED_POST",
  "REPLACING_GROUP",
  "SHARED_TEACHER",
  "SHARED_ROOM",
  "TIME_CLOSED",
  "TARGET_CLOSED",
  "NOT_A_REGULAR_LESSON",
  "NOT_SCHEDULED",
  "PAST",
  "YEAR_ENDED",
  "COVERED",
  "HAS_ATTENDANCE",
  "PENDING_TEMPLATE_CHANGE",
  "PENDING_OCCASION_CHANGE",
  "TARGET_MISSING",
  "WEEKEND",
  "ROOM_NOT_FOUND",
  "ROOM_NEEDS_APPROVAL",
  "SPLIT_MINUTES",
] as const;
export type FrameReason = (typeof FRAME_REASONS)[number];

export function isFrameReason(value: unknown): value is FrameReason {
  return typeof value === "string" && (FRAME_REASONS as readonly string[]).includes(value);
}

export const CHANGE_KINDS = ["OCCASION_MOVE", "OCCASION_CANCEL", "OCCASION_ROOM", "TEMPLATE_MOVE", "TEMPLATE_SPLIT"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** The kinds of a dated lesson, and of a lesson of the weekly grundschema ("Mallen"), in the order the panel offers them. */
export const OCCASION_KINDS: readonly ChangeKind[] = ["OCCASION_MOVE", "OCCASION_CANCEL", "OCCASION_ROOM"];
export const TEMPLATE_KINDS: readonly ChangeKind[] = ["TEMPLATE_MOVE", "TEMPLATE_SPLIT"];

export const isOccasionKind = (kind: ChangeKind): boolean => kind.startsWith("OCCASION_");

/** The problem `code`s the routes answer with. */
export const CODES = {
  /** 403: the change is outside the frame. */
  OUTSIDE_FRAME: "CLASS_TEACHER_OUTSIDE_FRAME",
  /** 403: the caller is not klasslärare of the class. */
  NOT_APPOINTED: "CLASS_TEACHER_NOT_APPOINTED",
  /** 409: the lesson changed since the klasslärare read it. */
  STALE: "CLASS_TEACHER_STALE",
  /** 409: a draft already waits for the lesson. */
  DRAFT_EXISTS: "CLASS_TEACHER_DRAFT_EXISTS",
  /** 409: the draft was changed by someone else. */
  REV: "CLASS_TEACHER_REV",
  /** 409: the change meets a clash in the timetable. */
  CONFLICT: "CLASS_TEACHER_CONFLICT",
  /** 409: the administrator the appointment runs as is gone or no longer writes what the work needs. */
  APPOINTER_GONE: "CLASS_TEACHER_APPOINTER_GONE",
  /** 403: the school has not let a klasslärare publish. */
  PUBLISH_OFF: "CLASS_TEACHER_PUBLISH_OFF",
  /** 404: the lesson or the draft is not there. */
  GONE: "CLASS_TEACHER_GONE",
  /** 400: the change asks for nothing, or is not valid. */
  NO_CHANGE: "CLASS_TEACHER_NO_CHANGE",
  INVALID: "CLASS_TEACHER_INVALID",
} as const;

/** 403 on an administrator's write outside their profile (src/auth/roles.guard.ts). */
export const AREA_NOT_YOURS = "AREA_NOT_YOURS";

/** The longest note the gateway takes (ChangeTargetDto.note). */
export const NOTE_MAX = 200;
/** The shortest part of a split lesson, in minutes (the database's rule SPLIT_MINUTES). */
export const PART_MIN = 15;
/** The most spans the gateway takes for one scope (OpenTimesDto.spans). */
export const SPANS_MAX = 40;

// ---------------------------------------------------------------------------
// What the gateway answers
// ---------------------------------------------------------------------------

/** One field of a lesson that is not what it was. */
export interface FieldChange {
  field: string;
  was: unknown;
  now: unknown;
}

export const CONFLICT_KINDS = ["TEACHER", "ROOM", "GROUP", "AVAILABILITY", "BREAK", "BOOKING", "FRAME", "LUNCH", "GRADE_RULE", "EXCEPTION"] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

/** A clash, named by what clashes and with which lesson, never by a person. */
export interface ConflictView {
  kind: ConflictKind;
  other?: { className: string; subjectName: string; day?: number; date?: string; start: string; end: string };
}

/** What publishing a change of the template takes out of the published calendar (src/class-teacher/class-teacher.types.ts RemovalView). */
export interface RemovalView {
  /** Future dated lessons of the template that the change removes. */
  lessons: number;
  /** Of those, the ones a teacher has written a log, a homework or a note to a vikarie on. */
  withLog: number;
}

export type Verdict =
  | { state: "OK"; removes?: RemovalView }
  | { state: "REFUSED"; reason: FrameReason }
  | { state: "STALE"; changed: FieldChange[] }
  | { state: "GONE" }
  | { state: "CONFLICT"; conflicts: ConflictView[] };

/** A draft, as the klasslärare and the schemaläggare read it. Times are HH:MM, dates YYYY-MM-DD. */
export interface ChangeView {
  id: string;
  studentGroupId: string;
  kind: ChangeKind;
  status: "DRAFT" | "PUBLISHED";
  masterLessonId: string | null;
  calendarLessonId: string | null;
  date: string | null;
  targetDate: string | null;
  targetDayOfWeek: number | null;
  targetStart: string | null;
  targetEnd: string | null;
  targetRoomId: string | null;
  keepEnd: string | null;
  note: string | null;
  baseVersion: string;
  rev: number;
  authorId: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export const OUTCOMES = ["PUBLISHED", "REFUSED", "STALE", "CONFLICT", "GONE", "FAILED"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** What publication did with each draft it was asked to publish. */
export interface PublishOutcome {
  id: string;
  outcome: Outcome;
  reason?: FrameReason;
  changed?: FieldChange[];
  conflicts?: ConflictView[];
}

export interface MineView {
  classes: Array<{ id: string; name: string; academicYearId: string }>;
  /** Whether a klasslärare of this school publishes their own class's drafts. */
  selfPublish: boolean;
}

export interface OccasionView {
  id: string;
  date: string;
  start: string;
  end: string;
  status: string;
  subjectId: string;
  subjectName: string;
  className: string;
  roomId: string | null;
  /** The klasslärare teaches it; of a colleague's lesson nothing but "not yours" is said. */
  mine: boolean;
  version: string;
  refusal: FrameReason | null;
  draftId: string | null;
}

export interface TemplateLessonView {
  id: string;
  dayOfWeek: number;
  start: string;
  end: string;
  subjectId: string;
  subjectName: string;
  className: string;
  roomId: string | null;
  recurrence: string;
  mine: boolean;
  version: string;
  refusal: FrameReason | null;
  draftId: string | null;
}

export interface WeekView {
  classId: string;
  className: string;
  academicYearId: string;
  weekStart: string;
  days: string[];
  openTimes: Array<{ dayOfWeek: number; start: string; end: string }>;
  occasions: OccasionView[];
  template: TemplateLessonView[];
  drafts: ChangeView[];
  rooms: Array<{ id: string; name: string; refusal: FrameReason | null }>;
  selfPublish: boolean;
}

export interface PreviewView {
  verdict: Verdict;
}

export interface CheckRow {
  change: ChangeView;
  verdict: Verdict;
}

export interface AppointmentView {
  id: string;
  academicYearId: string;
  studentGroupId: string;
  className: string;
  userId: string;
  teacherName: string;
  appointedByUserId: string | null;
  /** Whether the appointment still runs: the administrator it runs as is active and writes what the work needs. */
  runs: boolean;
}

export interface OpenTimeView {
  id: string;
  academicYearId: string;
  studentGroupId: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export interface DraftRowView {
  change: ChangeView;
  className: string;
  authorName: string | null;
  subjectName: string | null;
  verdict: Verdict;
}

// ---------------------------------------------------------------------------
// What the web sends
// ---------------------------------------------------------------------------

/** What a change is about and where it goes; the fields each kind uses are `targetOf`'s. */
export interface ChangeTarget {
  targetDate?: string;
  targetDayOfWeek?: number;
  targetStart?: string;
  targetEnd?: string;
  /** Null or absent: the lesson keeps its room (OCCASION_ROOM names one). */
  targetRoomId?: string | null;
  keepEnd?: string;
  note?: string;
}

export interface PreviewBody extends ChangeTarget {
  kind: ChangeKind;
  masterLessonId?: string;
  calendarLessonId?: string;
}

export interface CreateChangeBody extends PreviewBody {
  /** The lesson's `version` as the page read it. */
  baseVersion: string;
}

export interface UpdateChangeBody extends ChangeTarget {
  /** The draft's revision the writer read. */
  rev: number;
}

export interface OpenSpan {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export interface OpenTimesBody {
  academicYearId: string;
  /** One class's spans, or null for every class of the läsår. */
  studentGroupId: string | null;
  spans: OpenSpan[];
}

// ---------------------------------------------------------------------------
// Clock and calendar
// ---------------------------------------------------------------------------

/** Monday to Friday: lessons are laid on no other day. */
export const WEEKDAYS = [1, 2, 3, 4, 5] as const;

export const isTime = (value: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

/** "08:30" -> 510. NaN when it is not a time. */
export function minutesOf(time: string): number {
  if (!isTime(time)) return Number.NaN;
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/** 510 -> "08:30". */
export function clockOf(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

const isDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/** A date moved by whole days, on the calendar and not the clock (no daylight-saving day is short). */
export function addDaysIso(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00.000Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

/** 1 = Monday ... 7 = Sunday. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay() || 7;
}

/** The Monday of the week a date is in. */
export const mondayOf = (date: string): string => addDaysIso(date, 1 - weekdayOf(date));

// ---------------------------------------------------------------------------
// The state of a lesson
// ---------------------------------------------------------------------------

/** The frame's say: a lesson without a refusal may be changed by the klasslärare. */
export const isEditable = (lesson: { refusal: FrameReason | null }): boolean => lesson.refusal === null;

export type LessonState = "editable" | "locked" | "draft" | "cancelled";

/**
 * What a lesson is to the klasslärare, in the order that matters: a lesson
 * with a draft says so before it says anything else, a cancelled one is
 * cancelled whatever the frame says of it, and the rest is the frame's.
 */
export function lessonState(lesson: { refusal: FrameReason | null; draftId: string | null; status?: string }): LessonState {
  if (lesson.draftId !== null) return "draft";
  if (lesson.status !== undefined && lesson.status !== "SCHEDULED") return "cancelled";
  return isEditable(lesson) ? "editable" : "locked";
}

// ---------------------------------------------------------------------------
// The week drawn as columns of time
// ---------------------------------------------------------------------------

export interface LaneItem {
  id: string;
  /** Minutes since midnight. */
  start: number;
  end: number;
}

/**
 * Lessons that overlap in time stand side by side: each gets a lane and the
 * number of lanes its cluster of overlaps needs. A class can have two lessons
 * at once (a half-class pair, a block), and a grid that drew them on top of
 * each other would hide one of them.
 */
export function layoutLanes(items: readonly LaneItem[]): Map<string, { lane: number; lanes: number }> {
  const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
  const out = new Map<string, { lane: number; lanes: number }>();
  let cluster: string[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -1;
  const close = () => {
    for (const id of cluster) out.set(id, { lane: out.get(id)!.lane, lanes: laneEnds.length });
    cluster = [];
    laneEnds = [];
  };
  for (const item of sorted) {
    if (cluster.length > 0 && item.start >= clusterEnd) close();
    let lane = laneEnds.findIndex((end) => end <= item.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.end);
    } else {
      laneEnds[lane] = item.end;
    }
    out.set(item.id, { lane, lanes: 0 });
    cluster.push(item.id);
    clusterEnd = cluster.length === 1 ? item.end : Math.max(clusterEnd, item.end);
  }
  close();
  return out;
}

/**
 * The hours a grid spans: from the hour before the earliest start to the hour
 * after the latest end, at least two hours, and the school day when nothing is
 * drawn at all.
 */
export function gridSpan(minutes: readonly number[], fallback: readonly [number, number] = [8 * 60, 16 * 60]): { from: number; to: number } {
  const valid = minutes.filter((value) => Number.isFinite(value));
  if (valid.length === 0) return { from: fallback[0], to: fallback[1] };
  const from = Math.floor(Math.min(...valid) / 60) * 60;
  let to = Math.ceil(Math.max(...valid) / 60) * 60;
  if (to - from < 120) to = from + 120;
  return { from, to };
}

// ---------------------------------------------------------------------------
// The form of a change
// ---------------------------------------------------------------------------

/** Where a lesson stands now: what a move is measured against. */
export interface LessonSpot {
  /** The date of a dated lesson; null in the grundschema. */
  date: string | null;
  dayOfWeek: number;
  start: string;
  end: string;
  roomId: string | null;
}

export const spotOfOccasion = (lesson: Pick<OccasionView, "date" | "start" | "end" | "roomId">): LessonSpot => ({
  date: lesson.date,
  dayOfWeek: weekdayOf(lesson.date),
  start: lesson.start,
  end: lesson.end,
  roomId: lesson.roomId,
});

export const spotOfTemplate = (lesson: Pick<TemplateLessonView, "dayOfWeek" | "start" | "end" | "roomId">): LessonSpot => ({
  date: null,
  dayOfWeek: lesson.dayOfWeek,
  start: lesson.start,
  end: lesson.end,
  roomId: lesson.roomId,
});

/** The fields of the form, as the inputs hold them (strings; "" is empty). */
export interface ChangeForm {
  /** OCCASION_MOVE: the date it moves to. */
  date: string;
  /** TEMPLATE_*: the weekday, "1" to "5", the lesson or the second part of it goes to. */
  dayOfWeek: string;
  start: string;
  end: string;
  /** "" keeps the lesson's room; OCCASION_ROOM needs one. */
  roomId: string;
  /** TEMPLATE_SPLIT: where the first part ends. */
  keepEnd: string;
  note: string;
}

export const emptyForm = (): ChangeForm => ({ date: "", dayOfWeek: "", start: "", end: "", roomId: "", keepEnd: "", note: "" });

/** A lesson of this length can be split in two parts of at least PART_MIN minutes. */
export function canSplit(spot: Pick<LessonSpot, "start" | "end">): boolean {
  return minutesOf(spot.end) - minutesOf(spot.start) >= 2 * PART_MIN;
}

/** The form a kind opens with: the lesson as it stands, so that only what is to change need be touched. */
export function initialForm(kind: ChangeKind, spot: LessonSpot): ChangeForm {
  const form = emptyForm();
  switch (kind) {
    case "OCCASION_MOVE":
      return { ...form, date: spot.date ?? "", start: spot.start, end: spot.end };
    case "OCCASION_CANCEL":
    case "OCCASION_ROOM":
      return form;
    case "TEMPLATE_MOVE":
      return { ...form, dayOfWeek: String(spot.dayOfWeek), start: spot.start, end: spot.end };
    case "TEMPLATE_SPLIT": {
      // Half and half, to the nearest five minutes down; the second part starts where the first ends.
      const from = minutesOf(spot.start);
      const half = Math.floor((minutesOf(spot.end) - from) / 2 / 5) * 5;
      const keepEnd = Number.isFinite(half) ? clockOf(from + half) : "";
      return { ...form, keepEnd, dayOfWeek: String(spot.dayOfWeek), start: keepEnd, end: spot.end };
    }
  }
}

/** The form of a draft being edited: the draft's targets over the lesson as it stands. */
export function formOfChange(change: ChangeView, spot: LessonSpot): ChangeForm {
  const base = initialForm(change.kind, spot);
  const room = change.targetRoomId ?? "";
  const note = change.note ?? "";
  switch (change.kind) {
    case "OCCASION_MOVE":
      return { ...base, date: change.targetDate ?? base.date, start: change.targetStart ?? base.start, end: change.targetEnd ?? base.end, roomId: room, note };
    case "OCCASION_CANCEL":
      return { ...base, note };
    case "OCCASION_ROOM":
      return { ...base, roomId: room, note };
    case "TEMPLATE_MOVE":
      return {
        ...base,
        dayOfWeek: change.targetDayOfWeek === null ? base.dayOfWeek : String(change.targetDayOfWeek),
        start: change.targetStart ?? base.start,
        end: change.targetEnd ?? base.end,
        roomId: room,
        note,
      };
    case "TEMPLATE_SPLIT":
      return {
        ...base,
        keepEnd: change.keepEnd ?? base.keepEnd,
        dayOfWeek: change.targetDayOfWeek === null ? base.dayOfWeek : String(change.targetDayOfWeek),
        start: change.targetStart ?? base.start,
        end: change.targetEnd ?? base.end,
        roomId: room,
        note,
      };
  }
}

export type FormFieldName = "date" | "dayOfWeek" | "start" | "end" | "roomId" | "keepEnd" | "note" | "form";

export const FORM_PROBLEMS = [
  "DATE_MISSING",
  "DATE_WEEKEND",
  "DAY_MISSING",
  "TIME_MISSING",
  "END_NOT_AFTER_START",
  "ROOM_MISSING",
  "KEEP_END_MISSING",
  "KEEP_END_OUTSIDE",
  "PART_TOO_SHORT",
  "SPLIT_MINUTES",
  "NOTE_TOO_LONG",
  "NO_CHANGE",
] as const;
export type FormProblem = (typeof FORM_PROBLEMS)[number];

export interface FormIssue {
  field: FormFieldName;
  code: FormProblem;
}

/** The minutes the two parts of a split hold, against the lesson's own. */
export function splitMinutes(form: ChangeForm, spot: Pick<LessonSpot, "start" | "end">): { first: number; second: number; total: number } {
  return {
    first: minutesOf(form.keepEnd) - minutesOf(spot.start),
    second: minutesOf(form.end) - minutesOf(form.start),
    total: minutesOf(spot.end) - minutesOf(spot.start),
  };
}

/**
 * What the form cannot be sent with, in words the page translates. The same
 * rules the gateway and the database hold (a split's parts are at least 15
 * minutes and add up to the lesson; an end comes after its start; lessons are
 * laid Monday to Friday), said before the round trip. `NO_CHANGE` is not a
 * fault but the state of a form that asks for what the lesson already is.
 */
export function formProblems(kind: ChangeKind, form: ChangeForm, spot: LessonSpot): FormIssue[] {
  const issues: FormIssue[] = [];
  const add = (field: FormFieldName, code: FormProblem) => issues.push({ field, code });
  const times = (): boolean => {
    if (!isTime(form.start) || !isTime(form.end)) {
      add(isTime(form.start) ? "end" : "start", "TIME_MISSING");
      return false;
    }
    if (minutesOf(form.end) <= minutesOf(form.start)) {
      add("end", "END_NOT_AFTER_START");
      return false;
    }
    return true;
  };
  const roomKept = form.roomId === "" || form.roomId === spot.roomId;

  switch (kind) {
    case "OCCASION_MOVE": {
      if (!isDate(form.date)) add("date", "DATE_MISSING");
      else if (weekdayOf(form.date) > 5) add("date", "DATE_WEEKEND");
      const ok = times();
      if (ok && form.date === spot.date && form.start === spot.start && form.end === spot.end && roomKept) add("form", "NO_CHANGE");
      break;
    }
    case "OCCASION_CANCEL":
      break;
    case "OCCASION_ROOM":
      if (form.roomId === "") add("roomId", "ROOM_MISSING");
      else if (form.roomId === spot.roomId) add("form", "NO_CHANGE");
      break;
    case "TEMPLATE_MOVE": {
      if (!(WEEKDAYS as readonly number[]).includes(Number(form.dayOfWeek))) add("dayOfWeek", "DAY_MISSING");
      const ok = times();
      if (ok && Number(form.dayOfWeek) === spot.dayOfWeek && form.start === spot.start && form.end === spot.end && roomKept) add("form", "NO_CHANGE");
      break;
    }
    case "TEMPLATE_SPLIT": {
      if (!(WEEKDAYS as readonly number[]).includes(Number(form.dayOfWeek))) add("dayOfWeek", "DAY_MISSING");
      const ok = times();
      if (!isTime(form.keepEnd)) {
        add("keepEnd", "KEEP_END_MISSING");
      } else if (minutesOf(form.keepEnd) <= minutesOf(spot.start) || minutesOf(form.keepEnd) >= minutesOf(spot.end)) {
        add("keepEnd", "KEEP_END_OUTSIDE");
      } else if (ok) {
        const { first, second, total } = splitMinutes(form, spot);
        if (first < PART_MIN || second < PART_MIN) add("form", "PART_TOO_SHORT");
        else if (first + second !== total) add("form", "SPLIT_MINUTES");
      }
      break;
    }
  }
  if (form.note.length > NOTE_MAX) add("note", "NOTE_TOO_LONG");
  return issues;
}

/** The faults that stop a form being sent; `NO_CHANGE` stops it too, but is not said as a fault. */
export const isFault = (issue: FormIssue): boolean => issue.code !== "NO_CHANGE";

/** The fields a kind uses and none of the others' (the gateway refuses a field a kind does not name). */
function core(kind: ChangeKind, form: ChangeForm, clearRoom: boolean): ChangeTarget {
  const room: ChangeTarget = form.roomId !== "" ? { targetRoomId: form.roomId } : clearRoom ? { targetRoomId: null } : {};
  switch (kind) {
    case "OCCASION_MOVE":
      return { targetDate: form.date, targetStart: form.start, targetEnd: form.end, ...room };
    case "OCCASION_CANCEL":
      return {};
    case "OCCASION_ROOM":
      return { targetRoomId: form.roomId };
    case "TEMPLATE_MOVE":
      return { targetDayOfWeek: Number(form.dayOfWeek), targetStart: form.start, targetEnd: form.end, ...room };
    case "TEMPLATE_SPLIT":
      return { targetDayOfWeek: Number(form.dayOfWeek), targetStart: form.start, targetEnd: form.end, keepEnd: form.keepEnd, ...room };
  }
}

/** A preview carries no note: it is the same change to the check, and a typed word is no reason to ask again. */
export const previewTarget = (kind: ChangeKind, form: ChangeForm): ChangeTarget => core(kind, form, false);

/** A new draft: the note only when there is one. */
export function createTarget(kind: ChangeKind, form: ChangeForm): ChangeTarget {
  const note = form.note.trim();
  return { ...core(kind, form, false), ...(note !== "" ? { note } : {}) };
}

/** A patch: the room is cleared when the form keeps the lesson's, and the note is written as it stands (empty clears it). */
export const updateTarget = (kind: ChangeKind, form: ChangeForm): ChangeTarget => ({
  ...core(kind, form, kind !== "OCCASION_CANCEL" && kind !== "OCCASION_ROOM"),
  note: form.note.trim(),
});

// ---------------------------------------------------------------------------
// What went wrong, as the page tells it
// ---------------------------------------------------------------------------

export type ChangeProblem =
  /** 403: outside the frame. `reason` is known only when the gateway sent it (params.reason); the preview names it either way. */
  | { kind: "frame"; reason: FrameReason | null }
  | { kind: "notAppointed" }
  /** 409: the lesson changed since the page read it. */
  | { kind: "stale" }
  /** 409: somebody else changed the draft. */
  | { kind: "rev" }
  /** 409: a draft already waits for the lesson. */
  | { kind: "exists" }
  | { kind: "conflict" }
  | { kind: "appointerGone" }
  | { kind: "publishOff" }
  | { kind: "areaNotYours"; message: string }
  /** 404. */
  | { kind: "gone" }
  /** 400. */
  | { kind: "invalid" }
  | { kind: "other"; message: string | null };

/**
 * An ApiError as the page tells it. Duck-typed on the error's own fields
 * (status, code, params), so this file imports nothing. The gateway's global
 * filter forwards a problem's `code` and its flat `params`, so a refusal's
 * `reason` is read from `params.reason` when the thrower put it there;
 * otherwise the page learns it from the preview's verdict, which is a 200.
 */
export function problemOf(error: unknown): ChangeProblem {
  if (!(error instanceof Error) || error.name !== "ApiError") return { kind: "other", message: null };
  const { status, code, params } = error as Error & { status: number; code?: string; params?: Record<string, string | number> };
  switch (code) {
    case CODES.OUTSIDE_FRAME:
      return { kind: "frame", reason: isFrameReason(params?.reason) ? params.reason : null };
    case CODES.NOT_APPOINTED:
      return { kind: "notAppointed" };
    case CODES.STALE:
      return { kind: "stale" };
    case CODES.REV:
      return { kind: "rev" };
    case CODES.DRAFT_EXISTS:
      return { kind: "exists" };
    case CODES.CONFLICT:
      return { kind: "conflict" };
    case CODES.APPOINTER_GONE:
      return { kind: "appointerGone" };
    case CODES.PUBLISH_OFF:
      return { kind: "publishOff" };
    case CODES.GONE:
      return { kind: "gone" };
    case CODES.INVALID:
    case CODES.NO_CHANGE:
      return { kind: "invalid" };
    case AREA_NOT_YOURS:
      return { kind: "areaNotYours", message: error.message };
  }
  if (status === 404) return { kind: "gone" };
  return { kind: "other", message: error.message || null };
}

/** The lesson the klasslärare is looking at: a dated one or one of the grundschema. */
export type LessonRef = { layer: "occasion"; id: string } | { layer: "template"; id: string };

/** The draft a lesson has, from the week's own list. */
export function draftOf(week: Pick<WeekView, "drafts">, draftId: string | null): ChangeView | null {
  return draftId === null ? null : (week.drafts.find((draft) => draft.id === draftId) ?? null);
}

/** The lesson a draft is about, when the week on screen holds it. */
export function lessonOfDraft(week: Pick<WeekView, "occasions" | "template">, draft: ChangeView): OccasionView | TemplateLessonView | null {
  if (draft.calendarLessonId !== null) return week.occasions.find((lesson) => lesson.id === draft.calendarLessonId) ?? null;
  if (draft.masterLessonId !== null) return week.template.find((lesson) => lesson.id === draft.masterLessonId) ?? null;
  return null;
}

/** Whether a verdict lets the draft be published. */
export const isPublishable = (verdict: Verdict | undefined): boolean => verdict?.state === "OK";

/** The weekday-and-times of the open spans of one day, merged for reading. */
export function openSpansOf(openTimes: ReadonlyArray<{ dayOfWeek: number; start: string; end: string }>, day: number): Array<{ start: string; end: string }> {
  return openTimes
    .filter((span) => span.dayOfWeek === day)
    .map((span) => ({ start: span.start, end: span.end }))
    .sort((a, b) => a.start.localeCompare(b.start));
}
