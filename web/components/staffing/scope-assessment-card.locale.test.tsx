import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScopeAssessmentView } from "@/lib/assignment-scope";
import { ScopeAssessmentCard } from "./scope-assessment-card";

const locale = vi.hoisted(() => ({ current: "sv" as "sv" | "en" }));
const school = vi.hoisted(() => ({ current: null as { timezone: string } | null }));

vi.mock("@/lib/scope-assessment-queries", () => ({
  useScopeAssessmentActions: () => ({
    save: { mutateAsync: vi.fn(), isPending: false },
    remove: { mutateAsync: vi.fn(), isPending: false },
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/profile-context", () => ({ useProfile: () => ({ profile: {}, school: school.current }) }));
vi.mock("next-intl", () => ({
  useLocale: () => locale.current,
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

afterEach(() => {
  cleanup();
  locale.current = "sv";
  school.current = null;
});

/*
 * THE HOURS AND THE DAYS OF THE PRINCIPAL'S ASSESSMENT IN THE READER'S LANGUAGE AND THE SCHOOL'S DAY (the review of #411, L-1).
 *
 * The level and the edge were written with the Swedish comma in English ("603,3 h"), a day was ISO text in both languages, and "Satt <dag>"
 * was the UTC day of the instant: a decision at 00:30 Swedish time on the 6th of March said the 5th.
 */
const teacher = { id: "t-anna", firstName: "Anna", lastName: "Ek" };
const stored = (over: Partial<ScopeAssessmentView> = {}): ScopeAssessmentView => ({
  levelHours: 603.3,
  exceptionKind: "OWN_INITIATIVE",
  ownInitiativeOn: "2027-05-02",
  note: null,
  decidedAt: "2027-03-05T23:30:00.000Z",
  ...over,
});
const renderCard = (assessment: ScopeAssessmentView | undefined, fullTimeHighestHours: number | null = 1122.5) =>
  render(<ScopeAssessmentCard teacher={teacher} academicYearId="y1" assessment={assessment} fullTimeHighestHours={fullTimeHighestHours} />);

describe("the summary of a stored assessment", () => {
  it("writes the level as Swedish does in Swedish: the comma, no grouping", () => {
    renderCard(stored({ levelHours: 1122 }));
    expect(screen.getByText("summaryLevel(1122)")).toBeInTheDocument();
    cleanup();
    renderCard(stored());
    expect(screen.getByText("summaryLevel(603,3)")).toBeInTheDocument();
  });

  it("writes the level as English does in English: the point, and grouped thousands", () => {
    locale.current = "en";
    renderCard(stored());
    expect(screen.getByText("summaryLevel(603.3)")).toBeInTheDocument();
    cleanup();
    renderCard(stored({ levelHours: 1122 }));
    expect(screen.getByText("summaryLevel(1,122)")).toBeInTheDocument();
  });

  it("says the day of the exception as the language writes a day", () => {
    renderCard(stored());
    expect(screen.getByText(/summaryException/)).toHaveTextContent("summaryInitiativeOn(2027-05-02)");
    cleanup();
    locale.current = "en";
    renderCard(stored());
    expect(screen.getByText(/summaryException/)).toHaveTextContent("summaryInitiativeOn(2 May 2027)");
  });

  it("says the day it was set as the school's day: 23:30 UTC is already the next day at a school in Stockholm", () => {
    school.current = { timezone: "Europe/Stockholm" };
    renderCard(stored());
    expect(screen.getByText("summaryDecided(2027-03-06)")).toBeInTheDocument();
    cleanup();
    locale.current = "en";
    renderCard(stored());
    expect(screen.getByText("summaryDecided(6 March 2027)")).toBeInTheDocument();
  });

  it("uses the school's own zone and not Stockholm's when the school is elsewhere", () => {
    school.current = { timezone: "America/New_York" };
    renderCard(stored());
    expect(screen.getByText("summaryDecided(2027-03-05)")).toBeInTheDocument();
  });

  it("falls back to Stockholm's day for a profile that names no school, as the other pages do", () => {
    school.current = null;
    renderCard(stored());
    expect(screen.getByText("summaryDecided(2027-03-06)")).toBeInTheDocument();
  });

  it("says no day it was set when none was recorded, and no day of the exception that has none", () => {
    renderCard(stored({ decidedAt: null, ownInitiativeOn: null, exceptionKind: "SMALL_GROUP" }));
    expect(screen.queryByText(/summaryDecided/)).not.toBeInTheDocument();
    expect(screen.getByText(/summaryException/)).not.toHaveTextContent("summaryInitiativeOn");
  });
});

describe("the hint under the level field", () => {
  const open = async (hours: number | null) => {
    renderCard(undefined, hours);
    await userEvent.setup().click(screen.getByRole("button", { name: "add" }));
  };

  it("writes the edge as Swedish does in Swedish", async () => {
    await open(1122.5);
    expect(screen.getByText("levelHint(1122,5)")).toBeInTheDocument();
  });

  it("writes the edge as English does in English", async () => {
    locale.current = "en";
    await open(1122.5);
    expect(screen.getByText("levelHint(1,122.5)")).toBeInTheDocument();
  });

  it("says no edge when none is known, in either language", async () => {
    locale.current = "en";
    await open(null);
    expect(screen.getByText("levelHintNoEdge")).toBeInTheDocument();
  });
});
