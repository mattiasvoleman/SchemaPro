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
 * weeks for the lessons it places and reads each as taught every week, the
 * stricter reading, which is the safe direction for a generator and the
 * noisy one for a warning; the lessons it plans around it is told week by
 * week, as the weekdays they hold together (lockedWeekdaySets), because the
 * lenient reading of those — every weekday any of them holds taught in
 * every week — let it give a part-timer's odd weeks the even weeks' day.
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

/** A läsår's first and last day, 'YYYY-MM-DD'. */
export interface YearSpan {
  startDate: string;
  endDate: string;
}

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

/** The Monday of the week of the lesson's first own date on or after `date`. */
const firstWeekFrom = (lesson: TeachingLesson, date: Date): Date =>
  mondayOf(addDays(date, (lesson.dayOfWeek - (date.getUTCDay() || 7) + 7) % 7));

/**
 * The lessons that run together in some ISO weeks, one set per week — weeks
 * enough that every set of lessons running together in ANY week IS one of
 * these sets. Both limits only grow with the set, so the most a week here
 * holds is the most any week holds, and a lesson that runs in a week over a
 * limit runs in one of these over it; each is a real week, so nothing here is
 * over a limit that no week is.
 *
 * WHY THESE WEEKS ARE EVERY WEEK THERE IS. A lesson is inside its window in
 * consecutive weeks only — its own date in a week moves forward with the
 * week — so which lessons are inside their windows changes only in an EVENT
 * WEEK: the week of a lesson's first own date on or after its start, where
 * it comes in, and the week of its first own date after its end, where it
 * goes out. Between two event weeks the lessons inside are the same, and
 * which of them run depends on the week's parity alone. ISO parity
 * alternates except across a year of 53 weeks, whose week 53 and the week 1
 * after it are both odd (2026's is) — two even weeks never follow each
 * other — so any three weeks in a row hold both parities, and the three
 * from each event week hold every set of its stretch (a stretch shorter than
 * that is all among them). The stretch before the first event is read three
 * weeks before the earliest date any lesson has, which is before every event
 * week (each lies in that date's week or later); with no date at all there
 * is no event, and an odd week and an even week hold every set there is.
 *
 * The weeks after an end were added for lockedWeekdaySets, which needs each
 * week's own set and not only one around it. They are real weeks, so
 * teacherDayBreaches reads the same figures and names the same lessons with
 * them as without: the weeks around a start already held a superset of each.
 *
 * WITH A YEAR, ONLY ITS WEEKS. A null date is the läsår's own bound — the
 * one runsOn materialises a lesson to — so a week before the year starts or
 * after it ends is no week the school has, and is left out: every week kept
 * holds at least one of the year's dates. The stretch before the first event
 * inside the year is then read in the year's own first three weeks, where
 * every lesson open at its start already runs; an event before the year is
 * that stretch's, and one after it ends nothing the year holds.
 */
