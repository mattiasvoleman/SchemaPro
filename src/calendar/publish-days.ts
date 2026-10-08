import { zonedTimeToUtc } from '../common/utils/time';

/*
 * Which days a weekly template becomes a lesson on — the date walk of
 * CalendarService.publish, as pure functions.
 *
 * Extracted so that the one other reader of the rule, the timplan's
 * projection past the publish horizon (src/common/timplan-delivered.ts),
 * walks the SAME days publish would write: a lov, a studiedag for åk 1–3, a
 * dated class closure. A second copy of "which days does this class have
 * lessons" is how a lov stops being honoured in one of them. publish calls
 * these with no change in behaviour; its spec, untouched by the extraction,
 * is the safety net.
 *
 * Dates are school-local calendar days as "YYYY-MM-DD", the unit publish
 * walks in and builds every startsAt from. Only a closure's clock part is
 * lifted into an instant, through the school's timezone, to be compared with
 * a lesson's own hours.
 */

/** A SchoolBreak as the walk needs it: a range, maybe narrowed to grades. */
export interface PublishBreak {
  startDate: Date;
  endDate: Date;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
}

/** A dated UNAVAILABLE AvailabilityConstraint as the walk needs it. */
export interface PublishClosure {
  resourceType: string;
  userId: string | null;
  roomId: string | null;
  studentGroupId: string | null;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  date: Date | null;
  startTime: Date;
  endTime: Date;
}

/** What publishSkips asks about a day, built once per walk. */
export interface PublishDaysContext {
  /** Breaks expanded onto the local days they cover (breakDaysOf). */
  breakDays: Map<string, PublishBreak[]>;
  /** Dated closures by their day (closuresByDateOf). */
  closuresByDate: Map<string, PublishClosure[]>;
  /** The årskurs of each group of the year; a teaching group's is null. */
  gradeOfGroup: Map<string, number | null>;
  timezone: string;
}

/** The template fields the class-level skips read. */
export interface PublishTemplate {
  studentGroupId: string;
  startTime: Date;
  endTime: Date;
}

export function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function parseUtcDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

export function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

