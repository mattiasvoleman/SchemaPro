import fixture from './__fixtures__/subject-distribution-cases.json';
import {
  MAX_LESSONS_PER_DAY_MAX,
  MAX_LESSONS_PER_DAY_MIN,
  MIN_DAYS_BETWEEN_MAX,
  MIN_DAYS_BETWEEN_MIN,
  distributionBreaches,
  distributionWarning,
  effectiveDistribution,
  type DistributionLesson,
  type DistributionRule,
} from './subject-distribution';

/**
 * Ämnesfördelning, read three times, checked against one list of cases.
 *
 * This module decides what a hand edit is warned about; web/lib/
 * subject-distribution.ts decides what the subject and timplan dialogs say
 * the timetable already breaks; and the engine's independent checker,
 * benchmarks/validate_schedule.py, decides whether a generated week kept the
 * rule. If the first two drift, a dialog lists a breach the save never warned
 * about, or the reverse; if the checker drifts, the nightly gate passes a week
 * the warning would have flagged. None of them can see the others, so all three
 * replay src/common/__fixtures__/subject-distribution-cases.json.
 *
 * The fixture was GENERATED from this implementation (the script is in the
 * message of the commit that last changed it); never edit the JSON by hand.
 * The cases with dates and parities pin the ISO-week reading and the lessons
 * a breach names; the haystack they were picked from is
 * subject-distribution.spec.ts. No case asks about a lesson (`about`): only
 * the gateway's hand-edit warning does, and that spec covers it. The fixture's
 * constants are asserted here against the module, and the module's against
 * the DTOs and the CHECKs of 20261019090000 by their own specs.
 */

interface FixtureCase {
  name: string;
  rule: DistributionRule;
  lessons: DistributionLesson[];
  breaches: unknown[];
  warnings: unknown[];
}

const cases = fixture.cases as unknown as FixtureCase[];

describe('ämnesfördelning agrees with the shared fixture', () => {
  it('pins the bounds the engine, the CHECKs and the DTOs share', () => {
    expect(fixture.constants).toEqual({
      MAX_LESSONS_PER_DAY_MIN,
      MAX_LESSONS_PER_DAY_MAX,
      MIN_DAYS_BETWEEN_MIN,
      MIN_DAYS_BETWEEN_MAX,
    });
  });

  it('reaches both kinds of breach, both together, and none', () => {
    const kinds = cases.map((c) =>
      [...new Set((c.breaches as Array<{ kind: string }>).map((b) => b.kind))].sort().join('+'),
    );
    expect(new Set(kinds)).toEqual(new Set(['', 'PER_DAY', 'DAYS_APART', 'DAYS_APART+PER_DAY']));
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const breaches = distributionBreaches(c.rule, c.lessons);
    expect(breaches).toEqual(c.breaches);
    expect(breaches.map((breach) => distributionWarning(breach, 'Idrott för 7A'))).toEqual(c.warnings);
  });

  it.each(fixture.effective.map((c) => [c.name, c] as const))('effective rule: %s', (_name, c) => {
    expect(effectiveDistribution(c.requirement, c.subject)).toEqual(c.rule);
  });
});
