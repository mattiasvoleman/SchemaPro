import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SchoolUnit } from "@/lib/school-units";
import type { StudentGroup } from "@/lib/types";
import { SchoolUnitsCard } from "./school-units-card";

const F6: SchoolUnit = { id: "u-f6", name: "Norra F–6", code: "11111111", schoolTypes: ["FKLASS", "GR"], gradeFrom: 0, gradeTo: 6, fromSource: false };
const U79: SchoolUnit = { id: "u-79", name: "Norra 7–9", code: "22222222", schoolTypes: ["GR"], gradeFrom: 7, gradeTo: 9, fromSource: true };

const state = vi.hoisted(() => ({
  units: { data: [] as SchoolUnit[] | undefined, isLoading: false, isError: false },
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  keys: [] as string[][],
}));

vi.mock("./use-school-units", () => ({ SCHOOL_UNITS_KEY: ["school-units"], useSchoolUnits: () => state.units }));
vi.mock("@/lib/queries", () => ({
  useCrudMutations: (_path: string, keys: string[][]) => {
    state.keys = keys;
    return {
      create: { mutateAsync: state.create, isPending: false },
      update: { mutateAsync: state.update, isPending: false },
      remove: { mutateAsync: state.remove, isPending: false },
    };
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join("|")})` : key;
    t.has = () => true;
    return t;
  },
}));

const klass = (name: string, gradeLevel: number | null): StudentGroup =>
  ({ id: `g-${name}`, academicYearId: "y1", name, kind: "CLASS", gradeLevel }) as StudentGroup;

describe("Skolenheter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.units = { data: [F6, U79], isLoading: false, isError: false };
    state.create.mockResolvedValue({});
    state.update.mockResolvedValue({});
  });

  it("lists each unit with its code, skolformer, årskurser and this year's classes by their årskurs", () => {
    render(<SchoolUnitsCard classes={[klass("6A", 6), klass("7A", 7), klass("7B", 7), klass("FA", 0)]} />);
    const table = screen.getByRole("table", { name: "caption" });
    const rows = within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));
    expect(rows.map((cells) => cells.slice(0, 5))).toEqual([
      ["Norra F–6", "11111111", "types.FKLASS, types.GR", "span(grade(0)|grade(6))", "6A, FA"],
      ["Norra 7–9fromSource", "22222222", "types.GR", "span(grade(7)|grade(9))", "7A, 7B"],
    ]);
  });

  it("names a class whose årskurs no unit holds, and where it is counted instead", () => {
    render(<SchoolUnitsCard classes={[klass("10A", 10), klass("7A", 7)]} />);
    expect(screen.getByText("outside(10A|Norra F–6)")).toBeInTheDocument();
  });

  it("says what a school without units gets, and what a failed read is", () => {
    state.units = { data: [], isLoading: false, isError: false };
    const { unmount } = render(<SchoolUnitsCard classes={[]} />);
    expect(screen.getByText("empty")).toBeInTheDocument();
    unmount();
    state.units = { data: undefined, isLoading: false, isError: true };
    render(<SchoolUnitsCard classes={[]} />);
    expect(screen.getByText("loadFailed")).toBeInTheDocument();
  });

  it("adds a unit with the code as eight digits, and refuses årskurser another unit holds before asking", async () => {
    const user = userEvent.setup();
    state.units = { data: [U79], isLoading: false, isError: false };
    render(<SchoolUnitsCard classes={[]} />);
    await user.click(screen.getByRole("button", { name: "add" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("fields.name"), "Norra F–6");
    await user.type(within(dialog).getByLabelText(/fields\.code/), "1111 1111");
    await user.click(within(dialog).getByLabelText("types.GR"));
    await user.selectOptions(within(dialog).getByLabelText(/fields\.gradeFrom/), "0");
    await user.selectOptions(within(dialog).getByLabelText(/fields\.gradeTo/), "7");
    expect(within(dialog).getByText("overlap(Norra 7–9)")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "save" }));
    expect(state.create).not.toHaveBeenCalled();
    await user.selectOptions(within(dialog).getByLabelText(/fields\.gradeTo/), "6");
    await user.click(within(dialog).getByRole("button", { name: "save" }));
    expect(state.create).toHaveBeenCalledWith({ name: "Norra F–6", code: "11111111", schoolTypes: ["GR"], gradeFrom: 0, gradeTo: 6 });
    expect(state.keys).toEqual([["school-units"]]);
  });

  it("names a code that is not eight digits, or another unit's, and a missing name on the first save, and writes nothing", async () => {
    const user = userEvent.setup();
    render(<SchoolUnitsCard classes={[]} />);
    await user.click(screen.getByRole("button", { name: "add" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "save" }));
    expect(within(dialog).getByLabelText("fields.name")).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).getByText("errors.nameMissing")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("fields.name"), "X");
    await user.type(within(dialog).getByLabelText(/fields\.code/), "1234");
    expect(within(dialog).getByText("errors.SCHOOL_UNIT_CODE_INVALID")).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText(/fields\.code/));
    await user.type(within(dialog).getByLabelText(/fields\.code/), "1111 1111");
    expect(within(dialog).getByText("errors.SCHOOL_UNIT_CODE_TAKEN")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "save" }));
    expect(state.create).not.toHaveBeenCalled();
  });

  it("keeps a refused save in the form, with the gateway's reason, and the dialog open", async () => {
    const user = userEvent.setup();
    state.create.mockRejectedValueOnce(new Error("Årskurserna ligger redan i en annan skolenhet."));
    render(<SchoolUnitsCard classes={[]} />);
    await user.click(screen.getByRole("button", { name: "add" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("fields.name"), "Ny");
    await user.click(within(dialog).getByRole("button", { name: "save" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("saveFailed");
    expect(alert).toHaveTextContent("Årskurserna ligger redan i en annan skolenhet.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("keeps the table when a refetch fails, and says so above it", () => {
    state.units = { data: [F6], isLoading: false, isError: true };
    render(<SchoolUnitsCard classes={[]} />);
    expect(screen.getByRole("table", { name: "caption" })).toBeInTheDocument();
    expect(screen.getByText("loadFailed")).toBeInTheDocument();
    expect(screen.getByText("refetchFailedHint")).toBeInTheDocument();
  });

  it("shows a unit from the register read-only but its årskurser, and sends only the span", async () => {
    const user = userEvent.setup();
    render(<SchoolUnitsCard classes={[]} />);
    await user.click(screen.getByRole("button", { name: "actionNamed(edit|Norra 7–9)" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("fromSourceHint")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("fields.name")).toHaveAttribute("readonly");
    expect(within(dialog).getByLabelText(/fields\.code/)).toHaveAttribute("readonly");
    // The register's skolformer are read, not offered as boxes.
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    expect(within(dialog).getByText("types.GR")).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText(/fields\.gradeTo/), "10");
    await user.click(within(dialog).getByRole("button", { name: "save" }));
    expect(state.update).toHaveBeenCalledWith({ id: "u-79", gradeFrom: 7, gradeTo: 10 });
  });
});
