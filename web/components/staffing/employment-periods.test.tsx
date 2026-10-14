import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LOAD_POLICY } from "@/lib/teacher-load";
import type { TeacherEmployment } from "@/lib/types";
import { EmploymentPeriods } from "./employment-periods";

const createPeriod = vi.hoisted(() => vi.fn());
const updatePeriod = vi.hoisted(() => vi.fn());
const removePeriod = vi.hoisted(() => vi.fn());

vi.mock("@/lib/staffing-queries", () => ({
  useTeacherEmploymentActions: () => ({
    createPeriod: { mutateAsync: createPeriod, isPending: false },
    updatePeriod: { mutateAsync: updatePeriod, isPending: false },
    removePeriod: { mutateAsync: removePeriod, isPending: false },
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    `${key}${values ? `(${Object.values(values).join("|")})` : ""}`,
}));

const YEAR = { startDate: "2026-08-17", endDate: "2027-06-11" };
const policy = { ...DEFAULT_LOAD_POLICY, fullTimeTeachingMinutesPerWeek: 1080 };
const post = (periods: TeacherEmployment["periods"] = []): TeacherEmployment => ({
  id: "e1",
  userId: "t-anna",
  academicYearId: "y1",
  employmentPercent: 100,
  reductionPercent: 0,
  contractKind: "FERIE",
  teachingTargetMinutesPerWeek: null,
  signature: null,
  note: null,
  periods,
});
const november = {
  id: "p-nov",
  employmentId: "e1",
  validFrom: "2026-11-01",
  validTo: null,
  employmentPercent: 80,
  reductionPercent: 0,
  teachingTargetMinutesPerWeek: null,
};

const renderPeriods = (employment: TeacherEmployment, year: typeof YEAR | null = YEAR) =>
  render(
    <EmploymentPeriods teacher={{ id: "t-anna" }} academicYearId="y1" year={year} employment={employment} policy={policy} />,
  );

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("EmploymentPeriods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createPeriod.mockResolvedValue(undefined);
    updatePeriod.mockResolvedValue(undefined);
    removePeriod.mockResolvedValue(undefined);
  });

  it("says a post without periods is the same all year", () => {
    renderPeriods(post());
    expect(screen.getByText("noPeriods")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "periodsTimeline" })).toBeNull();
  });

  it("draws the year as the report cuts it: the post until the period, the period to the year's end, each with its target", () => {
    renderPeriods(post([november]));
    const items = within(screen.getByRole("list", { name: "periodsTimeline" })).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("periodDates(2026-08-17|2026-10-31) · periodBase");
    expect(items[0]).toHaveTextContent("periodFigures(100) · derivedTarget(1080)");
    expect(items[1]).toHaveTextContent("periodDates(2026-11-01|2027-06-11) · periodKindLabel");
    // 1080 × 80 / 100 = 864 → 865 on the five-minute grid.
    expect(items[1]).toHaveTextContent("periodFigures(80) · derivedTarget(865)");
    // Only a period is the period's to edit; the post's own stretch is edited above.
    expect(within(items[0]!).queryByRole("button")).toBeNull();
    expect(within(items[1]!).getByRole("button", { name: "editPeriod(2026-11-01)" })).toBeInTheDocument();
  });

  it("says a period that holds no whole week changes no target", () => {
    renderPeriods(post([{ ...november, validFrom: "2026-11-10", validTo: "2026-11-13" }]));
    const items = within(screen.getByRole("list", { name: "periodsTimeline" })).getAllByRole("listitem");
    expect(items.map((item) => item.textContent?.includes("periodNoWeek"))).toEqual([false, true, false]);
  });

  it("lists the periods alone while the year's bounds have not loaded", () => {
    renderPeriods(post([november]), null);
    expect(screen.getByText(/periodDates\(2026-11-01\|…\)/)).toBeInTheDocument();
  });

  it("adds a period from the post's own figures, and sends Från, Till and the three figures", async () => {
    const user = userEvent.setup();
    renderPeriods(post());
    await user.click(screen.getByRole("button", { name: "addPeriod" }));
    expect((screen.getByLabelText("employmentPercent") as HTMLInputElement).value).toBe("100");
    type("periodFrom", "2026-11-01");
    type("employmentPercent", "80");
    expect(screen.getByRole("status")).toHaveTextContent("derivedTarget(865)");
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(createPeriod).toHaveBeenCalledWith({
      userId: "t-anna",
      academicYearId: "y1",
      validFrom: "2026-11-01",
      validTo: null,
      employmentPercent: 80,
      reductionPercent: 0,
      teachingTargetMinutesPerWeek: null,
    });
  });

  it("says an overlap beside the fields once they are touched, and keeps Spara off", async () => {
    const user = userEvent.setup();
    renderPeriods(post([november]));
    await user.click(screen.getByRole("button", { name: "addPeriod" }));
    // Untouched: no sentence yet, though nothing can be saved.
    expect(screen.queryByText(/problem_/)).toBeNull();
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
    type("periodFrom", "2027-01-07");
    expect(screen.getByText("problem_periodOverlaps(2026-11-01|2027-06-11)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
    expect(createPeriod).not.toHaveBeenCalled();
  });

  it("rewrites a period by its id, and removes one after asking", async () => {
    const user = userEvent.setup();
    renderPeriods(post([november]));
    await user.click(screen.getByRole("button", { name: "editPeriod(2026-11-01)" }));
    type("employmentPercent", "75");
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(updatePeriod).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p-nov", validFrom: "2026-11-01", employmentPercent: 75 }),
    );

    await user.click(screen.getByRole("button", { name: "removePeriod(2026-11-01)" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("removePeriodBody")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "removePeriodConfirm" }));
    expect(removePeriod).toHaveBeenCalledWith("p-nov");
  });

  it("offers no removal while a period's form is open, so no form is left saving to a deleted period", async () => {
    const user = userEvent.setup();
    renderPeriods(post([november]));
    await user.click(screen.getByRole("button", { name: "editPeriod(2026-11-01)" }));
    expect(screen.getByRole("button", { name: "removePeriod(2026-11-01)" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "cancel" }));
    expect(screen.getByRole("button", { name: "removePeriod(2026-11-01)" })).toBeEnabled();
  });
});
