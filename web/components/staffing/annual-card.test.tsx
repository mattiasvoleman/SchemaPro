import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TeacherLoad } from "@/lib/teacher-load";
import { AnnualCard } from "./annual-card";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

const ferie: TeacherLoad["annual"] = {
  assignedHoursPerYear: 573.5,
  regulatedHoursPerYear: 1088,
  workDaysPerYear: 194,
  contractKind: "FERIE",
  annualHours: 1413.6,
  unregulatedHoursPerYear: 325.6,
  semesterHoursPerWeek: null,
  dutyHoursPerYear: 57,
  teachingWeeksPerYear: 38,
  percentOfRegulated: 52.7,
};

const rows = () =>
  screen.getAllByRole("term").map((term) => `${term.textContent}=${term.nextElementSibling?.textContent}`);

describe("AnnualCard", () => {
  it("states a ferietjänst's year against the school's frame, A-dagar unscaled", () => {
    render(<AnnualCard annual={ferie} loadModel="MINUTES" />);
    expect(rows()).toEqual([
      "teachingHours=hours(573,5)",
      "dutyHours=hours(57)",
      "regulated=hours(1088)",
      "annualHours=hours(1413,6)",
      "unregulated=hours(325,6)",
      "workDays=194",
      "percentOfRegulated=52,7 %",
      "teachingWeeks=38",
    ]);
    // The figures are the school's settings, and the caption says so.
    expect(screen.getByText("caption")).toBeInTheDocument();
    expect(screen.queryByText("captionAdmin")).not.toBeInTheDocument();
  });

  it("says räknad tid under the Faktor model, and points the admin at the settings", () => {
    render(<AnnualCard annual={ferie} loadModel="FACTOR" showSettingsPath />);
    expect(rows()[0]).toBe("teachingHoursFactor=hours(573,5)");
    expect(screen.getByText("captionAdmin")).toBeInTheDocument();
  });

  it("gives a semestertjänst its week and no reglerad/oreglerad split", () => {
    render(
      <AnnualCard
        annual={{
          ...ferie,
          contractKind: "SEMESTER",
          annualHours: null,
          unregulatedHoursPerYear: null,
          semesterHoursPerWeek: 32,
        }}
        loadModel="MINUTES"
      />,
    );
    expect(screen.getByText("semesterWeekly(32)")).toBeInTheDocument();
    const terms = screen.getAllByRole("term").map((term) => term.textContent);
    expect(terms).toEqual(["teachingHours", "dutyHours", "teachingWeeks"]);
  });

  it("says a teacher without a post has no frame, rather than a zero one", () => {
    render(
      <AnnualCard
        annual={{
          ...ferie,
          contractKind: null,
          regulatedHoursPerYear: null,
          annualHours: null,
          unregulatedHoursPerYear: null,
          percentOfRegulated: null,
        }}
        loadModel="MINUTES"
        headingLevel="h2"
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "title" })).toBeInTheDocument();
    expect(screen.getByText("noPost")).toBeInTheDocument();
    const list = screen.getAllByRole("term")[0]!.closest("dl")!;
    expect(within(list).queryByText("regulated")).not.toBeInTheDocument();
    expect(within(list).queryByText("workDays")).not.toBeInTheDocument();
  });
});
