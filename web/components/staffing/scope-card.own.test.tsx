import { render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import type { ScopeCardData, TeacherScope } from "@/lib/assignment-scope";
import { ScopeCard } from "./scope-card";

/**
 * On the teacher's own page ("Min tjänst") the card talks to the teacher: "Din undervisningstid", "Förordningens högsta nivå för dig".
 * Every sentence of it must, and not only those two labels: a card that says "Din undervisningstid" over a sentence that says
 * "Var i spannet läraren ska ligga bedömer rektorn" is a text about the teacher handed to the teacher. The words are checked in the
 * catalogues as the reader gets them (the card's other tests echo keys). The drawer, which speaks about the teacher, keeps its words.
 *
 * And a teacher is never told that a figure is "shown only to someone who may see the size of the post": it is her own post, and
 * the reason a semestertjänst has no answer about the planning floor is the contract, nothing else.
 */
const base: TeacherScope = {
  userId: "t-anna",
  verdict: "INSIDE",
  notJudged: null,
  teachingHours: 645,
  stages: [{ gradeFrom: 1, gradeTo: 6, hours: 645, teachingHoursLow: 550, teachingHoursHigh: 650, planningFloorPercent: 100 }],
  unregulatedHours: 0,
  unknownGradeHours: 0,
  fullTimeHighestHours: 650,
  fullTimeLowestHours: 550,
  highestHours: 650,
  ordinanceHighestHours: 650,
  planningFloorHours: 645,
  remainingHours: 1122,
  planningFits: true,
};
const version = { code: "SFS2026:1487", sfs: "SFS 2026:1487", title: "x", validFrom: "2027-07-01", validTo: null, source: "https://example.invalid/sfs" };
const card = (teacher: Partial<TeacherScope>): ScopeCardData => ({ teacher: { ...base, ...teacher }, version, yearReason: null, interpretations: [] });

// The gateway's own shapes: a post-less teacher, a teacher in two stages, a semestertjänst, and (from the level a rektor sets) one over their own.
const cases: [string, ScopeCardData][] = [
  ["inside the span", card({})],
  ["with no post", card({ verdict: "NOT_JUDGED", notJudged: "NO_POST", highestHours: null, ordinanceHighestHours: null, remainingHours: null, planningFits: null })],
  [
    "in two stages",
    card({
      teachingHours: 860,
      stages: [
        { gradeFrom: 1, gradeTo: 6, hours: 645, teachingHoursLow: 550, teachingHoursHigh: 650, planningFloorPercent: 100 },
        { gradeFrom: 7, gradeTo: 9, hours: 215, teachingHoursLow: 500, teachingHoursHigh: 600, planningFloorPercent: 110 },
      ],
    }),
  ],
  ["on a semestertjänst", card({ remainingHours: null, planningFits: null })],
  ["over the level set for them", card({ verdict: "OVER_OWN", teachingHours: 600, highestHours: 580, ordinanceHighestHours: 650 })],
  // The sentence beside the floor row (planningFloorOnStages) is said only for hours outside the stages, and is no case above: without
  // these two nothing renders it in the real catalogues, so a "läraren" in it would reach the teacher's own page (granskningen av #400).
  ["with hours in förskoleklass, beside the planning floor", card({ teachingHours: 688, unregulatedHours: 43 })],
  ["with hours in groups with no årskurs, beside the planning floor", card({ teachingHours: 665, unknownGradeHours: 20 })],
];

describe.each([
  ["sv", sv, /lärare/i, /den som får se/],
  ["en", en, /teacher/i, /someone who may see/],
] as const)("the card on the teacher's own page (%s)", (locale, messages, third, mayBeSeen) => {
  const text = (data: ScopeCardData, own: boolean) => {
    const { container, unmount } = render(
      <NextIntlClientProvider locale={locale} messages={messages as never}>
        <ScopeCard data={data} own={own} />
      </NextIntlClientProvider>,
    );
    const words = container.textContent ?? "";
    unmount();
    return words;
  };

  it.each(cases)("speaks to the teacher in every sentence: %s", (_name, data) => {
    const words = text(data, true);
    expect(words).not.toMatch(third);
    expect(words).not.toMatch(mayBeSeen);
  });

  it("keeps the third person where it speaks about the teacher (the rektor's drawer)", () => {
    expect(text(cases[0]![1], false)).toMatch(third);
  });
});
