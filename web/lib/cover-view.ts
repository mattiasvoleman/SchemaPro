import { ApiError } from "@/lib/api";
import { engineMessage, type MessageLookup } from "@/lib/engine-message";
import type { BoardItem, BulkInput, CoverMessage } from "@/lib/cover-types";

/*
 * What the cover board shows and offers, as pure functions of the board's
 * pairs and the clock — so the rules the gateway enforces are the rules the
 * buttons follow, and a test pins both.
 *
 * ONE LESSON, MANY ABSENT PEOPLE. The gateway answers per (absence, lesson)
 * pair, because a co-taught lesson with both teachers away needs two
 * decisions. The board groups the pairs by lesson and keeps the actions per
 * pair.
 *
 * WHAT A BUTTON MAY DO (the gateway's 409s, review amendment G):
 *   - every decision needs the pair OPEN (or OPEN with a decision the calendar
 *     no longer carries, `decisionStale`) and the lesson not ended;
 *   - a cancel needs the lesson not yet started (COVER_LESSON_STARTED);
 *   - "Medläraren håller" needs another teacher left on the lesson;
 *   - "Ångra" needs a decision and a lesson not ended;
 *   - switching decisions is Ångra, then decide.
 */

/** The badge a pair shows: its status, PASSED for an OPEN pair that ran out, HANDLED by kind. */
export type StatusKey =
  | "OPEN"
  | "COVERED"
  | "CANCELLED"
  | "HANDLED_SUPERVISED_STUDY"
  | "HANDLED_CO_TEACHER"
  | "PASSED";

export function statusKey(item: BoardItem): StatusKey {
  if (item.status === "OPEN") return item.passed ? "PASSED" : "OPEN";
  if (item.status === "HANDLED") return item.decision === "CO_TEACHER" ? "HANDLED_CO_TEACHER" : "HANDLED_SUPERVISED_STUDY";
  return item.status;
}

export interface LessonGroup {
  lessonId: string;
  date: string;
  startsAt: string;
  endsAt: string;
  subjectId: string;
  studentGroupId: string;
  extraGroupIds: string[];
  roomId: string | null;
  teachers: BoardItem["teachers"];
  pairs: BoardItem[];
}

/** The pairs by lesson, in time order (then lesson id); the pairs by absent person's id. */
export function groupByLesson(items: readonly BoardItem[]): LessonGroup[] {
  const groups = new Map<string, LessonGroup>();
  for (const item of items) {
    const group = groups.get(item.lessonId);
    if (group) {
      group.pairs.push(item);
      continue;
    }
    groups.set(item.lessonId, {
      lessonId: item.lessonId,
      date: item.date,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      subjectId: item.subjectId,
      studentGroupId: item.studentGroupId,
      extraGroupIds: item.extraGroupIds,
      roomId: item.roomId,
      teachers: item.teachers,
      pairs: [item],
    });
  }
  const list = [...groups.values()];
  for (const group of list) group.pairs.sort((a, b) => a.absentTeacherId.localeCompare(b.absentTeacherId));
  return list.sort(
    (a, b) => a.startsAt.localeCompare(b.startsAt) || a.lessonId.localeCompare(b.lessonId),
  );
}

/** The lessons by date, for the week view. */
export function groupByDate(groups: readonly LessonGroup[]): { date: string; lessons: LessonGroup[] }[] {
  const byDate = new Map<string, LessonGroup[]>();
  for (const group of groups) {
    const list = byDate.get(group.date) ?? [];
    list.push(group);
    byDate.set(group.date, list);
  }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, lessons]) => ({ date, lessons }));
}

export interface PairActions {
  assign: boolean;
  cancel: boolean;
  supervised: boolean;
  coTeacher: boolean;
  undo: boolean;
  /** "Medläraren håller" goes first when it is possible (review amendment L). */
  coTeacherFirst: boolean;
}

const ended = (item: BoardItem, now: number) => new Date(item.endsAt).getTime() <= now;
const started = (item: BoardItem, now: number) => new Date(item.startsAt).getTime() <= now;

/** Another teacher stays on the lesson: on it, and not one of its absent people. */
export function hasCoTeacher(item: BoardItem, absentOnLesson: ReadonlySet<string>): boolean {
  return item.teachers.some((teacher) => !absentOnLesson.has(teacher.teacherId));
}

export function pairActions(item: BoardItem, now: number, absentOnLesson: ReadonlySet<string>): PairActions {
  const open = item.status === "OPEN" && !ended(item, now);
  const coTeacher = open && hasCoTeacher(item, absentOnLesson);
  return {
    assign: open,
    cancel: open && !started(item, now),
    supervised: open,
    coTeacher,
    undo: item.decision !== null && !ended(item, now),
    coTeacherFirst: coTeacher,
  };
}

/** The absent people of a lesson: the ids a co-teacher must not be. */
export function absentIds(group: LessonGroup): Set<string> {
  return new Set(group.pairs.map((pair) => pair.absentTeacherId));
}

/** Whether a pair can take part in a bulk action, by the same rules as its buttons. */
export function bulkEligible(action: BulkInput["action"], item: BoardItem, now: number): boolean {
  if (action === "UNDO") return item.decision !== null && !ended(item, now);
  if (item.status !== "OPEN" || ended(item, now)) return false;
  return action === "CANCELLED" ? !started(item, now) : true;
}

