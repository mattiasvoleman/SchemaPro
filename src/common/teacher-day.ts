/**
 * LÄRARENS DAG: HOW MUCH A TEACHER TEACHES ON ONE DAY, AND ON HOW MANY DAYS.
 *
 * The administrator sets two limits per teacher (migration 20261123090000):
 * a daily cap in minutes on the work rule (TeacherWorkRules, staff-readable)
 * and deltid in days on the post (TeacherEmployments, HR). The generator
 * holds both as hard rules (optimization-engine, _add_teacher_day_constraints),
 * a hand edit of the grundschema that breaks one is warned about
 * (master-lessons.service.ts), and the Vikarietavla does not propose a cover
 * that would (src/cover/cover-rules.ts). This module is what the gateway
 * counts, and benchmarks/validate_schedule.py replays
 * __fixtures__/teacher-day-cases.json for the same arithmetic without sharing
 * a line with it.
 *
 * WHAT COUNTS AS TEACHING, ONE DEFINITION FOR ALL THREE. Every lesson the
 * teacher is on — as lead or as medlärare, since a co-taught lesson occupies
 * both adults for its whole length — counted in its own minutes, start to
 * end. Not the pupils' padding around idrott, not a rast, not an uppdrag or a
 * rastvakt: those are work but not teaching, and the cap is about teaching. A
 * parked lesson occupies nothing. Two lessons that overlap (a hand-made pair
 * the clash check let through, a parallel block the teacher sits in twice)
 * count their union once: the teacher is in one room at a time, and a cap
 * that counted the hour twice would refuse a day nobody teaches longer.
 *
 * MINUTES, NOT LESSONS, because every other figure about a teacher's time is
 * minutes — the riktmärke, the load, the lunch, the rest — and because lessons
 * are not one length: two 80-minute slöjd lessons and two 40-minute ones are
 * not the same day.
 *
 * A TEACHING DAY is a weekday with at least one such lesson.
 *
 * IN THE WEEKS A LESSON ACTUALLY RUNS, as subject-distribution.ts reads them:
 * a lesson every odd week and another every even week on the same Monday
 * hour are one Monday hour in any week a school has. The engine has no weeks
 * at all and counts every lesson, the stricter reading, which is the safe
 * direction for a generator and the noisy one for a warning.
 *
 * PURE. Dates are 'YYYY-MM-DD', which compare as strings; times are minutes
 * since midnight.
 */

/** Bounds shared by the DTOs, the CHECKs (20261123090000) and the engine. */
export const MAX_TEACHING_MINUTES_PER_DAY_MIN = 30;
export const MAX_TEACHING_MINUTES_PER_DAY_MAX = 720;
/** The engine's grid, like the lunch's. */
export const MAX_TEACHING_MINUTES_PER_DAY_STEP = 5;
export const MAX_TEACHING_DAYS_PER_WEEK_MIN = 1;
export const MAX_TEACHING_DAYS_PER_WEEK_MAX = 6;
/** ISO weekdays. */
export const PREFERRED_FREE_DAY_MIN = 1;
export const PREFERRED_FREE_DAY_MAX = 7;

export interface TeacherDayRule {
  /** Null: no cap. */
  maxTeachingMinutesPerDay: number | null;
  /** Null: no limit. HR data; see hr-visibility.ts. */
  maxTeachingDaysPerWeek: number | null;
}

export const NO_TEACHER_DAY_RULE: TeacherDayRule = {
  maxTeachingMinutesPerDay: null,
  maxTeachingDaysPerWeek: null,
};

export function hasTeacherDayRule(rule: TeacherDayRule): boolean {
  return rule.maxTeachingMinutesPerDay !== null || rule.maxTeachingDaysPerWeek !== null;
}

export interface Span {
  /** Minutes since midnight. */
  startMinutes: number;
  endMinutes: number;
}

/**
 * The minutes the spans cover together: overlapping or touching spans are
 * counted once, an empty or inverted span not at all.
 */
export function unionMinutes(spans: readonly Span[]): number {
  const sorted = spans
    .filter((span) => span.endMinutes > span.startMinutes)
    .slice()
    .sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes);
  let total = 0;
  let open = -Infinity;
  let close = -Infinity;
  for (const span of sorted) {
    if (span.startMinutes > close) {
      if (close > open) total += close - open;
      open = span.startMinutes;
      close = span.endMinutes;
    } else if (span.endMinutes > close) {
      close = span.endMinutes;
    }
  }
  if (close > open) total += close - open;
  return total;
}

