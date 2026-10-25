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
 *   BUSY_SUPERVISION   a rastvaktspass of theirs runs then: their own pass
 *                      on its date (unless a decision has relieved them of
 *                      it that day), or one they have taken as vikarie
 *                      (Rastvakt i vardagen, 20261210090000). One place at a
 *                      time, as the rastvaktsschema's own rule
 *   BUSY_DUTY          an uppdrag's fixed slot covers the time (the duty's
 *                      label and kind, never its note)
 *   UNAVAILABLE        a TEACHER UNAVAILABLE row covers the time (never its
 *                      free-text reason, which can say "sjukskriven")
 *   BOOKED_ROOM        holds a PENDING or APPROVED room booking overlapping
 *   LUNCH              the work rule's lunch fitted before and does not after
 *                      — a lunch already impossible is not the cover's fault
 *   DAILY_REST         the work rule's rest between days held before and
 *                      does not after, against the day before or after
 *   DAILY_CAP          the work rule's cap on a day's teaching (Lärarens
 *                      dag): the minutes the person teaches on the date with
 *                      the cover, overlaps counted once, are more than it
 *   WORK_DAYS          the post's deltid in days: the date is one of the ISO
 *                      week they teach nothing on yet, and the week would
 *                      then hold more teaching dates than the post allows
 *   POOL_NOT_DECLARED  a pool member without a post this year, and no window
 *                      they declared contains the whole lesson
 *
 * All rules are MONOTONE: taking an assignment away never breaks one, so any
 * subset of a valid day proposal is valid (day-proposal.spec.ts proves it).
 *
 * THE CAP FIRES WHENEVER THE DAY ENDS OVER IT, unlike the lunch. A lunch the
 * day had already made impossible is not the cover's to lose, so the lunch
 * asks "held before, broken after"; a day already over its cap is made longer
 * by every lesson put in it, and that is what the cap is there to stop. "Over
 * after" only grows with the lessons, so it is monotone as it stands. What
 * counts is src/common/teacher-day.ts's one definition: every lesson the
 * person holds a row on that date, whatever the role, that holds its time,
 * its own minutes start to end, two overlapping ones as their union.
 *
 * A NEW DAY IS JUDGED AGAINST THE STORED WEEK, not against the stored week
 * and the proposal's own picks. Two picks on one date the person does not
 * teach on would otherwise each find the date taught by the other and pass
 * together, while either alone is refused: taking one away would break a
 * rule, which the contract above forbids, and the pair would put a three-day
 * post on a fourth day. The count includes the picks: a pick on another new
 * date of the week is a day too.
 *
 * THE DAYS ARE HR DATA AND THE RULE IS NOT (Roller i skolan). The verdict is
 * the same for every reader — an administrator who may not read the post
 * would otherwise put a part-timer on their day off — and hardFindings never
 * asks who is reading. Only the wording is: maskFindings and maskWarnings
 * leave the figure out for a reader without HR-läs, the precedent of
 * STAFF_TEACHER_OVER_TARGET_HIDDEN (src/staffing/staffing-checks.ts). What
 * remains can be counted from the timetable everybody reads: a teacher seen
 * on Monday to Wednesday and refused Thursday has a limit of three. That
 * was weighed for the over-target verdict and accepted (4c65c4b7), and holds
 * here: the rule cannot both bind and say nothing. The cap is the work rule's,
 * which every member of staff reads, and keeps its minutes.
 *
 * A PASS IS A TARGET TOO (Rastvakt i vardagen). The board asks the same rules
 * of a rastvaktspass whose teacher is away (`kind: 'PASS'`), with one rule
 * left out: the cap counts a day's teaching, and a pass is not teaching. The
 * rest hold as they stand — a part-timer is not called in on their day off
 * for twenty minutes on the yard either, and a pass at lunch takes the
 * lunch's time as a lesson does.
 *
 * Times are epoch milliseconds, lifted from the school's wall clock by the
 * reader (publish-days.ts' coversTime does the same for publish), so this
 * module has no timezone in it.
 */

import { unionMinutes } from '../common/teacher-day';

export type HardRuleCode =
  | 'INACTIVE'
  | 'ON_LESSON'
  | 'ABSENT'
  | 'BUSY_LESSON'
  | 'BUSY_SUPERVISION'
  | 'BUSY_DUTY'
  | 'UNAVAILABLE'
  | 'BOOKED_ROOM'
  | 'LUNCH'
  | 'DAILY_REST'
  | 'DAILY_CAP'
  | 'WORK_DAYS'
  /** Never from hardFindings: maskFindings' WORK_DAYS, without the figure. */
  | 'WORK_DAYS_HIDDEN'
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
  /** Where it is held: the ranking's walk between sites (cover-rank.ts, TRAVEL_TOO_SHORT). */
  roomId?: string | null;
}

