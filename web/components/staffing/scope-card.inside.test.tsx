import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import type { ScopeCardData, TeacherScope } from "@/lib/assignment-scope";
import { ScopeCard } from "./scope-card";

/**
 * INSIDE means NOT OVER (src/staffing/assignment-scope.ts): "som mest vara inom intervallet" (3 §) puts the teacher's own highest
 * level somewhere in the span and has no lower limit, so a teacher far below the span's lower edge is INSIDE too. The card's
 * words are checked in the catalogues as the reader gets them (the card's other tests echo keys): beside the row "Spannet vid
 * heltid 550-650 h" a teacher with 129 h must not be told they are "within the span".
 */
const below: TeacherScope = {
  userId: "t-anna",
  verdict: "INSIDE",
  notJudged: null,
  teachingHours: 129,
  stages: [{ gradeFrom: 1, gradeTo: 6, hours: 129, teachingHoursLow: 550, teachingHoursHigh: 650, planningFloorPercent: 100 }],
  unregulatedHours: 0,
  unknownGradeHours: 0,
  fullTimeHighestHours: 650,
  fullTimeLowestHours: 550,
  highestHours: 650,
  ordinanceHighestHours: 650,
  planningFloorHours: 129,
  remainingHours: 1500,
  planningFits: true,
};
const data: ScopeCardData = {
  teacher: below,
  version: { code: "SFS2026:1487", sfs: "SFS 2026:1487", title: "x", validFrom: "2027-07-01", validTo: null, source: "https://example.invalid/sfs" },
  yearReason: null,
  interpretations: [],
};

describe.each([
  ["sv", sv, /Inte över förordningens högsta nivå/, /Inom spannet/, /ingen lägsta undervisningstid/],
  ["en", en, /Not over the ordinance's highest level/, /Within the span/, /no lowest teaching time/],
] as const)("the card for a teacher far below the span (%s)", (locale, messages, notOver, within, noFloor) => {
  it("says the teacher is not over the highest level and that there is no lowest, not that they are within the span", () => {
    render(
      <NextIntlClientProvider locale={locale} messages={messages as never}>
        <ScopeCard data={data} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(notOver)).toBeInTheDocument();
    expect(screen.getByText(noFloor)).toBeInTheDocument();
    expect(screen.queryByText(within)).not.toBeInTheDocument();
  });
});
