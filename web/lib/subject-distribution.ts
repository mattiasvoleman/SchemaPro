/**
 * Ämnesfördelning, the browser's half: src/common/subject-distribution.ts
 * rewritten for the web, which cannot import the gateway's tree. Both replay
 * src/common/__fixtures__/subject-distribution-cases.json
 * (subject-distribution.contract.test.ts here), so the subject and timplan
 * dialogs list exactly the breaches a hand edit is warned about.
 *
 * Read the gateway module for the rule; what is said there holds here line
 * for line. In short: at most `maxLessonsPerDay` lessons of a timplanspost on
 * one weekday, and two weekdays that both hold one at least `minDaysBetween`
 * apart (2 is "inte dagar i följd"), counted in the ISO weeks the lessons
 * actually run, as publishing puts them in the calendar — an odd-week and an
 * even-week lesson on one Monday never meet, and windows that share a date
 * meet only if both lessons run in one week.
 *
 * The week reading is the gateway’s, written out here (weeksOf below):
 * teacher-day.ts’s weeksOf and calendar/lesson-recurrence.ts’s runsOn.
 *
 * PURE. Dates are "YYYY-MM-DD", read as midnight UTC as the gateway reads a
 * @db.Date.
 */

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
 * where null in a column means no rule, as on the subject — else its subject’s.
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
  recurrence?: "ALL_WEEKS" | "ODD_WEEKS" | "EVEN_WEEKS" | null;
  startDate?: string | null;
  endDate?: string | null;
}

export type DistributionBreach =
  | {
      kind: "PER_DAY";
      dayOfWeek: number;
      /** The most of them that run in one week. */
      count: number;
      maxLessonsPerDay: number;
      /** The weekday’s lessons that run in a week over the cap, sorted. */
      lessonIds: string[];
    }
  | {
      kind: "DAYS_APART";
      firstDay: number;
      secondDay: number;
      minDaysBetween: number;
      /** The two weekdays’ lessons that run in a week holding both, sorted. */
      lessonIds: string[];
    };

const DAY_MS = 24 * 60 * 60 * 1000;

/** "YYYY-MM-DD" as the midnight UTC the gateway reads it as, in milliseconds. */
const parseDay = (value: string): number => Date.parse(`${value}T00:00:00.000Z`);

/** The ISO weekday of a midnight UTC. */
const weekdayOf = (time: number): number => new Date(time).getUTCDay() || 7;

/** The Monday of the ISO week holding `time`. */
const mondayOf = (time: number): number => time - (weekdayOf(time) - 1) * DAY_MS;

/**
 * Whether the ISO week that starts on `monday` is odd. Its Thursday decides
 * the year it belongs to, and its number is one more than the whole weeks
 * from that year’s 1 January to the Thursday.
 */
function oddWeek(monday: number): boolean {
  const thursday = monday + 3 * DAY_MS;
  const newYear = Date.UTC(new Date(thursday).getUTCFullYear(), 0, 1);
  return Math.floor((thursday - newYear) / (7 * DAY_MS)) % 2 === 0;
}

/**
 * Whether the lesson runs in the week that starts on `monday`: the gateway’s
 * runsOn on the lesson’s own weekday’s date of that week.
 */
function runsInWeek(lesson: DistributionLesson, monday: number): boolean {
  const date = monday + (lesson.dayOfWeek - 1) * DAY_MS;
  if (lesson.startDate && date < parseDay(lesson.startDate)) return false;
  if (lesson.endDate && date > parseDay(lesson.endDate)) return false;
  const recurrence = lesson.recurrence ?? "ALL_WEEKS";
  return recurrence === "ALL_WEEKS" || (recurrence === "ODD_WEEKS") === oddWeek(monday);
}

/** The Monday of the week of the lesson’s first own date on or after `date`. */
const firstWeekFrom = (lesson: DistributionLesson, date: number): number =>
  mondayOf(date + ((lesson.dayOfWeek - weekdayOf(date) + 7) % 7) * DAY_MS);

