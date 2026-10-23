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
 *
 * The second walk asks about one lesson, as a hand edit does (`about`), in
 * weeks crowded enough that a weekday holds more in some weeks than in
 * others; the fixture has no such case, since the web and the engine never
 * ask about a lesson. The cases at the end name what it covers.
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

/**
 * The breaches as the module's header states them, read off every week: of
 * the weeks asked about, those over the rule, and the lessons they run.
 */
function oracle(
  rule: DistributionRule,
  lessons: readonly DistributionLesson[],
  about?: ReadonlySet<string>,
): DistributionBreach[] {
  const weeks = everyWeek(lessons);
  const days = [...new Set(lessons.map((lesson) => lesson.dayOfWeek))].sort((a, b) => a - b);
  const asked = (held: DistributionLesson[]) => about === undefined || held.some((lesson) => about.has(lesson.id));
  const holds = (held: DistributionLesson[], weekday: number) => held.some((lesson) => lesson.dayOfWeek === weekday);
  const ids = (held: DistributionLesson[][]) => [...new Set(held.flat().map((lesson) => lesson.id))].sort();
  const breaches: DistributionBreach[] = [];
  if (rule.maxLessonsPerDay !== null) {
    const cap = rule.maxLessonsPerDay;
    for (const weekday of days) {
      const onDay = weeks.map((week) => week.filter((lesson) => lesson.dayOfWeek === weekday)).filter(asked);
      const count = Math.max(0, ...onDay.map((held) => held.length));
      if (count > cap) {
        breaches.push({
          kind: 'PER_DAY',
          dayOfWeek: weekday,
          count,
          maxLessonsPerDay: cap,
          lessonIds: ids(onDay.filter((held) => held.length > cap)),
        });
      }
    }
  }
  if (rule.minDaysBetween !== null) {
    for (const first of days) {
      for (const second of days) {
        if (second <= first || second - first >= rule.minDaysBetween) continue;
        const both = weeks
          .map((week) => week.filter((lesson) => lesson.dayOfWeek === first || lesson.dayOfWeek === second))
          .filter(asked)
          .filter((held) => holds(held, first) && holds(held, second));
        if (both.length === 0) continue;
        breaches.push({
          kind: 'DAYS_APART',
          firstDay: first,
          secondDay: second,
          minDaysBetween: rule.minDaysBetween,
          lessonIds: ids(both),
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

/**
 * Up to six lessons, mostly on the first days of the week, so lessons share
 * one and sit side by side; `crowded`, up to nine on Monday to Wednesday, so
 * a weekday holds more in some weeks than in others.
 */
function drawCase(
  random: () => number,
  crowded = false,
): { rule: DistributionRule; lessons: DistributionLesson[] } {
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
  const lessons: DistributionLesson[] = [];
  const count = Math.floor(random() * (crowded ? 10 : 7));
  for (let index = 0; index < count; index++) {
    let startDate = random() < 0.5 ? pick(DATES) : null;
    let endDate = random() < 0.5 ? pick(DATES) : null;
    // Mostly a window that holds something; now and then one that cannot.
    if (startDate && endDate && endDate < startDate && random() < 0.8) [startDate, endDate] = [endDate, startDate];
    lessons.push({
      id: `l${index}`,
      dayOfWeek: pick(crowded ? [1, 1, 1, 2, 2, 3] : [1, 1, 2, 2, 3, 3, 4, 5, 6, 7]),
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

  it(`agrees on ${CASES} crowded cases asked about one lesson, and the edit's weeks decide many of them`, () => {
    const random = seeded(20261024);
    const disagreements: unknown[] = [];
    const reached = { asked: 0, aboutAnother: 0, silenced: 0, smaller: 0 };
    for (let index = 0; index < CASES; index++) {
      const { rule, lessons } = drawCase(random, true);
      if (lessons.length === 0) continue;
      const edited = lessons[Math.floor(random() * lessons.length)]!;
      const about = new Set([edited.id]);
      const expected = oracle(rule, lessons, about);
      const actual = distributionBreaches(rule, lessons, about);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        disagreements.push({ index, rule, lessons, about: edited.id, expected, actual });
      }
      reached.asked++;
      if (actual.some((breach) => !breach.lessonIds.includes(edited.id))) reached.aboutAnother++;
      // What the warning said before `about`: every breach on the lesson's
      // weekday, over every week, its figure the most of any week.
      const before = oracle(rule, lessons).filter((breach) =>
        breach.kind === 'PER_DAY'
          ? breach.dayOfWeek === edited.dayOfWeek
          : breach.firstDay === edited.dayOfWeek || breach.secondDay === edited.dayOfWeek,
      );
      const days = (breaches: DistributionBreach[]) =>
        breaches.map((breach) =>
          breach.kind === 'PER_DAY' ? `${breach.dayOfWeek}` : `${breach.firstDay}-${breach.secondDay}`,
        );
      if (days(before).join() !== days(expected).join()) reached.silenced++;
      const count = (breaches: DistributionBreach[]) => breaches.find((breach) => breach.kind === 'PER_DAY')?.count;
      if (count(expected) !== undefined && count(expected) !== count(before)) reached.smaller++;
    }
    expect(disagreements.slice(0, 3)).toEqual([]);
    // A breach asked about the lesson always takes it in.
    expect(reached.aboutAnother).toBe(0);
    // Breaches that only weeks without the lesson hold, and figures such a week set.
    expect(reached.silenced).toBeGreaterThan(reached.asked / 20);
    expect(reached.smaller).toBeGreaterThan(reached.asked / 200);
  }, 30_000);
});

/*
 * ABOUT THE LESSON AN EDIT WROTE: only the weeks that hold it on the
 * breach's own weekdays count, for the figure and for the lessons named —
 * the hand edit's warning (master-lessons.service.ts) says what the edit
 * made, not what another week already held.
 */
describe('distributionBreaches about the lesson an edit wrote', () => {
  const lesson = (id: string, dayOfWeek: number, extra: Partial<DistributionLesson> = {}): DistributionLesson => ({
    id,
    dayOfWeek,
    recurrence: 'ALL_WEEKS',
    startDate: null,
    endDate: null,
    ...extra,
  });
  const AUTUMN = { endDate: '2026-12-20' };
  const SPRING = { startDate: '2027-01-08' };

  it('an autumn Monday is told the autumn’s Mondays, not the spring’s three', () => {
    const week = [lesson('a', 1, AUTUMN), lesson('b', 1), lesson('c', 1, SPRING), lesson('d', 1, SPRING)];
    const rule = { maxLessonsPerDay: 1, minDaysBetween: null };
    expect(distributionBreaches(rule, week)).toEqual([
      { kind: 'PER_DAY', dayOfWeek: 1, count: 3, maxLessonsPerDay: 1, lessonIds: ['a', 'b', 'c', 'd'] },
    ]);
    expect(distributionBreaches(rule, week, new Set(['a']))).toEqual([
      { kind: 'PER_DAY', dayOfWeek: 1, count: 2, maxLessonsPerDay: 1, lessonIds: ['a', 'b'] },
    ]);
    // Under two a day the autumn holds, and only the spring is over.
    expect(distributionBreaches({ ...rule, maxLessonsPerDay: 2 }, week)).toEqual([
      { kind: 'PER_DAY', dayOfWeek: 1, count: 3, maxLessonsPerDay: 2, lessonIds: ['b', 'c', 'd'] },
    ]);
    expect(distributionBreaches({ ...rule, maxLessonsPerDay: 2 }, week, new Set(['a']))).toEqual([]);
  });

  it('an odd-week Monday is not told the even weeks’ two', () => {
    const week = [
      lesson('x', 1, { recurrence: 'ODD_WEEKS' }),
      lesson('e1', 1, { recurrence: 'EVEN_WEEKS' }),
      lesson('e2', 1, { recurrence: 'EVEN_WEEKS' }),
    ];
    const rule = { maxLessonsPerDay: 1, minDaysBetween: null };
    expect(distributionBreaches(rule, week)).toEqual([
      { kind: 'PER_DAY', dayOfWeek: 1, count: 2, maxLessonsPerDay: 1, lessonIds: ['e1', 'e2'] },
    ]);
    expect(distributionBreaches(rule, week, new Set(['x']))).toEqual([]);
    expect(distributionBreaches(rule, week, new Set(['e1']))).toEqual([
      { kind: 'PER_DAY', dayOfWeek: 1, count: 2, maxLessonsPerDay: 1, lessonIds: ['e1', 'e2'] },
    ]);
  });

  it('a pair of days is the weeks that hold the lesson on either of them', () => {
    // Monday every week and Tuesday in even weeks: the odd-week Monday never meets the Tuesday.
    const week = [
      lesson('x', 1, { recurrence: 'ODD_WEEKS' }),
      lesson('m', 1),
      lesson('t', 2, { recurrence: 'EVEN_WEEKS' }),
    ];
    const rule = { maxLessonsPerDay: null, minDaysBetween: 2 };
    expect(distributionBreaches(rule, week)).toEqual([
      { kind: 'DAYS_APART', firstDay: 1, secondDay: 2, minDaysBetween: 2, lessonIds: ['m', 't'] },
    ]);
    expect(distributionBreaches(rule, week, new Set(['x']))).toEqual([]);
    expect(distributionBreaches(rule, week, new Set(['t']))).toEqual([
      { kind: 'DAYS_APART', firstDay: 1, secondDay: 2, minDaysBetween: 2, lessonIds: ['m', 't'] },
    ]);
  });

  it('a weekday the lesson is not on is not its to repeat, though its weeks hold it', () => {
    const week = [lesson('m1', 1), lesson('m2', 1), lesson('x', 4)];
    expect(distributionBreaches({ maxLessonsPerDay: 1, minDaysBetween: 2 }, week, new Set(['x']))).toEqual([]);
  });

  it('a lesson that never runs is asked about no week', () => {
    // Odd weeks, dated inside one even week.
    const week = [
      lesson('x', 1, { recurrence: 'ODD_WEEKS', startDate: '2027-01-11', endDate: '2027-01-17' }),
      lesson('m', 1),
    ];
    expect(distributionBreaches({ maxLessonsPerDay: 1, minDaysBetween: null }, week, new Set(['x']))).toEqual([]);
  });
});
