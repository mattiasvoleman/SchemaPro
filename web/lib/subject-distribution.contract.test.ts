import { describe, expect, it } from "vitest";
import fixture from "../../src/common/__fixtures__/subject-distribution-cases.json";
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
} from "@/lib/subject-distribution";

/**
 * Ämnesfördelning, the web half of src/common/subject-distribution.contract
 * .spec.ts.
 *
 * The subject and timplan dialogs list what the grundschema already breaks
 * with this module; a hand edit is warned about by the gateway's. If the two
 * drift, a dialog lists a breach no save ever warned about, or stays silent
 * about one that did. The fixture was generated from the GATEWAY copy, so this
 * proves the browser arrives at the same breaches, the same warnings and the
 * same effective rule.
 */

interface FixtureCase {
  name: string;
  rule: DistributionRule;
  lessons: DistributionLesson[];
  breaches: unknown[];
  warnings: unknown[];
}

const cases = fixture.cases as unknown as FixtureCase[];

describe("ämnesfördelning agrees with the gateway's fixture", () => {
  it("pins the same bounds", () => {
    expect(fixture.constants).toEqual({
      MAX_LESSONS_PER_DAY_MIN,
      MAX_LESSONS_PER_DAY_MAX,
      MIN_DAYS_BETWEEN_MIN,
      MIN_DAYS_BETWEEN_MAX,
    });
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const breaches = distributionBreaches(c.rule, c.lessons);
    expect(breaches).toEqual(c.breaches);
    expect(breaches.map((breach) => distributionWarning(breach, "Idrott för 7A"))).toEqual(c.warnings);
  });

  it.each(fixture.effective.map((c) => [c.name, c] as const))("effective rule: %s", (_name, c) => {
    expect(effectiveDistribution(c.requirement, c.subject)).toEqual(c.rule);
  });
});
