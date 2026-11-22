import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ScopeCardData } from "@/lib/assignment-scope";
import { ScopeCard } from "./scope-card";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

/**
 * The card sits directly under Årsarbetstid in the drawer (and under it on a teacher's own page), and both say "undervisning per
 * läsår" in hours. They are two measures: the annual card's figure is the report's (a week counts whole when the year covers any
 * day of it, × the row's percentage and the subject's factor), this card's is the lessons' own time counted in school days. For a
 * läsår that starts on a Saturday (production's does) the two differ by up to a week of lessons, 665 h above 647.5 h for one
 * teacher. The card must say that they can differ, so that a school does not read two answers to one question.
 */
const data: ScopeCardData = {
  teacher: {
    userId: "t-anna",
    verdict: "INSIDE",
    notJudged: null,
    teachingHours: 647.5,
    stages: [{ gradeFrom: 1, gradeTo: 6, hours: 647.5, teachingHoursLow: 550, teachingHoursHigh: 650, planningFloorPercent: 100 }],
    unregulatedHours: 0,
    unknownGradeHours: 0,
    fullTimeHighestHours: 650,
    fullTimeLowestHours: 550,
    highestHours: 650,
    ordinanceHighestHours: 650,
    planningFloorHours: 647.5,
    remainingHours: 1119.5,
    planningFits: true,
  },
  version: { code: "SFS2026:1487", sfs: "SFS 2026:1487", title: "x", validFrom: "2027-07-01", validTo: null, source: "https://example.invalid/sfs" },
  yearReason: null,
  interpretations: [],
};

describe("ScopeCard beside the annual working time card", () => {
  it("says that its hours can differ from 'Undervisning per läsår' under Årsarbetstid", () => {
    render(<ScopeCard data={data} />);
    expect(screen.getByText("notAnnual")).toBeInTheDocument();
  });

  it("says it on a teacher's own page too, where the same two cards stand together", () => {
    render(<ScopeCard data={data} own headingLevel="h2" />);
    expect(screen.getByText("notAnnual")).toBeInTheDocument();
  });
});
