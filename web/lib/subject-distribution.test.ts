import { describe, expect, it } from "vitest";
import { parityOf, runsOn } from "@/lib/candidates/week";
import { plusDays } from "@/lib/print-sheet";
import {
  distributionBreaches,
  type DistributionBreach,
  type DistributionLesson,
  type DistributionRule,
} from "@/lib/subject-distribution";

/*
 * The browser’s ämnesfördelning against a reader that walks every week: the
 * web half of src/common/subject-distribution.spec.ts, the same seed and the
 * same drawn cases.
 *
 * The module here writes the gateway’s week reading out in milliseconds;
 * the oracle walks every week in "YYYY-MM-DD" strings and asks the candidate
 * week sheet’s own reading (lib/candidates/week.ts: the ISO week’s parity,
 * then the window) about each lesson’s own weekday’s date. The dates sit
 * around the turn of 2026, a year of 53 weeks, whose week 53 and the week 1
 * after it are both odd — the weeks where a parity written out by hand goes
 * wrong first.
 */

/** 2026-12-07, the Monday of week 50, to 2027-01-31, the Sunday of week 4. */
const DATES = Array.from({ length: 56 }, (_, offset) => plusDays("2026-12-07", offset));
/** Weeks 41 of 2026 to 13 of 2027: both parities on either side of every date. */
const FIRST_MONDAY = "2026-10-05";
const LAST_MONDAY = "2027-03-29";

/** The lessons that run in each week, every week of the walk. */
function everyWeek(lessons: readonly DistributionLesson[]): DistributionLesson[][] {
  const weeks: DistributionLesson[][] = [];
  for (let monday = FIRST_MONDAY; monday <= LAST_MONDAY; monday = plusDays(monday, 7)) {
    const parity = parityOf(monday);
    weeks.push(
      lessons.filter((lesson) =>
        runsOn(
          { recurrence: lesson.recurrence ?? "ALL_WEEKS", startDate: lesson.startDate ?? null, endDate: lesson.endDate ?? null },
          plusDays(monday, lesson.dayOfWeek - 1),
          parity,
        ),
      ),
    );
  }
  return weeks;
}

/** The breaches as the gateway module’s header states them, read off every week. */
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
          kind: "PER_DAY",
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
          kind: "DAYS_APART",
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
      recurrence: pick(["ALL_WEEKS", "ALL_WEEKS", "ODD_WEEKS", "EVEN_WEEKS", null] as const),
      startDate,
      endDate,
    });
  }
  return {
    rule: { maxLessonsPerDay: pick([null, 1, 1, 2]), minDaysBetween: pick([null, 2, 2, 3, 4, 6]) },
    lessons,
  };
}

describe("distributionBreaches against a walk through every week", () => {
  const CASES = 4000;

  it(`agrees on ${CASES} drawn cases, and the dates and parities decide many of them`, () => {
    const random = seeded(20261023);
    const disagreements: unknown[] = [];
    let decidedByWeeks = 0;
    for (let index = 0; index < CASES; index++) {
      const { rule, lessons } = drawCase(random);
      const expected = oracle(rule, lessons);
      const actual = distributionBreaches(rule, lessons);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) disagreements.push({ index, rule, lessons, expected, actual });
      // The same lessons every week, with no dates: a case the weeks did not decide reads the same.
      const weekly = lessons.map((lesson) => ({ ...lesson, recurrence: "ALL_WEEKS" as const, startDate: null, endDate: null }));
      if (JSON.stringify(oracle(rule, weekly)) !== JSON.stringify(expected)) decidedByWeeks++;
    }
    expect(disagreements.slice(0, 3)).toEqual([]);
    expect(decidedByWeeks).toBeGreaterThan(CASES / 10);
    // About 1.5 s alone; a loaded runner must not turn that into a timeout.
  }, 30_000);
});
