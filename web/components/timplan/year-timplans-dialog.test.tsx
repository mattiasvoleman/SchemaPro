import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcademicYear } from "@/lib/types";
import { YearTimplansDialog } from "./year-timplans-dialog";

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * "Timplan per årskurs": what the dialog lists, what it sends, and that a
 * draft is marked. The PUT's own rules (a plan of another school, a grade
 * twice) are the gateway's and covered by its e2e rows.
 */

const state = vi.hoisted(() => ({
  saved: [] as { gradeLevel: number; localTimplanId: string; planName: string; planStatus: string }[],
  plans: [] as { id: string; name: string; status: "DRAFT" | "DECIDED" }[],
  save: { mutateAsync: vi.fn(), isPending: false },
}));

vi.mock("@/lib/queries", () => ({
  useGroups: () => ({
    data: [
      { id: "g-7a", academicYearId: "y-1", name: "7A", kind: "CLASS", gradeLevel: 7 },
      { id: "g-7b", academicYearId: "y-1", name: "7B", kind: "CLASS", gradeLevel: 7 },
      { id: "g-sva", academicYearId: "y-1", name: "SvA 7", kind: "TEACHING_GROUP", gradeLevel: 7 },
      { id: "g-old", academicYearId: "y-0", name: "9C", kind: "CLASS", gradeLevel: 9 },
    ],
    isLoading: false,
    isError: false,
  }),
}));
vi.mock("@/lib/timplan-queries", () => ({
  useLocalTimplans: () => ({ data: state.plans, isLoading: false, isError: false }),
}));
vi.mock("@/lib/year-timplan-queries", () => ({
  useYearTimplans: () => ({ data: state.saved, isLoading: false, isError: false }),
  useSaveYearTimplans: () => state.save,
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

const YEARS: AcademicYear[] = [
  { id: "y-0", name: "2025/26", startDate: "2025-08-18", endDate: "2026-06-12", isActive: false },
  { id: "y-1", name: "2026/27", startDate: "2026-08-17", endDate: "2027-06-11", isActive: true },
];

const select = (grade: number) => screen.getByRole("combobox", { name: `planFor(grade(${grade}))` });

beforeEach(() => {
  state.plans = [
    { id: "p-2024", name: "Grundskola 2024", status: "DECIDED" },
    { id: "p-2027", name: "Grundskola 2027", status: "DRAFT" },
  ];
  state.saved = [
    { gradeLevel: 7, localTimplanId: "p-2024", planName: "Grundskola 2024", planStatus: "DECIDED" },
    { gradeLevel: 8, localTimplanId: "p-2024", planName: "Grundskola 2024", planStatus: "DECIDED" },
  ];
  state.save = { mutateAsync: vi.fn(async () => []), isPending: false };
});

describe("YearTimplansDialog", () => {
  it("lists förskoleklass to åk 9 with the year's classes, the saved plans chosen, and nothing to save yet", () => {
    render(<YearTimplansDialog open onOpenChange={() => {}} years={YEARS} initialYearId={null} />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(10);
    const seventh = rows[7]!;
    expect(within(seventh).getByText("7A, 7B")).toBeInTheDocument();
    expect(within(rows[9]!).getByText("noClasses")).toBeInTheDocument();
    expect(select(7)).toHaveTextContent("Grundskola 2024");
    expect(select(0)).toHaveTextContent("none");
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
  });

  it("sends every listed grade, the cleared one as null, and closes", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<YearTimplansDialog open onOpenChange={onOpenChange} years={YEARS} initialYearId="y-1" />);

    await user.click(select(9));
    await user.click(await screen.findByRole("option", { name: /Grundskola 2027/ }));
    await user.click(select(8));
    await user.click(await screen.findByRole("option", { name: "none" }));
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(state.save.mutateAsync).toHaveBeenCalledTimes(1);
    const body = state.save.mutateAsync.mock.calls[0]![0] as {
      academicYearId: string;
      timplans: { gradeLevel: number; localTimplanId: string | null }[];
    };
    expect(body.academicYearId).toBe("y-1");
    expect(body.timplans).toHaveLength(10);
    expect(body.timplans.find((row) => row.gradeLevel === 7)).toEqual({ gradeLevel: 7, localTimplanId: "p-2024" });
    expect(body.timplans.find((row) => row.gradeLevel === 8)).toEqual({ gradeLevel: 8, localTimplanId: null });
    expect(body.timplans.find((row) => row.gradeLevel === 9)).toEqual({ gradeLevel: 9, localTimplanId: "p-2027" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("marks a draft as 'utkast — inte beslutad' beside the grade that follows it", async () => {
    const user = userEvent.setup();
    render(<YearTimplansDialog open onOpenChange={() => {}} years={YEARS} initialYearId="y-1" />);
    expect(screen.queryByText("draft")).not.toBeInTheDocument();
    await user.click(select(9));
    await user.click(await screen.findByRole("option", { name: /Grundskola 2027/ }));
    expect(screen.getByText("draft")).toBeInTheDocument();
  });

  it("keeps the dialog open with the gateway's sentence when the save is refused", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    state.save.mutateAsync = vi.fn(async () => {
      throw new Error("localTimplanId: skolan har ingen lokal timplan med id p-x.");
    });
    render(<YearTimplansDialog open onOpenChange={onOpenChange} years={YEARS} initialYearId="y-1" />);
    await user.click(select(0));
    await user.click(await screen.findByRole("option", { name: /Grundskola 2024/ }));
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("skolan har ingen lokal timplan");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("will not switch läsår over unsaved choices", async () => {
    const user = userEvent.setup();
    render(<YearTimplansDialog open onOpenChange={() => {}} years={YEARS} initialYearId="y-1" />);
    expect(screen.getByRole("combobox", { name: "yearLabel" })).toBeEnabled();
    await user.click(select(0));
    await user.click(await screen.findByRole("option", { name: /Grundskola 2024/ }));
    expect(screen.getByRole("combobox", { name: "yearLabel" })).toBeDisabled();
    expect(screen.getByText("yearLocked")).toBeInTheDocument();
  });

  // Review reproduction (P2 review, lens webb): opened before the years had
  // loaded, the dialog froze "no year" in its initial state, and a school
  // with one year has no picker to get out of it.
  it("takes the year when the years arrive after it opened", () => {
    const { rerender } = render(
      <YearTimplansDialog open onOpenChange={() => {}} years={[]} initialYearId={null} />,
    );
    expect(screen.getByText("noYear")).toBeInTheDocument();
    rerender(<YearTimplansDialog open onOpenChange={() => {}} years={[YEARS[1]!]} initialYearId={null} />);
    expect(screen.queryByText("noYear")).not.toBeInTheDocument();
    expect(select(7)).toBeInTheDocument();
  });

  it("points to Timplan when the school has no plan to choose", () => {
    state.plans = [];
    state.saved = [];
    render(<YearTimplansDialog open onOpenChange={() => {}} years={YEARS} initialYearId="y-1" />);
    expect(screen.getByRole("link", { name: "noPlansLink" })).toHaveAttribute("href", "/admin/timplan");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
