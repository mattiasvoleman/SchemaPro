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
 * IN THE WEEKS A LESSON ACTUALLY RUNS. A lesson every odd week and another
 * every even week, both on Monday, are one Monday lesson in any week a school
 * has, and a warning that counted two would be wrong for exactly the A/B-week
 * schools that lock such pairs by hand. So two lessons count together only
 * when they can meet in one week: their parities allow it (ALL with either,
 * ODD with ODD, EVEN with EVEN) and their date windows overlap — the same
 * reading as the clash check's weeksCanOverlap. The engine has no weeks at
 * all and counts every locked lesson; its reading is the stricter one, which
 * is the safe direction for a generator and would be the noisy one here.
 *
 * PURE. Dates are 'YYYY-MM-DD', which compare as strings.
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
      /** The most of them that meet in one week. */
      count: number;
      maxLessonsPerDay: number;
      /** Every lesson on that weekday, sorted. */
      lessonIds: string[];
    }
  | {
      kind: 'DAYS_APART';
      firstDay: number;
      secondDay: number;
      minDaysBetween: number;
      /** Every lesson on either weekday, sorted. */
      lessonIds: string[];
    };

/** Whether two lessons can run in the same week. Absent recurrence is ALL_WEEKS. */
export function canMeet(a: DistributionLesson, b: DistributionLesson): boolean {
  const first = a.recurrence ?? 'ALL_WEEKS';
  const second = b.recurrence ?? 'ALL_WEEKS';
  if (first !== 'ALL_WEEKS' && second !== 'ALL_WEEKS' && first !== second) return false;
  if (a.endDate && b.startDate && a.endDate < b.startDate) return false;
  if (b.endDate && a.startDate && b.endDate < a.startDate) return false;
  return true;
}

/**
 * The most of these lessons that run in one week.
 *
 * Per parity, then per date: lessons of one parity (ALL counts in both) whose
 * windows pairwise overlap share a date — intervals on a line do — so the
 * answer is the most windows that hold one start date, tried at every start.
 */
function mostInOneWeek(lessons: DistributionLesson[]): number {
  let best = 0;
  for (const parity of ['ODD_WEEKS', 'EVEN_WEEKS'] as const) {
    const running = lessons.filter((lesson) => {
      const recurrence = lesson.recurrence ?? 'ALL_WEEKS';
      return recurrence === 'ALL_WEEKS' || recurrence === parity;
    });
    // An open start is the first date there is, which no string undercuts.
    const starts = running.map((lesson) => lesson.startDate ?? '');
    for (const date of starts) {
      const holding = running.filter(
        (lesson) =>
          (lesson.startDate ?? '') <= date && (lesson.endDate == null || lesson.endDate >= date),
      ).length;
      best = Math.max(best, holding);
    }
  }
  return best;
}

/**
 * Every way one timplanspost's lessons break its rule, in weekday order: the
 * caps first, then the pairs of days.
 *
 * `lessons` are that post's lessons and nobody else's — the caller picks them
 * by (läsår, class, subject), the post's own key, and leaves out a parked
 * lesson, which occupies nothing.
 */
export function distributionBreaches(
  rule: DistributionRule,
  lessons: readonly DistributionLesson[],
): DistributionBreach[] {
  const breaches: DistributionBreach[] = [];
  const byDay = new Map<number, DistributionLesson[]>();
  for (const lesson of lessons) {
    const onDay = byDay.get(lesson.dayOfWeek);
    if (onDay) onDay.push(lesson);
    else byDay.set(lesson.dayOfWeek, [lesson]);
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  const idsOf = (rows: DistributionLesson[]): string[] => rows.map((row) => row.id).sort();

  if (rule.maxLessonsPerDay !== null) {
    for (const day of days) {
      const onDay = byDay.get(day)!;
      const count = mostInOneWeek(onDay);
      if (count > rule.maxLessonsPerDay) {
        breaches.push({
          kind: 'PER_DAY',
          dayOfWeek: day,
          count,
          maxLessonsPerDay: rule.maxLessonsPerDay,
          lessonIds: idsOf(onDay),
        });
      }
    }
  }

  if (rule.minDaysBetween !== null) {
    for (let i = 0; i < days.length; i++) {
      for (let j = i + 1; j < days.length; j++) {
        const first = days[i]!;
        const second = days[j]!;
        if (second - first >= rule.minDaysBetween) continue;
        const firstLessons = byDay.get(first)!;
        const secondLessons = byDay.get(second)!;
        const meet = firstLessons.some((a) => secondLessons.some((b) => canMeet(a, b)));
        if (!meet) continue;
        breaches.push({
          kind: 'DAYS_APART',
          firstDay: first,
          secondDay: second,
          minDaysBetween: rule.minDaysBetween,
          lessonIds: idsOf([...firstLessons, ...secondLessons]),
        });
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