function weeksOf(lessons: readonly TeachingLesson[], year?: YearSpan): TeachingLesson[][] {
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
  if (year) {
    take(mondayOf(parseDay(year.startDate)));
  } else if (dates.length === 0) {
    for (const monday of UNDATED_WEEKS) mondays.set(monday.getTime(), monday);
  } else {
    take(addDays(mondayOf(parseDay(dates[0]!)), -21));
  }
  for (const lesson of lessons) {
    if (lesson.startDate) take(firstWeekFrom(lesson, parseDay(lesson.startDate)));
    // The first week it no longer runs in: its first own date after the end.
    if (lesson.endDate) take(firstWeekFrom(lesson, addDays(parseDay(lesson.endDate), 1)));
  }
  const first = year ? mondayOf(parseDay(year.startDate)).getTime() : -Infinity;
  const last = year ? parseDay(year.endDate).getTime() : Infinity;
  return [...mondays.values()]
    .filter((monday) => monday.getTime() >= first && monday.getTime() <= last)
    .map((monday) => lessons.filter((lesson) => runsInWeek(lesson, monday)));
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

/**
 * THE WEEKDAYS A TEACHER'S KEPT LESSONS HOLD TOGETHER, WEEK BY WEEK: what the
 * generator holds a post's days against (AnonymousTeacherDayLimit
 * .lockedWeekdays), each set ascending, the sets in a fixed order.
 *
 * `lessons` are the lessons the payload sends as fixed placements that the
 * teacher is on, as lead or medlärare; one that takes no time makes no day,
 * as everywhere here. For each set L the engine holds
 *
 *   Σ works[d] over the grid's days d not in L  ≤  max(0, N − |L|)
 *
 * — a lesson it places is a weekly lesson to it, so it adds a day to every
 * week whose kept lessons are not already on that weekday — and with one set
 * per real week, no week the generator leaves is over N unless its kept
 * lessons were over N alone. The union of every weekday any kept lesson
 * holds, which is what the engine read before this, is the lenient reading:
 * Monday and Tuesday in odd weeks and Wednesday and Thursday in even ones,
 * for a post of two days, left it no day to count, and a weekly lesson on
 * Monday and one on Wednesday gave every week three.
 *
 * A teacher with no kept lesson holds the empty set in every week, so the
 * answer is never empty: [[]], under which Σ works[d] ≤ N is the limit as it
 * reads without locks.
 *
 * ONLY THE SETS NO OTHER SET IMPLIES, and which those are depends on N. Let
 * L' be a week's set inside another week's L. When |L| ≤ N, L's constraint
 * implies L''s, since the days outside L' are those outside L and those of
 * L that L' lacks:
 *
 *   Σ_{d ∉ L'} works[d] = Σ_{d ∉ L} works[d] + Σ_{d ∈ L∖L'} works[d]
 *                       ≤ (N − |L|) + (|L| − |L'|) = N − |L'|,
 *
 * which is not negative, so the max(0, …) changes nothing; L' is left out.
 * When |L| > N, L's kept lessons are over the limit alone and its bound is 0,
 * and the same sum gives only |L ∖ L'|, which can be more than N − |L'|:
 * Monday to Wednesday in odd weeks and Monday alone in even ones, for a post
 * of two days, allows nothing off Monday to Wednesday under L, and a
 * Tuesday and a Wednesday fit that and give even weeks three days. So a set
 * is left out only when it lies inside a larger one of at most N weekdays —
 * every set it lies inside of more than N is not enough — and what is left
 * out is implied by what is kept: the largest set of at most N containing
 * it lies inside no larger one of at most N, so it is kept itself. Where no
 * week's kept lessons break the limit, which a hand edit is warned about
 * (master-lessons.service.ts), this is the maximal sets.
 *
 * ONLY THE LÄSÅR'S WEEKS, given `year`. A week before it starts or after it
 * ends runs the undated lessons and none of the dated, so its set lies inside
 * one of the year's — and where that larger set is over N it is not implied,
 * and would hold the generator to a week the school does not have: a post of
 * one day with an undated Monday and a Tuesday dated over the whole year
 * would give [1] beside [1, 2], and refuse a week whose every real week
 * already holds the two days its kept lessons hold. Without `year` the weeks
 * are read unbounded, as teacherDayBreaches reads them (where a week inside
 * another only ever repeats a smaller figure).
 */
export function lockedWeekdaySets(
  lessons: readonly TeachingLesson[],
  maxDaysPerWeek: number,
  year?: YearSpan,
): number[][] {
  const taking = lessons.filter((lesson) => lesson.endMinutes > lesson.startMinutes);
  const byKey = new Map<string, number[]>();
  for (const week of weeksOf(taking, year)) {
    const days = [...new Set(week.map((lesson) => lesson.dayOfWeek))].sort((a, b) => a - b);
    byKey.set(days.join(','), days);
  }
  const sets = [...byKey.values()];
  const implies = (larger: number[], set: number[]) =>
    larger.length > set.length && larger.length <= maxDaysPerWeek && set.every((day) => larger.includes(day));
  return sets.filter((set) => !sets.some((larger) => implies(larger, set))).sort(byWeekdays);
}

/** Weekday by weekday, a set before the sets it begins. */
function byWeekdays(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}
