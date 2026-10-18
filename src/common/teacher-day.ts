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
 * A TEACHING DAY is a weekday with at least one such lesson. A lesson that
 * does not end after it starts takes no time and makes no day: the clash
 * check refuses one on every write, but the table has no CHECK for it, and
 * the engine skips such a lock the same way, so the two cannot disagree
 * over a row nobody can create today.
 *
 * IN THE WEEKS A LESSON ACTUALLY RUNS, ISO week by ISO week, as publishing
 * puts it in the calendar: a lesson runs in a week when it runs on its own
 * weekday's date of that week by calendar/lesson-recurrence.ts's runsOn —
 * the week's parity, and that date inside its window. A lesson every odd
 * week and another every even week on the same Monday hour are one Monday
 * hour in any week a school has; a Monday lesson that ends on a Tuesday and
 * a Friday lesson that starts on the Wednesday after are both taught in
 * that one week, on two days, though no date has both. The engine has no
 * weeks at all and counts every lesson, the stricter reading, which is the
 * safe direction for a generator and the noisy one for a warning.
 *
 * PURE. Dates are 'YYYY-MM-DD', read as the midnight UTC a @db.Date column
 * holds, which is what runsOn is asked about; times are minutes since
 * midnight.
 */
import { runsOn } from '../calendar/lesson-recurrence';

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

const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' as the midnight UTC a @db.Date column holds. */
const parseDay = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * DAY_MS);

/** The Monday of the ISO week holding `date`. */
const mondayOf = (date: Date): Date => addDays(date, 1 - (date.getUTCDay() || 7));

/**
 * A Monday of an odd ISO week (2024's week 1) and the Monday after it, of an
 * even one: every week of a parity holds the same lessons when no lesson has
 * a date.
 */
const UNDATED_WEEKS = [parseDay('2024-01-01'), parseDay('2024-01-08')];

/**
 * Whether the lesson runs in the ISO week that starts on `monday`: whether it
 * runs on its own weekday's date of that week, by the rule publishing
 * materialises it with (runsOn). The date is in the same ISO week as the
 * Monday, so its parity is the week's.
 */
function runsInWeek(lesson: TeachingLesson, monday: Date): boolean {
  return runsOn(
    {
      recurrence: lesson.recurrence,
      startDate: lesson.startDate ? parseDay(lesson.startDate) : null,
      endDate: lesson.endDate ? parseDay(lesson.endDate) : null,
    },
    addDays(monday, lesson.dayOfWeek - 1),
  );
}

/**
 * The lessons that run together in some ISO weeks, one set per week — weeks
 * enough that every set of lessons running together in ANY week is inside
 * one of these sets. Both limits only grow with the set, so the most a week
 * here holds is the most any week holds, and a lesson that runs in a week
 * over a limit runs in one of these over it; each is a real week, so nothing
 * here is over a limit that no week is.
 *
 * WHY THESE WEEKS ARE ENOUGH. Take lessons S that all run in a week W. A
 * lesson is inside its window in consecutive weeks only — its own date in a
 * week moves forward with the week — and a lesson open at the start is
 * inside it in every week before one it runs in. So from the latest FIRST
 * WEEK among S's members with a start date (the week of the member's first
 * own date on or after its start) up to W, every week is inside every
 * member's window, and the first of those with W's parity holds all of S.
 * ISO parity alternates except across a year of 53 weeks, whose week 53 and
 * the week 1 after it are both odd (2026's is), so that week is the first
 * week itself, the next or the one after: three weeks per start date. When
 * no member of S has a start date, look before the earliest date any lesson
 * has: every lesson open at the start is inside its window in those weeks,
 * so the one of W's parity among the three before it holds S — three in a
 * row always hold both parities. When no lesson has a date at all, an odd
 * week and an even week hold every set there is.
 */
function weeksOf(lessons: readonly TeachingLesson[]): TeachingLesson[][] {
  const mondays = new Map<number, Date>();
  const take = (monday: Date) => {
    for (let week = 0; week < 3; week++) {
      const next = addDays(monday, 7 * week);
      mondays.set(next.getTime(), next);
    }
  };
  const dates = lessons
    .flatMap((lesson) => [lesson.startDate, lesson.endDate])
    .filter((date): date is string => !!date)
    .sort();
  if (dates.length === 0) {
    for (const monday of UNDATED_WEEKS) mondays.set(monday.getTime(), monday);
  } else {
    take(addDays(mondayOf(parseDay(dates[0]!)), -21));
  }
  for (const lesson of lessons) {
    if (!lesson.startDate) continue;
    const start = parseDay(lesson.startDate);
    // The lesson's first own date on or after its start.
    take(mondayOf(addDays(start, (lesson.dayOfWeek - (start.getUTCDay() || 7) + 7) % 7)));
  }
  return [...mondays.values()].map((monday) => lessons.filter((lesson) => runsInWeek(lesson, monday)));
}

/**
 * Every way one teacher's week breaks their rule: the cap per weekday in
 * weekday order, then the days.
 *
 * `lessons` are every lesson the teacher is on in the läsår's grundschema, as
 * lead or medlärare, parked ones left out by the caller.
 *
 * `about`, when given, are the lessons a hand edit just wrote, and only the
 * weeks that hold one of them count — for the cap, a weekday of a week that
 * holds one of them on that weekday — both for the figure and for the
 * lessons named: a breach says what the edit made, and a week the edit is
 * no part of, over the limit before it and after it alike, is not its to
 * repeat. A breach is then always about one of them.
 */
export function teacherDayBreaches(
  rule: TeacherDayRule,
  lessons: readonly TeachingLesson[],
  about?: ReadonlySet<string>,
): TeacherDayBreach[] {
  const taking = lessons.filter((lesson) => lesson.endMinutes > lesson.startMinutes);
  if (!hasTeacherDayRule(rule) || taking.length === 0) return [];
  const counted = (set: readonly TeachingLesson[]) => about === undefined || set.some((lesson) => about.has(lesson.id));
  const weeks = weeksOf(taking);
  const breaches: TeacherDayBreach[] = [];

  const cap = rule.maxTeachingMinutesPerDay;
  if (cap !== null) {
    const days = [...new Set(taking.map((lesson) => lesson.dayOfWeek))].sort((a, b) => a - b);
    for (const day of days) {
      let most = 0;
      const over = new Set<string>();
      for (const week of weeks) {
        const onDay = week.filter((lesson) => lesson.dayOfWeek === day);
        if (!counted(onDay)) continue;
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
      if (!counted(week)) continue;
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
