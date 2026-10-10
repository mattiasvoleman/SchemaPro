/**
 * THE HARD RULES OF COVER, IN ONE PURE MODULE.
 *
 * Who may be put in front of a class that has lost its teacher, decided from
 * a person's day as cover-context.ts reads it — never from the database
 * directly, so the candidates list, the day proposal ("Fördela dagen") and
 * the old picker ask exactly the same question, and so does the warning a
 * manual pick gets back.
 *
 * A candidate is excluded (a suggestion never breaks one of these):
 *
 *   INACTIVE           not an active TEACHER (assignSubstitute's own rule)
 *   ON_LESSON          already has a row on this lesson
 *   ABSENT             has an ACTIVE absence overlapping the lesson
 *   BUSY_LESSON        a SCHEDULED or COMPLETED lesson overlapping; end ==
 *                      start is free, a cancelled lesson frees its time
 *   BUSY_DUTY          an uppdrag's fixed slot covers the time (the duty's
 *                      label and kind, never its note)
 *   UNAVAILABLE        a TEACHER UNAVAILABLE row covers the time (never its
 *                      free-text reason, which can say "sjukskriven")
 *   BOOKED_ROOM        holds a PENDING or APPROVED room booking overlapping
 *   LUNCH              the work rule's lunch fitted before and does not after
 *                      — a lunch already impossible is not the cover's fault
 *   DAILY_REST         the work rule's rest between days held before and
 *                      does not after, against the day before or after
 *   POOL_NOT_DECLARED  a pool member without a post this year, and no window
 *                      they declared contains the whole lesson
 *
 * All rules are MONOTONE: taking an assignment away never breaks one, so any
 * subset of a valid day proposal is valid (day-proposal.spec.ts proves it).
 *
 * Times are epoch milliseconds, lifted from the school's wall clock by the
 * reader (publish-days.ts' coversTime does the same for publish), so this
 * module has no timezone in it.
 */

export type HardRuleCode =
  | 'INACTIVE'
  | 'ON_LESSON'
  | 'ABSENT'
  | 'BUSY_LESSON'
  | 'BUSY_DUTY'
  | 'UNAVAILABLE'
  | 'BOOKED_ROOM'
  | 'LUNCH'
  | 'DAILY_REST'
  | 'POOL_NOT_DECLARED';

export interface RuleFinding {
  code: HardRuleCode;
  params: Record<string, string | number>;
}

export interface Span {
  start: number;
  end: number;
}

export type LessonStatusValue = 'SCHEDULED' | 'CANCELLED' | 'COMPLETED' | 'RESCHEDULED';

/** A lesson the person has a row on, D−1 to D+1. */
export interface PersonLesson {
  id: string;
  /** The school-local date, YYYY-MM-DD (the CalendarLessons.date column). */
  date: string;
  start: number;
  end: number;
  status: LessonStatusValue;
  studentGroupId: string;
  subjectId: string;
  /** Why a CANCELLED lesson is cancelled; the ranking tells an activity (EVENT) from the rest. */
  cancelCause?: string | null;
}

export interface PersonClosure {
  span: Span;
  kind: 'DUTY' | 'UNAVAILABLE';
  /** The uppdrag's label for a duty slot; null for a plain closure. */
  label: string | null;
}

/** One person's day as the rules read it. */
export interface PersonDay {
  userId: string;
  isActiveTeacher: boolean;
  lessons: PersonLesson[];
  closures: PersonClosure[];
  preferredFree: Span[];
  bookings: Span[];
  absences: Span[];
  /** The lunch the work rule owes, lifted onto the day; null = no rule. */
  lunch: { minutes: number; window: Span } | null;
  /** Null = no rule. */
  minDailyRestMinutes: number | null;
  pool: { member: boolean; hasEmployment: boolean; windows: Span[] };
}

/** The lesson to be covered. */
export interface CoverTarget {
  id: string;
  date: string;
  start: number;
  end: number;
  teacherIds: readonly string[];
}

const MINUTE = 60_000;

/** True when [a.start, a.end) and [b.start, b.end) share an instant; touching is free. */
export function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

/** A lesson that takes the person's time: SCHEDULED or COMPLETED. */
export function holdsTime(lesson: PersonLesson): boolean {
  return lesson.status === 'SCHEDULED' || lesson.status === 'COMPLETED';
}

/**
 * Whether a free stretch of `minutes` exists inside `window` around `busy`.
 * An exact fit counts.
 */
