import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ScopeCardData, TeacherScope } from "@/lib/assignment-scope";
import { ScopeCard } from "./scope-card";

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}(${Object.values(values).join("|")})` : key),
}));

const base: TeacherScope = {
  userId: "t-anna",
  verdict: "OVER_MAX",
  notJudged: null,
  teachingHours: 731,
  stages: [{ gradeFrom: 1, gradeTo: 6, hours: 731, teachingHoursLow: 550, teachingHoursHigh: 650, planningFloorPercent: 100 }],
  unregulatedHours: 0,
  unknownGradeHours: 0,
  fullTimeHighestHours: 650,
  fullTimeLowestHours: 550,
  highestHours: 600,
  ordinanceHighestHours: 650,
  planningFloorHours: 731,
  remainingHours: null,
  planningFits: null,
  assessment: { levelHours: 600, exceptionKind: null, ownInitiativeOn: null, note: null, decidedAt: "2027-03-05T08:00:00.000Z" },
};
const data = (teacher: Partial<TeacherScope> = {}): ScopeCardData => ({
  teacher: { ...base, ...teacher },
  version: { code: "SFS2026:1487", sfs: "SFS 2026:1487", title: "x", validFrom: "2027-07-01", validTo: null, source: "https://example.invalid/sfs" },
  yearReason: null,
  interpretations: [],
});
const rows = () => screen.getAllByRole("term").map((term) => `${term.textContent}=${term.nextElementSibling?.textContent}`);

/*
 * A teacher over the ordinance's highest level whose rektor has also set a lower level of their own: the verdict is OVER_MAX, and "over by"
 * is the hours over the ORDINANCE's line (650), not over the rektor's level (600), which is a different amount and a different sentence.
 * The state exists as soon as a level can be set (R1 del G3); no test had a teacher in it.
 */
describe("ScopeCard: over the ordinance's level with a level set below it", () => {
  it("says the hours over the ordinance's line, and names that line and the rektor's level on rows of their own", () => {
    render(<ScopeCard data={data()} />);
    expect(screen.getByText("verdictOverMax(81)")).toHaveClass("text-destructive");
    expect(rows()).toEqual(expect.arrayContaining(["highest=hours(650)", "assessmentLevel=hours(600)"]));
  });

  it("says the same on the teacher's own page", () => {
    render(<ScopeCard data={data()} own />);
    expect(screen.getByText("verdictOverMax(81)")).toBeInTheDocument();
    expect(rows()).toEqual(expect.arrayContaining(["highestOwn=hours(650)", "assessmentLevelOwn=hours(600)"]));
  });
});
