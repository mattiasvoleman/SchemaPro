/**
 * ÄMNESFÖRDELNING: HOW ONE TIMPLANSPOST'S LESSONS SPREAD OVER THE WEEK.
 *
 * A school writes the rule on a subject — "idrott högst en gång per dag, inte
 * dagar i följd" — and may write another on one timplanspost. The generator
 * holds it as a hard rule (optimization-engine, _add_distribution_constraints).
 * A HAND edit that breaks it is allowed and warned about: the master-lessons
 * service puts the sentence in `warnings` beside the saved lesson, and the
 * subject and timplan dialogs list what the timetable already breaks. Those
 * two readers are in two codebases, so this module is the gateway's half and
 * web/lib/subject-distribution.ts the browser's, and both replay
 * __fixtures__/subject-distribution-cases.json so they cannot drift. The
 * engine's own checker, benchmarks/validate_schedule.py, replays the same
 * cases for the rule's arithmetic without sharing a line with either.
 *
 * TWO NUMBERS, BOTH ABOUT WEEKDAYS. `maxLessonsPerDay` caps the lessons on one
 * weekday; `minDaysBetween` keeps two weekdays that both hold a lesson that
 * many days apart (2 is "inte dagar i följd"). Independent: two lessons on one
 * Monday are one lesson day, and only the cap has anything to say about them.
 * Weekdays are ISO numbers and the week does not wrap — Friday and Monday are
 * four days apart.
 *
 * IN THE WEEKS A LESSON ACTUALLY RUNS, ISO week by ISO week, as publishing
 * puts it in the calendar and as Lärarens dag reads it: teacher-day.ts's
 * weeksOf, whose header proves that its weeks hold every set of lessons that
 * any week holds. A lesson runs in a week when it runs on its own weekday's
 * date of that week by calendar/lesson-recurrence.ts's runsOn — the week's
 * parity, and that date inside its window. A lesson every odd week and
 * another every even week, both on Monday, are one Monday lesson in any week
 * a school has, and a warning that counted two would be wrong for exactly the
 * A/B-week schools that lock such pairs by hand. Windows that share a date
 * are not enough to meet: two Monday lessons whose windows share only a
 * Friday never share a Monday, and an even-week lesson that ends in an odd
 * week never meets one that starts in that week. Nor are they needed: a
 * Monday lesson that ends on the Monday and a Tuesday lesson that starts on
 * the Tuesday share no date and are taught in one week, on days in a row.
 * The engine has no weeks at all and counts every locked lesson; its reading
 * is the stricter one, which is the safe direction for a generator and would
 * be the noisy one here.
 *
 * PURE. Dates are 'YYYY-MM-DD', read as the midnight UTC a @db.Date column
 * holds, which is what runsOn is asked about.
 */
import { weeksOf } from './teacher-day';

/** Bounds shared by the DTOs, the CHECKs (20261019090000) and the engine. */
export const MAX_LESSONS_PER_DAY_MIN = 1;
export const MAX_LESSONS_PER_DAY_MAX = 20;
export const MIN_DAYS_BETWEEN_MIN = 2;
export const MIN_DAYS_BETWEEN_MAX = 6;

export interface DistributionRule {
  maxLessonsPerDay: number | null;
  minDaysBetween: number | null;
}

export const NO_DISTRIBUTION_RULE: DistributionRule = {
  maxLessonsPerDay: null,
  minDaysBetween: null,
};

/**
 * The rule a timplanspost is held to: its own when `ownDistribution` is set —
 * where null in a column means no rule, as on the subject — else its subject's.
 */
export function effectiveDistribution(
  requirement: {
    ownDistribution?: boolean | null;
    maxLessonsPerDay?: number | null;
    minDaysBetween?: number | null;
  },
  subject: { maxLessonsPerDay?: number | null; minDaysBetween?: number | null } | null | undefined,
): DistributionRule {
  const source = requirement.ownDistribution ? requirement : subject;
  return {
    maxLessonsPerDay: source?.maxLessonsPerDay ?? null,
    minDaysBetween: source?.minDaysBetween ?? null,
  };
}

export function hasDistributionRule(rule: DistributionRule): boolean {
  return rule.maxLessonsPerDay !== null || rule.minDaysBetween !== null;
}

export interface DistributionLesson {
  id: string;
  dayOfWeek: number;
  recurrence?: 'ALL_WEEKS' | 'ODD_WEEKS' | 'EVEN_WEEKS' | null;
  startDate?: string | null;
  endDate?: string | null;
}

