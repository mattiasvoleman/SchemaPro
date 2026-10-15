import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PeriodLoad, TeacherLoad } from "@/lib/teacher-load";
import { YearComparison } from "./year-comparison";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

const lastYear = vi.hoisted(() => ({ data: null as { teachers: TeacherLoad[] } | null }));
vi.mock("@/lib/staffing-queries", () => ({
  useStaffingLoad: () => ({ data: lastYear.data, isLoading: false, isError: false, error: null }),
}));

const load = (userId: string, overrides: Partial<TeacherLoad> = {}): TeacherLoad =>
  ({
    userId,
    employment: {
      userId,
      employmentPercent: 100,
      reductionPercent: 0,
      contractKind: "FERIE",
      teachingTargetMinutesPerWeek: null,
      signature: null,
    },
    countedMinutesPerWeek: 960,
    percentOfTarget: 88.9,
    periods: [],
    ...overrides,
  }) as TeacherLoad;

const stretch = (from: string, to: string, employmentPercent: number, reductionPercent = 0) =>
  ({ from, to, employmentPercent, reductionPercent }) as PeriodLoad;

const names: Record<string, string> = { "t-bo": "Bo Alm", "t-eva": "Eva Ek" };

describe("YearComparison", () => {
  it("shows why a post whose nedsättning changes during the year is kept by 'only changed'", async () => {
    const user = userEvent.setup();
    lastYear.data = { teachers: [load("t-bo"), load("t-eva")] };
    render(
      <YearComparison
        thisYear={{
          name: "2026/27",
          teachers: [
            // Bo: 100 % both years, a 20 % nedsättning from January this year.
            load("t-bo", { periods: [stretch("2026-08-17", "2027-01-10", 100), stretch("2027-01-11", "2027-06-11", 100, 20)] }),
            load("t-eva"),
          ],
        }}
        predecessor={{ id: "y-0", name: "2025/26" }}
        teacherName={(id) => names[id] ?? id}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "changedOnly" }));
    // Eva did not change and is gone; Bo stays, and his row says what changed.
    expect(screen.queryByText("Eva Ek")).toBeNull();
    const bo = screen.getByRole("rowheader", { name: /Bo Alm/ }).closest("tr")!;
    expect(within(bo).getByText("reductionSteps(0 → 20)")).toBeInTheDocument();
    // Last year's post did not change during the year: no line there.
    expect(within(bo).getAllByText(/reductionSteps/)).toHaveLength(1);
  });
});
