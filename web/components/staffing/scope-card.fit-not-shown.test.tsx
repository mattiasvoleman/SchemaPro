import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ScopeCardData, TeacherScope } from "@/lib/assignment-scope";
import { ScopeCard } from "./scope-card";

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

/**
 * Whether the year's working time holds the planning floor is worked out for a full ferietjänst only (remainingHours, planningFits),
 * and the gateway leaves it out for a reader without HR-läs. A judged teacher with neither a "rymmer" nor a "rymmer inte" must
 * not leave a school guessing whether the floor fits: the card says that it is not shown, without saying which of the two reasons.
 */
const card = (overrides: Partial<TeacherScope>): ScopeCardData => ({
  teacher: {
    userId: "t-anna",
    verdict: "INSIDE",
    notJudged: null,
    teachingHours: 400,
    stages: [{ gradeFrom: 1, gradeTo: 6, hours: 400, teachingHoursLow: 550, teachingHoursHigh: 650, planningFloorPercent: 100 }],
    unregulatedHours: 0,
    unknownGradeHours: 0,
    fullTimeHighestHours: 650,
    fullTimeLowestHours: 550,
    highestHours: 650,
    ordinanceHighestHours: 650,
    planningFloorHours: 400,
    remainingHours: 1122,
    planningFits: true,
    ...overrides,
  },
  version: { code: "SFS2026:1487", sfs: "SFS 2026:1487", title: "x", validFrom: "2027-07-01", validTo: null, source: "https://example.invalid/sfs" },
  yearReason: null,
  interpretations: [],
});

describe("ScopeCard and whether the planning floor fits", () => {
  it("says it is not shown for a judged teacher with no answer (a semestertjänst, or a reader without HR-läs)", () => {
    render(<ScopeCard data={card({ remainingHours: null, planningFits: null })} />);
    expect(screen.getByText("fitsNotShown")).toBeInTheDocument();
  });

  it("says it only then: not beside an answer, and not for a teacher who is not judged at all", () => {
    render(<ScopeCard data={card({})} />);
    expect(screen.queryByText("fitsNotShown")).not.toBeInTheDocument();
    render(<ScopeCard data={card({ remainingHours: 300, planningFits: false })} />);
    expect(screen.queryByText("fitsNotShown")).not.toBeInTheDocument();
    render(<ScopeCard data={card({ verdict: "NOT_JUDGED", notJudged: "NO_POST", remainingHours: null, planningFits: null })} />);
    expect(screen.queryByText("fitsNotShown")).not.toBeInTheDocument();
  });
});