export type DistributionBreach =
  | {
      kind: 'PER_DAY';
      dayOfWeek: number;
      /** The most of them that run in one week. */
      count: number;
      maxLessonsPerDay: number;
      /** The weekday's lessons that run in a week over the cap, sorted. */
      lessonIds: string[];
    }
  | {
      kind: 'DAYS_APART';
      firstDay: number;
      secondDay: number;
      minDaysBetween: number;
      /** The two weekdays' lessons that run in a week holding both, sorted. */
      lessonIds: string[];
    };

/**
 * Every way one timplanspost's lessons break its rule, in weekday order: the
 * caps first, then the pairs of days.
 *
 * `lessons` are that post's lessons and nobody else's — the caller picks them
 * by (läsår, class, subject), the post's own key, and leaves out a parked
 * lesson, which occupies nothing.
 *
 * The lessons a breach names are those that run in a week over the rule, as
 * teacherDayBreaches names them (teacher-day.ts): a Monday lesson that runs
 * only in weeks under the cap is on the weekday and no part of the breach.
 *
 * `about`, when given, are the lessons a hand edit just wrote, and only the
 * weeks that hold one of them on the breach's own weekdays count — for the
 * cap, a week that holds one on that weekday; for a pair, a week that holds
 * one on either day — both for the figure and for the lessons named, as
 * teacherDayBreaches asks it: a breach says what the edit made, and a week
 * the edit is no part of — the spring's Mondays beside an autumn lesson, the
 * even weeks beside an odd-week one — is not its to repeat. A breach is then
 * always about one of them.
 */
export function distributionBreaches(
  rule: DistributionRule,
  lessons: readonly DistributionLesson[],
  about?: ReadonlySet<string>,
): DistributionBreach[] {
  const counted = (held: readonly DistributionLesson[]) =>
    about === undefined || held.some((lesson) => about.has(lesson.id));
  const breaches: DistributionBreach[] = [];
  const days = [...new Set(lessons.map((lesson) => lesson.dayOfWeek))].sort((a, b) => a - b);
  // Week by week, the lessons that run: every set any week holds.
  const weeks = weeksOf(lessons);

  const cap = rule.maxLessonsPerDay;
  if (cap !== null) {
    for (const day of days) {
      let most = 0;
      const over = new Set<string>();
      for (const week of weeks) {
        const onDay = week.filter((lesson) => lesson.dayOfWeek === day);
        if (!counted(onDay)) continue;
        most = Math.max(most, onDay.length);
        if (onDay.length > cap) for (const lesson of onDay) over.add(lesson.id);
      }
      if (most > cap) {
        breaches.push({
          kind: 'PER_DAY',
          dayOfWeek: day,
          count: most,
          maxLessonsPerDay: cap,
          lessonIds: [...over].sort(),
        });
      }
    }
  }

  const apart = rule.minDaysBetween;
  if (apart !== null) {
    for (let i = 0; i < days.length; i++) {
      for (let j = i + 1; j < days.length; j++) {
        const first = days[i]!;
        const second = days[j]!;
        if (second - first >= apart) continue;
        const over = new Set<string>();
        for (const week of weeks) {
          const onDays = week.filter((lesson) => lesson.dayOfWeek === first || lesson.dayOfWeek === second);
          if (!counted(onDays)) continue;
          const holdsBoth =
            onDays.some((lesson) => lesson.dayOfWeek === first) && onDays.some((lesson) => lesson.dayOfWeek === second);
          if (holdsBoth) for (const lesson of onDays) over.add(lesson.id);
        }
        if (over.size > 0) {
          breaches.push({
            kind: 'DAYS_APART',
            firstDay: first,
            secondDay: second,
            minDaysBetween: apart,
            lessonIds: [...over].sort(),
          });
        }
      }
    }
  }

  return breaches;
}

/** The sentence's code and values, as the engine catalogue names them. */
export interface DistributionWarning {
  code: 'DISTRIBUTION_TOO_MANY_ON_DAY' | 'DISTRIBUTION_DAYS_TOO_CLOSE';
  params: Record<string, string | number>;
}

/**
 * A breach as the warning a hand edit gets back. `requirement` is the post's
 * name as the Timplan page gives it ("Idrott för 7A"), never a person.
 */
export function distributionWarning(
  breach: DistributionBreach,
  requirement: string,
): DistributionWarning {
  if (breach.kind === 'PER_DAY') {
    return {
      code: 'DISTRIBUTION_TOO_MANY_ON_DAY',
      params: {
        requirement,
        day: breach.dayOfWeek,
        count: breach.count,
        maxPerDay: breach.maxLessonsPerDay,
      },
    };
  }
  return {
    code: 'DISTRIBUTION_DAYS_TOO_CLOSE',
    params: {
      requirement,
      firstDay: breach.firstDay,
      secondDay: breach.secondDay,
      minDaysBetween: breach.minDaysBetween,
    },
  };
}
