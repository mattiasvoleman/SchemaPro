import { render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import type { ScopeCardData, TeacherScope } from "@/lib/assignment-scope";
import { ScopeCard } from "./scope-card";

/**
 * The cause for hours outside the stages (T7), as the reader gets it in the real catalogues: the card's other tests echo keys,
 * so no test saw that the two places the cause is said (the sentence that is the answer, and the line beneath an OVER_OWN) speak to the
 * teacher on her own page and about her in the drawer, in both languages.
 */
const flagged: TeacherScope = {
  userId: "t-anna",
  verdict: "INSIDE",
  notJudged: null,
  teachingHours: 688,
  stages: [{ gradeFrom: 1, gradeTo: 6, hours: 645, teachingHoursLow: 550, teachingHoursHigh: 650, planningFloorPercent: 100 }],
  unregulatedHours: 43,
  unknownGradeHours: 0,
  fullTimeHighestHours: 650,
  fullTimeLowestHours: 550,
  highestHours: 650,
  ordinanceHighestHours: 650,
  planningFloorHours: 645,
  remainingHours: 1000,
  planningFits: true,
  overOnlyWithUnregulated: true,
};
const version = { code: "SFS2026:1487", sfs: "SFS 2026:1487", title: "x", validFrom: "2027-07-01", validTo: null, source: "https://example.invalid/sfs" };
const card = (teacher: Partial<TeacherScope>): ScopeCardData => ({ teacher: { ...flagged, ...teacher }, version, yearReason: null, interpretations: [] });

const paragraphs = (locale: "sv" | "en", data: ScopeCardData, own: boolean) => {
  const { container, unmount } = render(
    <NextIntlClientProvider locale={locale} messages={(locale === "sv" ? sv : en) as never}>
      <ScopeCard data={data} own={own} />
    </NextIntlClientProvider>,
  );
  const found = Array.from(container.querySelectorAll("p")).map((p) => p.textContent ?? "");
  unmount();
  return found;
};

describe.each([
  ["sv", /räknas inte som över/, /^Över förordningens högsta nivå först när/, /\bdu räknas\b/, /\bläraren räknas\b/],
  ["en", /not counted as over/, /^Over the ordinance's highest level only when/, /\byou are not counted\b/, /\bthe teacher is not counted\b/],
] as const)("the cause on the card (%s)", (locale, notOver, opens, toHer, aboutHer) => {
  it("is the sentence the card opens with, to the teacher on her own page and about her in the drawer", () => {
    const mine = paragraphs(locale, card({}), true);
    expect(mine[0]).toMatch(opens);
    expect(mine[0]).toMatch(notOver);
    expect(mine[0]).toMatch(toHer);
    const hers = paragraphs(locale, card({}), false);
    expect(hers[0]).toMatch(aboutHer);
  });

  it("is said beneath the first sentence when the teacher is over the level the rektor set, to her on her own page too", () => {
    const own = paragraphs(locale, card({ verdict: "OVER_OWN", highestHours: 600 }), true);
    expect(own.filter((text) => notOver.test(text))).toHaveLength(1);
    expect(own.find((text) => notOver.test(text))).toMatch(toHer);
    const drawer = paragraphs(locale, card({ verdict: "OVER_OWN", highestHours: 600 }), false);
    expect(drawer.find((text) => notOver.test(text))).toMatch(aboutHer);
  });
});