/**
 * The lessons that run together, one set per week, in weeks enough that
 * every set any week holds is one of them: src/common/teacher-day.ts’s
 * weeksOf without a läsår, whose header proves it. Three weeks in a row from
 * three weeks before the earliest date, from the week each lesson comes in
 * and from the week it goes out — three, because week 53 and the week 1 after
 * it are both odd — or an odd and an even week when no lesson has a date.
 * The weeks it goes out change no breach (the gateway’s header says why, and
 * the oracle test cannot tell them missing); they are kept so that both
 * halves read the same weeks.
 */
function weeksOf(lessons: readonly DistributionLesson[]): DistributionLesson[][] {
  const mondays = new Set<number>();
  const take = (monday: number) => {
    for (let week = 0; week < 3; week++) mondays.add(monday + 7 * week * DAY_MS);
  };
  const dates = lessons
    .flatMap((lesson) => [lesson.startDate, lesson.endDate])
    .filter((date): date is string => !!date)
    .sort();
  if (dates.length === 0) {
    // 2024’s week 1, odd, and the week after it.
    mondays.add(parseDay("2024-01-01"));
    mondays.add(parseDay("2024-01-08"));
  } else {
    take(mondayOf(parseDay(dates[0]!)) - 21 * DAY_MS);
  }
  for (const lesson of lessons) {
    if (lesson.startDate) take(firstWeekFrom(lesson, parseDay(lesson.startDate)));
    if (lesson.endDate) take(firstWeekFrom(lesson, parseDay(lesson.endDate) + DAY_MS));
  }
  return [...mondays].map((monday) => lessons.filter((lesson) => runsInWeek(lesson, monday)));
}

/**
 * Every way one timplanspost’s lessons break its rule, in weekday order: the
 * caps first, then the pairs of days.
 *
 * `lessons` are that post’s lessons and nobody else’s — the caller picks them
 * by (läsår, class, subject), the post’s own key, and leaves out a parked
 * lesson, which occupies nothing. A breach names the lessons that run in a
 * week over the rule.
 *
 * The gateway’s takes an `about` as well, the lessons a hand edit wrote, so
 * that its warning counts only their weeks. A dialog lists every breach the
 * grundschema holds and asks about no lesson, so this half has none.
 */
export function distributionBreaches(
  rule: DistributionRule,
  lessons: readonly DistributionLesson[],
): DistributionBreach[] {
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
        most = Math.max(most, onDay.length);
        if (onDay.length > cap) for (const lesson of onDay) over.add(lesson.id);
      }
      if (most > cap) {
        breaches.push({
          kind: "PER_DAY",
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
          const holdsBoth =
            onDays.some((lesson) => lesson.dayOfWeek === first) && onDays.some((lesson) => lesson.dayOfWeek === second);
          if (holdsBoth) for (const lesson of onDays) over.add(lesson.id);
        }
        if (over.size > 0) {
          breaches.push({
            kind: "DAYS_APART",
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

/** The sentence’s code and values, as the engine catalogue names them. */
export interface DistributionWarning {
  code: "DISTRIBUTION_TOO_MANY_ON_DAY" | "DISTRIBUTION_DAYS_TOO_CLOSE";
  params: Record<string, string | number>;
}

/**
 * A breach as the warning a hand edit gets back. `requirement` is the post’s
 * name as the Timplan page gives it ("Idrott för 7A"), never a person.
 */
export function distributionWarning(
  breach: DistributionBreach,
  requirement: string,
): DistributionWarning {
  if (breach.kind === "PER_DAY") {
    return {
      code: "DISTRIBUTION_TOO_MANY_ON_DAY",
      params: {
        requirement,
        day: breach.dayOfWeek,
        count: breach.count,
        maxPerDay: breach.maxLessonsPerDay,
      },
    };
  }
  return {
    code: "DISTRIBUTION_DAYS_TOO_CLOSE",
    params: {
      requirement,
      firstDay: breach.firstDay,
      secondDay: breach.secondDay,
      minDaysBetween: breach.minDaysBetween,
    },
  };
}
