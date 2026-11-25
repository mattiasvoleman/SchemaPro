import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScopeCardData, TeacherScope } from "@/lib/assignment-scope";
import { ScopeCard } from "./scope-card";

const locale = vi.hoisted(() => ({ current: "sv" as "sv" | "en" }));
vi.mock("next-intl", () => ({
  useLocale: () => locale.current,
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

afterEach(() => {
  cleanup();
  locale.current = "sv";
});

/*
 * HOW FAR OVER THE RECTOR'S OWN LEVEL, in the reader's language (the review of #451: the figure of the OVER_OWN sentence is one of the card's
 * calls of `figure`, on the page of the rektor's drawer and on the teacher's own page, and a figure with no decimal and no thousands reads the same in
 * both languages, so a test that uses 45 cannot tell the call from `String(over)`).
 */
const teacher = (overrides: Partial<TeacherScope>): TeacherScope => ({
  userId: "t-anna",
  verdict: "OVER_OWN",
  notJudged: null,
  teachingHours: 645.8,
  stages: [{ gradeFrom: 1, gradeTo: 6, hours: 645.8, teachingHoursLow: 550, teachingHoursHigh: 650, planningFloorPercent: 100 }],
  unregulatedHours: 0,
  unknownGradeHours: 0,
  fullTimeHighestHours: 650,
  fullTimeLowestHours: 550,
  highestHours: 600.5,
  ordinanceHighestHours: 650,
  planningFloorHours: 645.8,
  remainingHours: 900,
  planningFits: true,
  ...overrides,
});
const data = (overrides: Partial<TeacherScope> = {}): ScopeCardData => ({
  teacher: teacher(overrides),
  version: { code: "SFS2026:1487", sfs: "SFS 2026:1487", title: "x", validFrom: "2027-07-01", validTo: null, source: "https://example.invalid/sfs" },
  yearReason: null,
  interpretations: [],
});

describe.each([
  ["in the rektor's drawer", false, "verdictOverOwn"],
  ["on the teacher's own page", true, "own.verdictOverOwn"],
] as const)("the amount over the rektor's own level %s", (_where, own, key) => {
  it("is written with the Swedish comma in Swedish", () => {
    render(<ScopeCard data={data()} own={own} />);
    expect(screen.getByText(`${key}(45,3)`)).toBeInTheDocument();
  });

  it("is written with a point in English", () => {
    locale.current = "en";
    render(<ScopeCard data={data()} own={own} />);
    expect(screen.getByText(`${key}(45.3)`)).toBeInTheDocument();
  });

  it("is grouped as English groups thousands, and written whole as Swedish writes them", () => {
    render(<ScopeCard data={data({ teachingHours: 1750.5, highestHours: 600.5, stages: [] })} own={own} />);
    expect(screen.getByText(`${key}(1150)`)).toBeInTheDocument();
    cleanup();
    locale.current = "en";
    render(<ScopeCard data={data({ teachingHours: 1750.5, highestHours: 600.5, stages: [] })} own={own} />);
    expect(screen.getByText(`${key}(1,150)`)).toBeInTheDocument();
  });
});