export function hasGap(busy: readonly Span[], window: Span, minutes: number): boolean {
  const need = minutes * MINUTE;
  const clipped = busy
    .filter((span) => overlaps(span, window))
    .map((span) => ({ start: Math.max(span.start, window.start), end: Math.min(span.end, window.end) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = window.start;
  for (const span of clipped) {
    if (span.start - cursor >= need) return true;
    cursor = Math.max(cursor, span.end);
  }
  return window.end - cursor >= need;
}

function previousDate(date: string): string {
  const day = new Date(`${date}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

function nextDate(date: string): string {
  const day = new Date(`${date}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

function lunchBroken(day: PersonDay, target: CoverTarget, lessons: readonly PersonLesson[]): boolean {
  if (!day.lunch) return false;
  const window = day.lunch.window;
  const cover: Span = { start: target.start, end: target.end };
  if (!overlaps(cover, window)) return false;
  const busy: Span[] = [
    ...lessons.filter((lesson) => holdsTime(lesson) && lesson.date === target.date && lesson.id !== target.id),
    ...day.bookings,
    ...day.closures.map((closure) => closure.span),
  ];
  return hasGap(busy, window, day.lunch.minutes) && !hasGap([...busy, cover], window, day.lunch.minutes);
}

function restBroken(day: PersonDay, target: CoverTarget, lessons: readonly PersonLesson[]): 'BEFORE' | 'AFTER' | null {
  const rest = day.minDailyRestMinutes;
  if (rest === null) return null;
  const need = rest * MINUTE;
  const held = lessons.filter((lesson) => holdsTime(lesson) && lesson.id !== target.id);
  const on = (date: string) => held.filter((lesson) => lesson.date === date);
  const today = on(target.date);
  const before = on(previousDate(target.date));
  const after = on(nextDate(target.date));

  if (before.length > 0) {
    const lastEnd = Math.max(...before.map((lesson) => lesson.end));
    const firstWithout = today.length > 0 ? Math.min(...today.map((lesson) => lesson.start)) : null;
    const firstWith = Math.min(firstWithout ?? Infinity, target.start);
    if (firstWith - lastEnd < need && (firstWithout === null || firstWithout - lastEnd >= need)) return 'BEFORE';
  }
  if (after.length > 0) {
    const nextStart = Math.min(...after.map((lesson) => lesson.start));
    const lastWithout = today.length > 0 ? Math.max(...today.map((lesson) => lesson.end)) : null;
    const lastWith = Math.max(lastWithout ?? -Infinity, target.end);
    if (nextStart - lastWith < need && (lastWithout === null || nextStart - lastWithout >= need)) return 'AFTER';
  }
  return null;
}

/**
 * Every hard rule the person would break by covering `target`, in the order
 * of the header. `added` are lessons given to them earlier in the same day
 * proposal, counted as SCHEDULED.
 */
export function hardFindings(
  day: PersonDay,
  target: CoverTarget,
  added: readonly PersonLesson[] = [],
): RuleFinding[] {
  const findings: RuleFinding[] = [];
  const cover: Span = { start: target.start, end: target.end };
  const lessons = [...day.lessons, ...added];

  if (!day.isActiveTeacher) findings.push({ code: 'INACTIVE', params: {} });
  if (target.teacherIds.includes(day.userId)) findings.push({ code: 'ON_LESSON', params: {} });
  if (day.absences.some((span) => overlaps(span, cover))) findings.push({ code: 'ABSENT', params: {} });
  const busy = lessons.find((lesson) => lesson.id !== target.id && holdsTime(lesson) && overlaps(lesson, cover));
  if (busy) findings.push({ code: 'BUSY_LESSON', params: { lessonId: busy.id } });
  for (const closure of day.closures) {
    if (!overlaps(closure.span, cover)) continue;
    if (closure.kind === 'DUTY') findings.push({ code: 'BUSY_DUTY', params: { label: closure.label ?? '' } });
    else findings.push({ code: 'UNAVAILABLE', params: {} });
  }
  if (day.bookings.some((span) => overlaps(span, cover))) findings.push({ code: 'BOOKED_ROOM', params: {} });
  if (lunchBroken(day, target, lessons)) findings.push({ code: 'LUNCH', params: { minutes: day.lunch!.minutes } });
  const rest = restBroken(day, target, lessons);
  if (rest) findings.push({ code: 'DAILY_REST', params: { side: rest, minutes: day.minDailyRestMinutes! } });
  if (
    day.pool.member &&
    !day.pool.hasEmployment &&
    !day.pool.windows.some((window) => window.start <= target.start && window.end >= target.end)
  ) {
    findings.push({ code: 'POOL_NOT_DECLARED', params: {} });
  }
  return dedupe(findings);
}

/** True when the person breaks no hard rule. */
export function isFeasible(day: PersonDay, target: CoverTarget, added: readonly PersonLesson[] = []): boolean {
  return hardFindings(day, target, added).length === 0;
}

/** Whether a PREFERRED_FREE row overlaps: a ranking penalty, never a filter. */
export function prefersFree(day: PersonDay, target: CoverTarget): boolean {
  return day.preferredFree.some((span) => overlaps(span, { start: target.start, end: target.end }));
}

/**
 * The warnings a MANUAL pick gets (assignSubstitute): the hard rules a
 * rektor may override, informed — a teacher may agree to skip lunch — as
 * behörighet is a warning and never a refusal (Fas 2). An overlapping lesson
 * and an absence stay refusals, and are not repeated here.
 */
export type CoverWarningCode =
  | 'COVER_BREAKS_LUNCH'
  | 'COVER_BREAKS_DAILY_REST'
  | 'COVER_TEACHER_UNAVAILABLE'
  | 'COVER_TEACHER_BOOKED'
  | 'COVER_POOL_NOT_DECLARED';

const WARNING_OF: Partial<Record<HardRuleCode, CoverWarningCode>> = {
  LUNCH: 'COVER_BREAKS_LUNCH',
  DAILY_REST: 'COVER_BREAKS_DAILY_REST',
  BUSY_DUTY: 'COVER_TEACHER_UNAVAILABLE',
  UNAVAILABLE: 'COVER_TEACHER_UNAVAILABLE',
  BOOKED_ROOM: 'COVER_TEACHER_BOOKED',
  POOL_NOT_DECLARED: 'COVER_POOL_NOT_DECLARED',
};

export function softWarnings(findings: readonly RuleFinding[]): { code: CoverWarningCode; params: Record<string, string | number> }[] {
  const seen = new Set<CoverWarningCode>();
  const warnings: { code: CoverWarningCode; params: Record<string, string | number> }[] = [];
  for (const finding of findings) {
    const code = WARNING_OF[finding.code];
    if (!code || seen.has(code)) continue;
    seen.add(code);
    warnings.push({ code, params: finding.params });
  }
  return warnings;
}

function dedupe(findings: RuleFinding[]): RuleFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.code}:${JSON.stringify(finding.params)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
