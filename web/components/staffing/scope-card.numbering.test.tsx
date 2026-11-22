import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import type { ScopeCardData, TeacherScope } from "@/lib/assignment-scope";
import { ScopeCard } from "./scope-card";

/**
 * A läsår the lydelse has no band for (a ten-year grundskola, every läsår from 2028-07-01): the gateway's own row for a teacher in
 * årskurs 5 has NO stages and ALL of the 645 h as unregulatedHours (buildScopeReport hands placeSpan no bands). The card says that
 * nothing is judged, and must not label those hours "Förskoleklass" on top of it. The row is the gateway's, as buildScopeReport
 * returned it for a 15-lesson week over 43 weeks in årskurs 5; the card's other tests use rows written by hand.
 */
const tenYear: TeacherScope = {
  userId: "t-anna",
  verdict: "NOT_JUDGED",
  notJudged: null,
  teachingHours: 645,
  stages: [],
  unregulatedHours: 645,
  unknownGradeHours: 0,
  fullTimeHighestHours: null,
  fullTimeLowestHours: null,
  highestHours: null,
  ordinanceHighestHours: null,
  planningFloorHours: null,
  remainingHours: null,
  planningFits: null,
};
const version = { code: "SFS2026:1487", sfs: "SFS 2026:1487", title: "x", validFrom: "2027-07-01", validTo: null, source: "https://example.invalid/sfs" };
const data = (teacher: TeacherScope, yearReason: ScopeCardData["yearReason"]): ScopeCardData => ({ teacher, version, yearReason, interpretations: [] });

describe.each([
  ["sv", sv, /tioårig grundskola/, /Förskoleklass/],
  ["en", en, /ten-year grundskola/, /Preschool class/],
] as const)("the card for a teacher in a ten-year grundskola (%s)", (locale, messages, why, preschool) => {
  const draw = (card: ScopeCardData, own = false) =>
    render(
      <NextIntlClientProvider locale={locale} messages={messages as never}>
        <ScopeCard data={card} own={own} />
      </NextIntlClientProvider>,
    );

  it("says why nothing is judged, shows the hours, and does not call them förskoleklass", () => {
    draw(data(tenYear, "NUMBERING_NOT_COVERED"), true);
    expect(screen.getByText(why)).toBeInTheDocument();
    expect(screen.queryByText(preschool)).not.toBeInTheDocument();
    // The hours once, as the teacher's own total.
    expect(screen.getAllByText("645 h")).toHaveLength(1);
  });

  it("still names förskoleklass where it is förskoleklass: a läsår the lydelse covers", () => {
    draw(data({ ...tenYear, verdict: "NOT_JUDGED", notJudged: "NO_STAGE", unregulatedHours: 300, teachingHours: 300 }, null));
    expect(screen.getAllByText(preschool).length).toBeGreaterThan(0);
  });
});
