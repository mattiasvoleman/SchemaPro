import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MyStaffingPage from "./page";

/**
 * The omfattning card is a lazy chunk (the page is core tier). A chunk that does not arrive (a flaky network, a tab left open across
 * a deploy) must leave the tjänst as it was: the card is optional, and a rejected lazy() import is thrown at render, where nothing
 * under this page catches it. The student's, the guardian's and the timplan page say the same about their optional cards.
 */
const ME = "t-me";

/** How many times the page asked for the chunk: the card is lazy, so "it did not arrive" can only be asserted after it was asked for. */
const asked = vi.hoisted(() => ({ times: 0 }));

vi.mock("@/components/profile-context", () => ({ useProfile: () => ({ profile: { id: "t-me", role: "TEACHER" } }) }));
vi.mock("@/lib/queries", () => ({
  useActiveYear: () => ({ data: [], activeYear: { id: "y-1", name: "2027/28", isActive: true, predecessorId: null }, isLoading: false }),
  useSubjects: () => ({ data: [] }),
  useGroups: () => ({ data: [] }),
}));
vi.mock("@/lib/staffing-queries", () => ({
  useStaffingLoad: () => ({
    isLoading: false,
    isError: false,
    data: {
      teachers: [
        {
          userId: ME,
          employment: { userId: ME, employmentPercent: 100, reductionPercent: 0, contractKind: "FERIE", teachingTargetMinutesPerWeek: null, signature: null },
          targetMinutesPerWeek: 1080,
          countedMinutesPerWeek: 960,
          status: "UNDER",
          subjects: [],
          annual: { assignedHoursPerYear: 573.5, regulatedHoursPerYear: 1360, workDaysPerYear: 194, contractKind: "FERIE", annualHours: 1767, unregulatedHoursPerYear: 407, semesterHoursPerWeek: null, dutyHoursPerYear: 76, teachingWeeksPerYear: 38, percentOfRegulated: 42.2 },
        },
      ],
      scope: {
        version: { code: "SFS2026:1487", sfs: "SFS 2026:1487", title: "Förordning", validFrom: "2027-07-01", validTo: null, source: "https://example.invalid/sfs" },
        yearReason: null,
        interpretations: [],
        teachers: [
          {
            userId: ME,
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
          },
        ],
      },
    },
  }),
  useTeacherDuties: () => ({ data: [], isLoading: false, isError: false }),
}));
vi.mock("@/i18n/navigation", () => ({ Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a> }));
vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));
// The card's chunk never arrives.
vi.mock("@/components/staffing/scope-card", () => {
  asked.times += 1;
  throw new Error("Failed to fetch dynamically imported module: /_next/static/chunks/scope-card.js");
});

describe("Min tjänst when the omfattning card's chunk does not arrive", () => {
  it("still shows the whole tjänst, and draws no card", async () => {
    render(<MyStaffingPage />);
    // Let the page ask for the chunk and the rejection reach React: act rethrows what a render throws, so an error here fails the test.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    // Asked for, and refused: without this the rest would prove nothing about a chunk that never came.
    expect(asked.times).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { level: 1, name: "myStaffing.title" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "staffing.employmentTitle" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "staffing.annual.title" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "myStaffing.teachingTitle" })).toBeInTheDocument();
    expect(screen.queryByText(/staffing\.scope\./)).not.toBeInTheDocument();
  });
});
