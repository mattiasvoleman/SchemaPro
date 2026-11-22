import { render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { hoursOver, type ScopeCardData, type TeacherScope } from "@/lib/assignment-scope";
import { ScopeCard } from "./scope-card";

/**
 * OVER_MAX is judged on the hours in a stage (T7), so "over by" is the stage hours over the line, never the total: a teacher with
 * 358,3 h in årskurs 1-6 against an edge of 357,5 h is 0,8 h over, and the 258 h of förskoleklass that are counted beside them are
 * the very hours the card says the ordinance gives no level for. The card used to say 259,3 h, which is what the rektor would
 * then try to take away, and the förskoleklass lessons are not what is over.
 */
const base: TeacherScope = {
  userId: "t-anna",
  verdict: "OVER_MAX",
  notJudged: null,
  teachingHours: 616.3,
  stages: [{ gradeFrom: 1, gradeTo: 6, hours: 358.3, teachingHoursLow: 550, teachingHoursHigh: 650, planningFloorPercent: 100 }],
  unregulatedHours: 258,
  unknownGradeHours: 0,
  fullTimeHighestHours: 650,
  fullTimeLowestHours: 550,
  highestHours: 357.5,
  ordinanceHighestHours: 357.5,
  planningFloorHours: 358.3,
  remainingHours: 1000,
  planningFits: true,
};
const version = { code: "SFS2026:1487", sfs: "SFS 2026:1487", title: "x", validFrom: "2027-07-01", validTo: null, source: "https://example.invalid/sfs" };
const card = (teacher: Partial<TeacherScope>): ScopeCardData => ({ teacher: { ...base, ...teacher }, version, yearReason: null, interpretations: [] });

describe("how far over the ordinance's highest level", () => {
  it("counts the hours in the stages only, whatever is taught outside them", () => {
    expect(hoursOver(base)).toBe(0.8);
    expect(hoursOver({ ...base, teachingHours: 360.5, unregulatedHours: 0, unknownGradeHours: 2.2 })).toBe(0.8);
  });

  it("is the whole total over the rektor's own level, which the gateway judges on the total", () => {
    expect(hoursOver({ ...base, verdict: "OVER_OWN", highestHours: 600, ordinanceHighestHours: 650, teachingHours: 688 })).toBe(88);
  });

  it("is never less than a tenth: three rounded figures can add up to the line while the gateway's unrounded stage hours do not", () => {
    expect(hoursOver({ ...base, teachingHours: 357.5, unregulatedHours: 0 })).toBe(0.1);
  });

  it("is still null where the reader may not see the line", () => {
    expect(hoursOver({ ...base, ordinanceHighestHours: null, highestHours: null })).toBeNull();
  });

  it.each([
    ["sv", sv, "Över förordningens högsta nivå med 0,8 h (3 §)."],
    ["en", en, "Over the ordinance's highest level by 0,8 h (§ 3)."],
  ] as const)("is the sentence the card opens with (%s)", (locale, messages, sentence) => {
    const { container } = render(
      <NextIntlClientProvider locale={locale} messages={messages as never}>
        <ScopeCard data={card({})} />
      </NextIntlClientProvider>,
    );
    expect(container.querySelector("p")?.textContent).toBe(sentence);
  });
});