/**
 * A rastvaktspass that holds the person's time on the day (20261210090000):
 * one of their own on its date, or one they have taken as vikarie. Its id is
 * passTargetId(shiftId, date), so the pass being covered is never its own
 * clash.
 */
export interface PersonPass {
  id: string;
  date: string;
  start: number;
  end: number;
}

/** The id a pass occurrence has as a cover target and as a PersonPass. */
export function passTargetId(shiftId: string, date: string): string {
  return `pass:${shiftId}:${date}`;
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
  /** Their rastvaktspass on the day (20261210090000); absent is none. */
  supervision?: PersonPass[];
  preferredFree: Span[];
  bookings: Span[];
  absences: Span[];
  /** The lunch the work rule owes, lifted onto the day; null = no rule. */
  lunch: { minutes: number; window: Span } | null;
  /** Null = no rule. */
  minDailyRestMinutes: number | null;
  /** The work rule's cap on a day's teaching, in minutes; null or absent = no cap. */
  dailyCapMinutes?: number | null;
  /** The post's deltid in days; null or absent = no limit. HR data (hr-visibility.ts). */
  maxTeachingDaysPerWeek?: number | null;
  /**
   * The dates of the date's ISO week on which the person holds a lesson that
   * holds its time, as the calendar stands (YYYY-MM-DD). Read only for a
   * person with a day limit; absent is none.
   */
  weekTeachingDates?: readonly string[];
  /** The ISO weekday the work rule wishes free: a ranking term, never a rule. */
  preferredFreeDay?: number | null;
  pool: { member: boolean; hasEmployment: boolean; windows: Span[] };
}