/** One lesson of the teacher's week, as the grundschema holds it. */
export interface TeachingLesson extends Span {
  id: string;
  /** ISO weekday. */
  dayOfWeek: number;
  /** Absent is ALL_WEEKS. */
  recurrence?: 'ALL_WEEKS' | 'ODD_WEEKS' | 'EVEN_WEEKS' | null;
  startDate?: string | null;
  endDate?: string | null;
}

export type TeacherDayBreach =
  | {
      kind: 'DAILY_CAP';
      dayOfWeek: number;
      /** The most minutes the weekday holds in one week. */
      minutes: number;
      cap: number;
      /** The weekday's lessons that run in a week over the cap, sorted. */
      lessonIds: string[];
    }
  | {
      kind: 'WORK_DAYS';
      /** The most teaching days in one week. */
      days: number;
      max: number;
      /** The lessons that run in a week over the limit, sorted. */
      lessonIds: string[];
    };

/**
 * The sets of lessons that run together in some week: one per parity and per
 * start date. A set that runs in a given week is contained in the set at the
 * latest start date among its lessons — every one of them has started by then
 * and none has ended — and both limits only grow with the set, so the sets
 * here are every week the limits need to look at, and a lesson that runs in
 * a week over a limit is in one of them.
 */
function weeksOf(lessons: readonly TeachingLesson[]): TeachingLesson[][] {
  const weeks: TeachingLesson[][] = [];
  for (const parity of ['ODD_WEEKS', 'EVEN_WEEKS'] as const) {
    const running = lessons.filter((lesson) => {
      const recurrence = lesson.recurrence ?? 'ALL_WEEKS';
      return recurrence === 'ALL_WEEKS' || recurrence === parity;
    });
    // An open start is the first date there is, which no string undercuts.
    const starts = new Set(running.map((lesson) => lesson.startDate ?? ''));
    for (const date of starts) {
      weeks.push(
        running.filter(
          (lesson) =>
            (lesson.startDate ?? '') <= date && (lesson.endDate == null || lesson.endDate >= date),
        ),
      );
    }
  }
  return weeks;
}

/**
 * Every way one teacher's week breaks their rule: the cap per weekday in
 * weekday order, then the days.
 *
 * `lessons` are every lesson the teacher is on in the läsår's grundschema, as
 * lead or medlärare, parked ones left out by the caller.
 */
export function teacherDayBreaches(
  rule: TeacherDayRule,
  lessons: readonly TeachingLesson[],
): TeacherDayBreach[] {
  if (!hasTeacherDayRule(rule) || lessons.length === 0) return [];
  const weeks = weeksOf(lessons);
  const breaches: TeacherDayBreach[] = [];

  const cap = rule.maxTeachingMinutesPerDay;
  if (cap !== null) {
    const days = [...new Set(lessons.map((lesson) => lesson.dayOfWeek))].sort((a, b) => a - b);
    for (const day of days) {
      let most = 0;
      const over = new Set<string>();
      for (const week of weeks) {
        const onDay = week.filter((lesson) => lesson.dayOfWeek === day);
        const minutes = unionMinutes(onDay);
        most = Math.max(most, minutes);
        if (minutes > cap) for (const lesson of onDay) over.add(lesson.id);
      }
      if (most > cap) {
        breaches.push({
          kind: 'DAILY_CAP',
          dayOfWeek: day,
          minutes: most,
          cap,
          lessonIds: [...over].sort(),
        });
      }
    }
  }

  const max = rule.maxTeachingDaysPerWeek;
  if (max !== null) {
    let most = 0;
    const over = new Set<string>();
    for (const week of weeks) {
      const days = new Set(week.map((lesson) => lesson.dayOfWeek)).size;
      most = Math.max(most, days);
      if (days > max) for (const lesson of week) over.add(lesson.id);
    }
    if (most > max) {
      breaches.push({ kind: 'WORK_DAYS', days: most, max, lessonIds: [...over].sort() });
    }
  }

  return breaches;
}