export function clampDate(value: string, min: string, max: string): string {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function* iterateDates(from: string, to: string): Generator<string> {
  const cursor = parseUtcDate(from);
  const end = parseUtcDate(to).getTime();
  while (cursor.getTime() <= end) {
    yield toDateString(cursor);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

/** ISO weekday for a YYYY-MM-DD string: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  const jsDay = parseUtcDate(date).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

/** A @db.Time as the wall clock it is, "HH:MM:SS". */
export function timeToString(time: Date): string {
  const h = time.getUTCHours().toString().padStart(2, '0');
  const m = time.getUTCMinutes().toString().padStart(2, '0');
  const s = time.getUTCSeconds().toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export function isFullDay(start: Date, end: Date): boolean {
  const startMinutes = start.getUTCHours() * 60 + start.getUTCMinutes();
  const endMinutes = end.getUTCHours() * 60 + end.getUTCMinutes();
  return startMinutes === 0 && (endMinutes === 0 || endMinutes >= 23 * 60 + 59);
}

/**
 * Is a group of this årskurs inside the break — off school that day?
 *
 * Both bounds null is the ordinary lov: the whole school, answered without
 * asking the group's year. A span narrows it to prao för åk 9 or a studiedag
 * for the lower years, and then the group's own year has to sit inside it. A
 * group with no year — a nivågrupp drawn across several — cannot be shown to
 * be inside, so its lesson survives: erasing a lesson on a guess is the worse
 * mistake.
 */
export function breakCoversGroup(
  entry: { minGradeLevel: number | null; maxGradeLevel: number | null },
  grade: number | null | undefined,
): boolean {
  if (entry.minGradeLevel === null && entry.maxGradeLevel === null) return true;
  if (typeof grade !== 'number') return false;
  return (
    (entry.minGradeLevel === null || grade >= entry.minGradeLevel) &&
    (entry.maxGradeLevel === null || grade <= entry.maxGradeLevel)
  );
}

/**
 * The breaks expanded onto the local days of [from, to] they cover. Inclusive
 * at both ends, so a jullov that began before the window still closes the
 * days of it inside.
 */
export function breakDaysOf<T extends PublishBreak>(
  breaks: readonly T[],
  from: string,
  to: string,
): Map<string, T[]> {
  const days = new Map<string, T[]>();
  for (const entry of breaks) {
    const start = maxDate(toDateString(entry.startDate), from);
    const end = minDate(toDateString(entry.endDate), to);
    for (const date of iterateDates(start, end)) {
      const list = days.get(date);
      if (list) list.push(entry);
      else days.set(date, [entry]);
    }
  }
  return days;
}

/** Dated closures by their day; a closure without a date is not one. */
export function closuresByDateOf<T extends PublishClosure>(closures: readonly T[]): Map<string, T[]> {
  const byDate = new Map<string, T[]>();
  for (const closure of closures) {
    if (!closure.date) continue;
    const key = toDateString(closure.date);
    const list = byDate.get(key);
    if (list) list.push(closure);
    else byDate.set(key, [closure]);
  }
  return byDate;
}

/**
 * Does this closure cover the lesson's own hours on that date? The closure's
 * times are a bare wall clock and the lesson a real instant, so both are
 * lifted into the same unit through the school's timezone — the conversion
 * that builds startsAt.
 */
export function coversTime(
  closure: { startTime: Date; endTime: Date },
  date: string,
  startsAt: Date,
  endsAt: Date,
  timezone: string,
): boolean {
  if (isFullDay(closure.startTime, closure.endTime)) return true;
  const from = zonedTimeToUtc(date, timeToString(closure.startTime), timezone);
  const to = zonedTimeToUtc(date, timeToString(closure.endTime), timezone);
  return from.getTime() < endsAt.getTime() && startsAt.getTime() < to.getTime();
}

/**
 * Why publish writes NOTHING for this template on this date, or null.
 *
 *   BREAK         a lov or studiedag covers the template's group (by its
 *                 årskurs; a teaching group only by a school-wide one)
 *   CLASS_CLOSED  a dated STUDENT_GROUP closure on the group, or a dated
 *                 GRADE_LEVEL closure on its årskurs, covers the lesson's hours
 *
 * Asked after runsOn (the recurrence and window) and after the idempotency
 * set; a teacher or room closure is not a skip — publish writes the lesson
 * CANCELLED, because the class is still there.
 */
export function publishSkips(
  template: PublishTemplate,
  date: string,
  ctx: PublishDaysContext,
): 'BREAK' | 'CLASS_CLOSED' | null {
  const grade = ctx.gradeOfGroup.get(template.studentGroupId);
  if ((ctx.breakDays.get(date) ?? []).some((entry) => breakCoversGroup(entry, grade))) return 'BREAK';
  const closures = ctx.closuresByDate.get(date);
  if (!closures || closures.length === 0) return null;
  const startsAt = zonedTimeToUtc(date, timeToString(template.startTime), ctx.timezone);
  const endsAt = zonedTimeToUtc(date, timeToString(template.endTime), ctx.timezone);
  for (const closure of closures) {
    if (!coversTime(closure, date, startsAt, endsAt, ctx.timezone)) continue;
    if (closure.resourceType === 'STUDENT_GROUP' && closure.studentGroupId === template.studentGroupId) {
      return 'CLASS_CLOSED';
    }
    if (
      closure.resourceType === 'GRADE_LEVEL' &&
      typeof grade === 'number' &&
      (closure.minGradeLevel === null || grade >= closure.minGradeLevel) &&
      (closure.maxGradeLevel === null || grade <= closure.maxGradeLevel)
    ) {
      return 'CLASS_CLOSED';
    }
  }
  return null;
}
