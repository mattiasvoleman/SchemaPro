import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MyStaffingPage from "./page";

/**
 * The omfattning card is a lazy chunk, and the page's own words about it are two: the rest of the tjänst stays on screen while the
 * chunk is on its way (the Suspense around the card), and the card is a section of the page of its own (an h2 beside Årsarbetstid,
 * not an h3 inside it). The chunk is held back here until the test lets it go, so both can be told apart from the card's absence.
 */
const gate = vi.hoisted(() => {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
});

vi.mock("@/components/profile-context", () => ({ useProfile: () => ({ profile: { id: "t-me", role: "TEACHER" } }) }));
vi.mock("@/lib/queries", () => ({
  useActiveYear: () => ({ data: [], activeYear: { id: "y-1", name: "2027/28", isActive: true, predecessorId: null }, isLoading: false }),
  useSubjects: () => ({ data: [] }),
  useGroups: () => ({ data: [] }),
}));
vi.mock("@/lib/staffing-queries", () => {
  const data = {
    teachers: [
      {
        userId: "t-me",
        employment: { userId: "t-me", employmentPercent: 100, reductionPercent: 0, contractKind: "FERIE", teachingTargetMinutesPerWeek: null, signature: null },
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
          userId: "t-me",
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
  };
  return {
    useStaffingLoad: () => ({ isLoading: false, isError: false, data }),
    useTeacherDuties: () => ({ data: [], isLoading: false, isError: false }),
  };
});
vi.mock("@/i18n/navigation", () => ({ Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a> }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));
// The card's chunk, held back until the test lets it go.
vi.mock("@/components/staffing/scope-card", async (importOriginal) => {
  await gate.opened;
  return importOriginal();
});

describe("Min tjänst while the omfattning card's chunk is on its way, and once it has come", () => {
  it("keeps the tjänst on screen until the card arrives, and draws the card as an h2 beside Årsarbetstid", async () => {
    render(<MyStaffingPage />);
    // The chunk is held back: everything else is already there, and the card is not.
    expect(screen.getByRole("heading", { level: 1, name: "myStaffing.title" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "staffing.employmentTitle" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "myStaffing.teachingTitle" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "staffing.scope.title" })).not.toBeInTheDocument();

    gate.open();
    // The first import of the real card is transformed on the way: allow it more than the default second on a loaded machine.
    const card = await screen.findByRole("region", { name: "staffing.scope.title" }, { timeout: 10000 });
    // A section of the page, as Årsarbetstid is: an h2, and not drawn inside the Årsarbetstid card.
    expect(within(card).getByRole("heading", { level: 2, name: "staffing.scope.title" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "staffing.annual.title" })).queryByText("staffing.scope.title")).not.toBeInTheDocument();
    // Spoken to the teacher: the card is on their own page.
    expect(within(card).getByText("staffing.scope.teachingOwn")).toBeInTheDocument();
  });
});
