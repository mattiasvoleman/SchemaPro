import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SetupPage from "./page";

/**
 * Kom igång's läsår step, for what P2 added to it: each year opens "Timplan
 * per årskurs", a new year's attached defaults are said in a toast, and the
 * year's create invalidates the attachments and the coverage, which the
 * gateway wrote in the same transaction. The dialog itself is tested in
 * components/timplan/year-timplans-dialog.test.tsx.
 */

const state = vi.hoisted(() => ({
  create: vi.fn(),
  keys: [] as string[][][],
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({
    data: [
      { id: "y-0", name: "2025/26", startDate: "2025-08-18", endDate: "2026-06-12", isActive: false },
      { id: "y-1", name: "2026/27", startDate: "2026-08-17", endDate: "2027-06-11", isActive: true },
    ],
  }),
  useSubjects: () => ({ data: [] }),
  useRooms: () => ({ data: [] }),
  useGroups: () => ({ data: [] }),
  usePeople: () => ({ data: [] }),
  useCrudMutations: (path: string, keys: string[][]) => {
    if (path === "/api/v1/academic-years") state.keys.push(keys);
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
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("sonner", () => ({ toast: state.toast }));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

beforeEach(() => {
  state.create = vi.fn(async () => ({
    id: "y-2",
    name: "2027/28",
    timplans: [
      { gradeLevel: 1, localTimplanId: "p", planName: "Grundskola 2024", planStatus: "DECIDED" },
      { gradeLevel: 2, localTimplanId: "p", planName: "Grundskola 2024", planStatus: "DECIDED" },
    ],
  }));
  state.keys = [];
  state.toast.info.mockReset();
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
    // The year exists, so Kom igång opens on the next step; go back to it.
    await user.click(screen.getByRole("button", { name: /stepYear/ }));
    await user.type(screen.getByLabelText("yearName"), "2027/28");
    await user.type(screen.getByLabelText("year-start"), "2027-08-16");
    await user.type(screen.getByLabelText("year-end"), "2028-06-09");
    await user.click(screen.getByRole("button", { name: "create" }));
    expect(state.create).toHaveBeenCalled();
    expect(state.toast.info).toHaveBeenCalledWith("yearTimplansDefaulted(2027/28|Grundskola 2024|2)");
    expect(state.keys[0]).toEqual([["academicYears"], ["yearTimplans"], ["timplanCoverage"]]);
  });

  it("says nothing more when no decided plan was attached", async () => {
    const user = userEvent.setup();
    state.create = vi.fn(async () => ({ id: "y-2", name: "2027/28", timplans: [] }));
    render(<SetupPage />);
    // The year exists, so Kom igång opens on the next step; go back to it.
    await user.click(screen.getByRole("button", { name: /stepYear/ }));
    await user.type(screen.getByLabelText("yearName"), "2027/28");
    await user.type(screen.getByLabelText("year-start"), "2027-08-16");
    await user.type(screen.getByLabelText("year-end"), "2028-06-09");
    await user.click(screen.getByRole("button", { name: "create" }));
    expect(state.create).toHaveBeenCalled();
    expect(state.toast.info).not.toHaveBeenCalled();
  });
});
