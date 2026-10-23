import { runsOn } from '../calendar/lesson-recurrence';
import {
  distributionBreaches,
  type DistributionBreach,
  type DistributionLesson,
  type DistributionRule,
} from './subject-distribution';

/*
 * Ämnesfördelning against a reader that walks every week.
 *
 * distributionBreaches looks at a handful of weeks — teacher-day.ts's
 * weeksOf, whose header proves they hold every set of lessons any week
 * holds. The oracle here proves nothing and looks at every ISO week from
 * long before the earliest date a case can have to long after the latest,
 * asking calendar/lesson-recurrence.ts's runsOn about each lesson's own
 * weekday's date, which is how publishing puts the lesson in the calendar.
 *
 * The dates are drawn from the eight weeks around the turn of 2026, a year
 * of 53 weeks: windows end and start on any weekday, in weeks of either
 * parity, and across week 53 and the week 1 after it, which are both odd.
 * The fixture (subject-distribution-cases.json) names the cases a reader can
 * follow; this is the haystack they were picked from.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/** 2026-12-07, the Monday of week 50, to 2027-01-31, the Sunday of week 4. */
const DATES = Array.from({ length: 56 }, (_, offset) =>
  new Date(day('2026-12-07').getTime() + offset * DAY_MS).toISOString().slice(0, 10),
);
/** Weeks 41 of 2026 to 13 of 2027: both parities on either side of every date. */
const FIRST_MONDAY = day('2026-10-05').getTime();
const LAST_MONDAY = day('2027-03-29').getTime();

/** The lessons that run in each week, every week of the walk. */
function everyWeek(lessons: readonly DistributionLesson[]): DistributionLesson[][] {
  const weeks: DistributionLesson[][] = [];
  for (let monday = FIRST_MONDAY; monday <= LAST_MONDAY; monday += 7 * DAY_MS) {
    weeks.push(
      lessons.filter((lesson) =>
        runsOn(
          {
            recurrence: lesson.recurrence,
            startDate: lesson.startDate ? day(lesson.startDate) : null,
            endDate: lesson.endDate ? day(lesson.endDate) : null,
          },
          new Date(monday + (lesson.dayOfWeek - 1) * DAY_MS),
        ),
      ),
    );
  }
  return weeks;
}

/** The breaches as the module's header states them, read off every week. */
function oracle(rule: DistributionRule, lessons: readonly DistributionLesson[]): DistributionBreach[] {
  const weeks = everyWeek(lessons);
  const days = [...new Set(lessons.map((lesson) => lesson.dayOfWeek))].sort((a, b) => a - b);
  const on = (weekday: number) => lessons.filter((lesson) => lesson.dayOfWeek === weekday).map((lesson) => lesson.id);
  const holds = (week: DistributionLesson[], weekday: number) => week.some((lesson) => lesson.dayOfWeek === weekday);
  const breaches: DistributionBreach[] = [];
  if (rule.maxLessonsPerDay !== null) {
    for (const weekday of days) {
      const count = Math.max(...weeks.map((week) => week.filter((lesson) => lesson.dayOfWeek === weekday).length));
      if (count > rule.maxLessonsPerDay) {
        breaches.push({
          kind: 'PER_DAY',
          dayOfWeek: weekday,
          count,
          maxLessonsPerDay: rule.maxLessonsPerDay,
          lessonIds: on(weekday).sort(),
        });
      }
    }
  }
  if (rule.minDaysBetween !== null) {
    for (const first of days) {
      for (const second of days) {
        if (second <= first || second - first >= rule.minDaysBetween) continue;
        if (!weeks.some((week) => holds(week, first) && holds(week, second))) continue;
        breaches.push({
          kind: 'DAYS_APART',
          firstDay: first,
          secondDay: second,
          minDaysBetween: rule.minDaysBetween,
          lessonIds: [...on(first), ...on(second)].sort(),
        });
      }
    }
  }
  return breaches;
}

/** mulberry32: the same cases on every run, so a failure can be replayed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawCase(random: () => number): { rule: DistributionRule; lessons: DistributionLesson[] } {
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
  const lessons: DistributionLesson[] = [];
  const count = Math.floor(random() * 7);
  for (let index = 0; index < count; index++) {
    let startDate = random() < 0.5 ? pick(DATES) : null;
    let endDate = random() < 0.5 ? pick(DATES) : null;
    // Mostly a window that holds something; now and then one that cannot.
    if (startDate && endDate && endDate < startDate && random() < 0.8) [startDate, endDate] = [endDate, startDate];
    lessons.push({
      id: `l${index}`,
      // Mostly the first days of the week, so lessons share one and sit side by side.
      dayOfWeek: pick([1, 1, 2, 2, 3, 3, 4, 5, 6, 7]),
      recurrence: pick(['ALL_WEEKS', 'ALL_WEEKS', 'ODD_WEEKS', 'EVEN_WEEKS', null] as const),
      startDate,
      endDate,
    });
  }
  return {
    rule: { maxLessonsPerDay: pick([null, 1, 1, 2]), minDaysBetween: pick([null, 2, 2, 3, 4, 6]) },
    lessons,
  };
}

describe('distributionBreaches against a walk through every week', () => {
  const CASES = 4000;

  it(`agrees on ${CASES} drawn cases, and the dates and parities decide many of them`, () => {
    const random = seeded(20261023);
    const disagreements: unknown[] = [];
    const reached = { PER_DAY: 0, DAYS_APART: 0, none: 0, decidedByWeeks: 0 };
    for (let index = 0; index < CASES; index++) {
      const { rule, lessons } = drawCase(random);
      const expected = oracle(rule, lessons);
      const actual = distributionBreaches(rule, lessons);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) disagreements.push({ index, rule, lessons, expected, actual });
      if (expected.length === 0) reached.none++;
      if (expected.some((breach) => breach.kind === 'PER_DAY')) reached.PER_DAY++;
      if (expected.some((breach) => breach.kind === 'DAYS_APART')) reached.DAYS_APART++;
      // The same lessons every week, with no dates: a case the weeks did not decide reads the same.
      const weekly = lessons.map((lesson) => ({ ...lesson, recurrence: 'ALL_WEEKS' as const, startDate: null, endDate: null }));
      if (JSON.stringify(oracle(rule, weekly)) !== JSON.stringify(expected)) reached.decidedByWeeks++;
    }
    expect(disagreements.slice(0, 3)).toEqual([]);
    expect(reached.none).toBeGreaterThan(CASES / 10);
    expect(reached.PER_DAY).toBeGreaterThan(CASES / 10);
    expect(reached.DAYS_APART).toBeGreaterThan(CASES / 10);
    expect(reached.decidedByWeeks).toBeGreaterThan(CASES / 10);
    // About 1.5 s alone; a loaded runner must not turn that into a timeout.
  }, 30_000);
});