/** A selection as the bulk call's items, the ineligible left out. */
export function bulkItems(
  action: BulkInput["action"],
  items: readonly BoardItem[],
  selected: ReadonlySet<string>,
  now: number,
): BulkInput["items"] {
  return items
    .filter((item) => selected.has(pairKey(item)) && bulkEligible(action, item, now))
    .map((item) => ({ lessonId: item.lessonId, absenceId: item.absenceId, expected: item.status }));
}

export const pairKey = (item: Pick<BoardItem, "lessonId" | "absenceId">) => `${item.lessonId}:${item.absenceId}`;

/**
 * The hard rules the gateway REFUSES a manual pick on, rather than warning:
 * a lesson of their own then (SUBSTITUTE_HAS_LESSON), away themself
 * (SUBSTITUTE_IS_ABSENT), already on the lesson, not an active teacher.
 */
const REFUSED_PICK = new Set(["BUSY_LESSON", "ABSENT", "ON_LESSON", "INACTIVE"]);

/**
 * "Annan lärare": every active teacher not suggested and not on the lesson,
 * less those the gateway would refuse — the rest are put in with a warning.
 */
export function otherTeacherOptions<T extends { id: string }>(
  teachers: readonly T[],
  item: Pick<BoardItem, "teachers"> | null,
  data: { candidates: { userId: string }[]; excluded: { userId: string; codes: CoverMessage[] }[] } | undefined,
): T[] {
  const left = new Set([
    ...(data?.candidates ?? []).map((candidate) => candidate.userId),
    ...(item?.teachers ?? []).map((teacher) => teacher.teacherId),
    ...(data?.excluded ?? [])
      .filter((entry) => entry.codes.some((code) => REFUSED_PICK.has(code.code)))
      .map((entry) => entry.userId),
  ]);
  return teachers.filter((teacher) => !left.has(teacher.id));
}

/** Monday and Sunday of the ISO week containing `date` (YYYY-MM-DD). */
export function weekOf(date: string): { from: string; to: string } {
  const day = new Date(`${date}T00:00:00.000Z`);
  const offset = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - offset);
  const from = day.toISOString().slice(0, 10);
  day.setUTCDate(day.getUTCDate() + 6);
  return { from, to: day.toISOString().slice(0, 10) };
}

/** Whether a realtime window {from, to} touches the board's window. */
export function windowsOverlap(a: { from: string; to: string }, b: { from: string; to: string }): boolean {
  return a.from <= b.to && b.from <= a.to;
}

/**
 * A ranking or exclusion reason in plain language: coverReasons.<CODE> with
 * its params, or the code itself when the web has no sentence for it yet (the
 * gateway and the web deploy apart — lib/engine-message.ts's fallback).
 */
export function reasonText(t: MessageLookup, reason: CoverMessage): string {
  // A qualification without a grade span (the gateway sends `grades` only
  // when it has one) has a sentence of its own rather than "för åk ".
  const code =
    reason.code.startsWith("QUAL_") && !("grades" in reason.params) && t.has(`${reason.code}_ALL`)
      ? `${reason.code}_ALL`
      : reason.code;
  return engineMessage(t, { code, message: reason.code, params: reason.params });
}

/**
 * A cover refusal in the reader's language: coverErrors.<CODE> with the
 * gateway's params, or the gateway's own Swedish sentence when the code or a
 * param is missing.
 */
export function coverErrorText(t: MessageLookup, error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return engineMessage(t, { code: error.code ?? null, message: error.message, params: error.params ?? null });
  }
  return error instanceof Error ? error.message : fallback;
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code : undefined;
}

export function errorParams(error: unknown): Record<string, string | number> {
  return error instanceof ApiError ? (error.params ?? {}) : {};
}

/**
 * A lookup that reads the cover's own sentences first and the engine
 * catalogue second — the old picker's warnings mix STAFF_* (engine) with
 * COVER_* (gateway), and engineMessages may only hold what the engine sends.
 */
export function chainLookup(first: MessageLookup, second: MessageLookup): MessageLookup {
  const lookup = ((key: string, values?: Record<string, string | number>) =>
    first.has(key) ? first(key, values) : second(key, values)) as MessageLookup;
  lookup.has = (key: string) => first.has(key) || second.has(key);
  return lookup;
}

/** The built-in categories the gateway seeds (teacher-absences.service.ts BUILTINS). */
export const BUILTIN_REASONS = ["SICK", "CHILD_CARE", "WORK_TRAVEL", "PROFESSIONAL_DEVELOPMENT", "OTHER"] as const;

/**
 * A reason's name: a built-in in the reader's language (absenceReasons.<KEY>),
 * a school's own by its label. Admin and the absent teacher only — nothing
 * else ever has a reason to name.
 */
export function reasonName(
  t: (key: string) => string,
  reason: { builtin: string | null; label: string | null } | undefined,
): string {
  if (!reason) return t("NONE");
  if (reason.builtin && (BUILTIN_REASONS as readonly string[]).includes(reason.builtin)) return t(reason.builtin);
  return reason.label ?? reason.builtin ?? t("NONE");
}