/** The lesson to be covered. */
export interface CoverTarget {
  id: string;
  date: string;
  start: number;
  end: number;
  teacherIds: readonly string[];
  /** Where it is held; read by the ranking's walk between sites, never by a hard rule. */
  roomId?: string | null;
  /** A rastvaktspass (20261210090000) rather than a lesson: the cap does not apply. Absent is a lesson. */
  kind?: 'LESSON' | 'PASS';
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
    ...(day.supervision ?? []).filter((pass) => pass.date === target.date && pass.id !== target.id),
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
 * The minutes the person teaches on the cover's date with the cover in it:
 * their lessons there that hold their time and the cover, as one union. A
 * row of theirs on the covered lesson itself is the cover's span again, and
 * the union counts it once.
 */
function teachingMinutesWith(target: CoverTarget, lessons: readonly PersonLesson[]): number {
  const held = lessons.filter((lesson) => holdsTime(lesson) && lesson.date === target.date);
  return unionMinutes([...held, target].map((span) => ({ startMinutes: span.start / MINUTE, endMinutes: span.end / MINUTE })));
}

function capBroken(day: PersonDay, target: CoverTarget, lessons: readonly PersonLesson[]): boolean {
  if (target.kind === 'PASS') return false;
  const cap = day.dailyCapMinutes ?? null;
  return cap !== null && teachingMinutesWith(target, lessons) > cap;
}

function daysBroken(day: PersonDay, target: CoverTarget, added: readonly PersonLesson[]): boolean {
  const max = day.maxTeachingDaysPerWeek ?? null;
  if (max === null) return false;
  const stored = day.weekTeachingDates ?? [];
  if (stored.includes(target.date)) return false;
  return new Set([...stored, ...added.map((lesson) => lesson.date), target.date]).size > max;
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
  if ((day.supervision ?? []).some((pass) => pass.id !== target.id && overlaps(pass, cover))) {
    findings.push({ code: 'BUSY_SUPERVISION', params: {} });
  }
  for (const closure of day.closures) {
    if (!overlaps(closure.span, cover)) continue;
    if (closure.kind === 'DUTY') findings.push({ code: 'BUSY_DUTY', params: { label: closure.label ?? '' } });
    else findings.push({ code: 'UNAVAILABLE', params: {} });
  }
  if (day.bookings.some((span) => overlaps(span, cover))) findings.push({ code: 'BOOKED_ROOM', params: {} });
  if (lunchBroken(day, target, lessons)) findings.push({ code: 'LUNCH', params: { minutes: day.lunch!.minutes } });
  const rest = restBroken(day, target, lessons);
  if (rest) findings.push({ code: 'DAILY_REST', params: { side: rest, minutes: day.minDailyRestMinutes! } });
  if (capBroken(day, target, lessons)) findings.push({ code: 'DAILY_CAP', params: { minutes: day.dailyCapMinutes! } });
  if (daysBroken(day, target, added)) findings.push({ code: 'WORK_DAYS', params: { days: day.maxTeachingDaysPerWeek! } });
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
 * COVER_TRAVEL_TIME_SHORT is no hard rule's: the walk between two sites the
 * pick leaves too little time for (common/site-travel.ts), what the
 * suggestions rank down as TRAVEL_TOO_SHORT (cover-rank.ts).
 */
export type CoverWarningCode =
  | 'COVER_BREAKS_LUNCH'
  | 'COVER_BREAKS_DAILY_REST'
  | 'COVER_EXCEEDS_DAILY_CAP'
  | 'COVER_BEYOND_WORK_DAYS'
  /** Never from softWarnings: maskWarnings' COVER_BEYOND_WORK_DAYS, without the figure. */
  | 'COVER_BEYOND_WORK_DAYS_HIDDEN'
  | 'COVER_TEACHER_UNAVAILABLE'
  | 'COVER_TEACHER_ON_SUPERVISION'
  | 'COVER_TEACHER_BOOKED'
  | 'COVER_POOL_NOT_DECLARED'
  | 'COVER_TRAVEL_TIME_SHORT';

/**
 * The cap and the days stay warnings too, as the lunch and the rest do: the
 * rektor at 07:45 with one free colleague may ask a part-timer in on their
 * day off, and the teacher may agree. Neither is in the web's REFUSED_PICK.
 */
const WARNING_OF: Partial<Record<HardRuleCode, CoverWarningCode>> = {
  LUNCH: 'COVER_BREAKS_LUNCH',
  DAILY_REST: 'COVER_BREAKS_DAILY_REST',
  DAILY_CAP: 'COVER_EXCEEDS_DAILY_CAP',
  WORK_DAYS: 'COVER_BEYOND_WORK_DAYS',
  BUSY_DUTY: 'COVER_TEACHER_UNAVAILABLE',
  // A pass, as an uppdrag's slot: a rektor may ask the rastvakt to swap.
  BUSY_SUPERVISION: 'COVER_TEACHER_ON_SUPERVISION',
  UNAVAILABLE: 'COVER_TEACHER_UNAVAILABLE',
  BOOKED_ROOM: 'COVER_TEACHER_BOOKED',
  POOL_NOT_DECLARED: 'COVER_POOL_NOT_DECLARED',
};

export interface SoftWarning {
  code: CoverWarningCode;
  params: Record<string, string | number>;
}

export function softWarnings(findings: readonly RuleFinding[]): SoftWarning[] {
  const seen = new Set<CoverWarningCode>();
  const warnings: SoftWarning[] = [];
  for (const finding of findings) {
    const code = WARNING_OF[finding.code];
    if (!code || seen.has(code)) continue;
    seen.add(code);
    warnings.push({ code, params: finding.params });
  }
  return warnings;
}

/**
 * The findings as a reader may be told them: WORK_DAYS without its figure
 * for a reader without HR-läs (`showsHr`, hr-visibility.ts readsHr), every
 * other finding as it is. The same verdict either way (the header).
 */
export function maskFindings(findings: readonly RuleFinding[], showsHr: boolean): RuleFinding[] {
  return findings.map((finding) =>
    !showsHr && finding.code === 'WORK_DAYS' ? { code: 'WORK_DAYS_HIDDEN', params: {} } : finding,
  );
}

/** The warnings as a reader may be told them, by maskFindings' rule. */
export function maskWarnings(warnings: readonly SoftWarning[], showsHr: boolean): SoftWarning[] {
  return warnings.map((warning) =>
    !showsHr && warning.code === 'COVER_BEYOND_WORK_DAYS' ? { code: 'COVER_BEYOND_WORK_DAYS_HIDDEN', params: {} } : warning,
  );
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
