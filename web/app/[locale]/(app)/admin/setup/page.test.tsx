import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SetupPage from "./page";

/**
 * Kom igång's läsår step. Two rules meet here.
 *
 * Läsårsrullning: a school's FIRST läsår is created active, a later one is
 * not. Handing the active flag to a new, empty year by default would leave
 * every pupil in a class of a year that is no longer the active one; next
 * year comes from Rulla vidare and becomes active through the activation,
 * with its pupils.
 *
 * Timplan P2: each year opens "Timplan per årskurs", a new year's attached
 * defaults are said in a toast, and the year's create invalidates the
 * attachments and the coverage, which the gateway wrote in the same
 * transaction. The dialog itself is tested in
 * components/timplan/year-timplans-dialog.test.tsx.
 */

const TWO_YEARS = [
  { id: "y-0", name: "2025/26", startDate: "2025-08-18", endDate: "2026-06-12", isActive: false, predecessorId: null, graduatingGradeLevel: null },
  { id: "y-1", name: "2026/27", startDate: "2026-08-17", endDate: "2027-06-11", isActive: true, predecessorId: null, graduatingGradeLevel: null },
];

const state = vi.hoisted(() => ({
  years: [] as unknown[],
  create: vi.fn(),
  keys: [] as string[][][],
  groupKeys: [] as string[][],
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({ data: state.years }),
  useSubjects: () => ({ data: [] }),
  useRooms: () => ({ data: [] }),
  useGroups: () => ({ data: [] }),
  usePeople: () => ({ data: [] }),
  useCrudMutations: (path: string, keys: string[][]) => {
    if (path === "/api/v1/academic-years") state.keys.push(keys);
    if (path === "/api/v1/student-groups") state.groupKeys = keys;
    return {
      create: { mutateAsync: path === "/api/v1/academic-years" ? state.create : vi.fn(), isPending: false },
      update: { mutateAsync: vi.fn(), isPending: false },
      remove: { mutateAsync: vi.fn(), isPending: false },
    };
  },
}));
vi.mock("@/components/timplan/year-timplans-dialog", () => ({
  YearTimplansDialog: ({ initialYearId }: { initialYearId: string }) => (
    <div role="dialog">year dialog for {initialYearId}</div>
  ),
}));
vi.mock("@/components/ui/date-field", () => ({
  DateField: ({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) => (
    <input id={id} aria-label={id} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("sonner", () => ({ toast: state.toast }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join("|")})` : key;
    t.has = () => true;
    return t;
  },
}));

async function fillYear(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("yearName"), "2027/28");
  await user.type(screen.getByLabelText("year-start"), "2027-08-16");
  await user.type(screen.getByLabelText("year-end"), "2028-06-09");
}

beforeEach(() => {
  vi.clearAllMocks();
  state.years = TWO_YEARS;
  state.create = vi.fn(async () => ({
    id: "y-2",
    name: "2027/28",
    timplans: [
      { gradeLevel: 1, localTimplanId: "p", planName: "Grundskola 2024", planStatus: "DECIDED" },
      { gradeLevel: 2, localTimplanId: "p", planName: "Grundskola 2024", planStatus: "DECIDED" },
    ],
  }));
  state.keys = [];
});

describe("SetupPage, the year step and the active flag", () => {
  it("makes next year's projected class lists stale with a class it creates", () => {
    state.years = [];
    render(<SetupPage />);
    expect(state.groupKeys).toEqual(expect.arrayContaining([["groups"], ["people", "yearRosters"]]));
  });

  it("creates a school's first läsår active", async () => {
    state.years = [];
    const user = userEvent.setup();
    render(<SetupPage />);
    expect(screen.getByRole("switch")).toBeChecked();
    expect(screen.queryByText("yearExistsHint")).toBeNull();

    await fillYear(user);
    await user.click(screen.getByRole("button", { name: "create" }));
    expect(state.create).toHaveBeenCalledWith(expect.objectContaining({ name: "2027/28", isActive: true }));
  });

  it("creates a later one inactive, and points at Rulla vidare", async () => {
    const user = userEvent.setup();
    render(<SetupPage />);
    // A school with an active year has done this step; it is opened again.
    await user.click(screen.getByRole("button", { name: /stepYear/ }));
    expect(screen.getByRole("switch")).not.toBeChecked();
    expect(screen.getByRole("link", { name: "yearsLink" })).toHaveAttribute("href", "/admin/years");

    await fillYear(user);
    await user.click(screen.getByRole("button", { name: "create" }));
    expect(state.create).toHaveBeenCalledWith(expect.objectContaining({ isActive: false }));
  });

  it("still lets the admin make it active on purpose", async () => {
    const user = userEvent.setup();
    render(<SetupPage />);
    await user.click(screen.getByRole("button", { name: /stepYear/ }));
    await user.click(screen.getByRole("switch"));
    await fillYear(user);
    await user.click(screen.getByRole("button", { name: "create" }));
    expect(state.create).toHaveBeenCalledWith(expect.objectContaining({ isActive: true }));
  });
});

describe("SetupPage: the läsår step and Timplan per årskurs", () => {
  it("lists each year with its own Timplan per årskurs button", async () => {
    const user = userEvent.setup();
    render(<SetupPage />);
    // The year exists, so Kom igång opens on the next step; go back to it.
    await user.click(screen.getByRole("button", { name: /stepYear/ }));
    await user.click(screen.getByRole("button", { name: "yearTimplansFor(2025/26)" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("year dialog for y-0");
  });

  it("says which plan a new year follows, and refreshes the attachments and the coverage", async () => {
    const user = userEvent.setup();
    render(<SetupPage />);
    await user.click(screen.getByRole("button", { name: /stepYear/ }));
    await fillYear(user);
    await user.click(screen.getByRole("button", { name: "create" }));
    expect(state.create).toHaveBeenCalled();
    expect(state.toast.info).toHaveBeenCalledWith("yearTimplansDefaulted(2027/28|Grundskola 2024|2)");
    expect(state.keys[0]).toEqual([["academicYears"], ["yearTimplans"], ["timplanCoverage"]]);
  });

  it("says nothing more when no decided plan was attached", async () => {
    const user = userEvent.setup();
    state.create = vi.fn(async () => ({ id: "y-2", name: "2027/28", timplans: [] }));
    render(<SetupPage />);
    await user.click(screen.getByRole("button", { name: /stepYear/ }));
    await fillYear(user);
    await user.click(screen.getByRole("button", { name: "create" }));
    expect(state.create).toHaveBeenCalled();
    expect(state.toast.info).not.toHaveBeenCalled();
  });
});
