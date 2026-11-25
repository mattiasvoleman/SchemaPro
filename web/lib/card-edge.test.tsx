import { cleanup, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it } from "vitest";
import { cardsOf } from "../e2e/card-edge";
import { ScopeCard } from "@/components/staffing/scope-card";
import { SectionCard } from "@/components/ui/section-card";
import type { ScopeCardData } from "@/lib/assignment-scope";
import sv from "@/messages/sv.json";

afterEach(cleanup);

/*
 * The measure the 320 px gates of e2e/staffing-scope.a11y.spec.ts take of a card measures the card, and not its heading. jsdom has no layout, so
 * nothing reaches past an edge here; what is asked is what the measure COVERS: the heading, the rows, the sentences and the link of the real card.
 */
const data: ScopeCardData = {
  teacher: {
    userId: "t-anna",
    verdict: "OVER_MAX",
    notJudged: null,
    teachingHours: 731,
    stages: [{ gradeFrom: 1, gradeTo: 6, hours: 731, teachingHoursLow: 550, teachingHoursHigh: 650, planningFloorPercent: 100 }],
    unregulatedHours: 0,
    unknownGradeHours: 0,
    fullTimeHighestHours: 650,
    fullTimeLowestHours: 550,
    highestHours: 650,
    ordinanceHighestHours: 650,
    planningFloorHours: 731,
    remainingHours: 900,
    planningFits: true,
  },
  yearReason: null,
  interpretations: [],
  version: { code: "SFS2026:1487", sfs: "SFS 2026:1487", title: "x", validFrom: "2027-07-01", validTo: null, source: "https://example.invalid/sfs" },
};

describe("cardsOf", () => {
  it("measures the whole card: its rows and its link as well as its heading, at the level the page gives it", () => {
    const { container } = render(
      <NextIntlClientProvider locale="sv" messages={sv as never}>
        <ScopeCard data={data} />
      </NextIntlClientProvider>,
    );
    const whole = container.querySelectorAll("#scope-card, #scope-card *").length;
    const seen = cardsOf(["Omfattning enligt förordningen"]);
    expect(seen.cards).toBe(1);
    // The elements of the card, less what only a screen reader reads: all but the sr-only words.
    expect(seen.measured).toBeGreaterThan(20);
    expect(seen.measured).toBeLessThanOrEqual(whole);
    expect(seen.beyond).toBe(0);
  });

  it("counts the section and everything under it: the heading's row, the heading and each paragraph, not the heading alone", () => {
    render(
      <SectionCard id="x" title="Kort" headingLevel={2}>
        <p>en</p>
        <p>två</p>
      </SectionCard>,
    );
    const seen = cardsOf(["Kort"]);
    expect(seen.cards).toBe(1);
    // section, the header row, its text block, the heading, and the two paragraphs.
    expect(seen.measured).toBe(6);
  });

  it("finds no card for a title that is not on the page, and says so", () => {
    render(<SectionCard id="x" title="Kort" headingLevel={2} />);
    expect(cardsOf(["Ett annat kort"])).toEqual({ cards: 0, measured: 0, beyond: 0 });
  });
});
