import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupervisionArea, SupervisionRota } from "@/lib/supervision";
import SupervisionPage from "./page";

/**
 * Rastvaktsschema: the page draws the gateway's answer — the breaks short of
 * rastvakter first, each area's grid of breaks by weekday with who watches
 * them, the teachers' minutes beside their ram — and a läsare reads it all
 * without a control that writes.
 */

const YEAR = { id: "year-1", name: "2026/27", startDate: "2026-08-17", endDate: "2027-06-11", isActive: true };
const GARDEN: SupervisionArea = {
  id: "garden",
  name: "Skolgården",
  siteId: null,
  minGradeLevel: 0,
  maxGradeLevel: 3,
  duringRasts: true,
  duringLunch: false,
  guardsNeeded: 1,
  countsAsTeaching: false,
  shiftCount: 3,
};
const brk = (dayOfWeek: number, shiftIds: string[] = []) => ({
  areaId: "garden",
  dayOfWeek,
  startTime: "10:00",
  endTime: "10:20",
  names: ["Förmiddagsrast"],
  lunch: false,
  needed: 1,
  shiftIds,
});
const ROTA: SupervisionRota = {
  academicYearId: YEAR.id,
  year: { startDate: YEAR.startDate, endDate: YEAR.endDate },
  areas: [GARDEN],
  shifts: [
    { id: "s1", academicYearId: YEAR.id, areaId: "garden", userId: "anna", dayOfWeek: 1, startTime: "10:00", endTime: "10:20", validFrom: null, validTo: null, note: null },
    { id: "s2", academicYearId: YEAR.id, areaId: "garden", userId: "bo", dayOfWeek: 3, startTime: "10:00", endTime: "10:10", validFrom: "2027-01-07", validTo: null, note: null },
    { id: "bus", academicYearId: YEAR.id, areaId: "garden", userId: "bo", dayOfWeek: 5, startTime: "15:00", endTime: "15:15", validFrom: null, validTo: null, note: null },
  ],
  breaks: [brk(1, ["s1"]), brk(2), brk(3, ["s2"]), brk(4), brk(5)],
  gaps: [
    { ...brk(2), fewest: 0, shortFrom: "10:00", shortTo: "10:20", from: YEAR.startDate, to: YEAR.endDate },
    { ...brk(3), fewest: 0, shortFrom: "10:10", shortTo: "10:20", from: "2027-01-07", to: YEAR.endDate },
  ],
  teachers: [
    { userId: "anna", shiftCount: 1, minutesPerWeek: 20, countedMinutesPerWeek: 0, peakMinutesPerWeek: 20, hoursPerYear: 12.7, ramMinutesPerWeek: 60, ramCountedMinutesPerWeek: 0 },
    { userId: "bo", shiftCount: 2, minutesPerWeek: 20, countedMinutesPerWeek: 0, peakMinutesPerWeek: 25, hoursPerYear: 12.2, ramMinutesPerWeek: null, ramCountedMinutesPerWeek: 0 },
  ],
};

const mutations = vi.hoisted(() => ({
  createShift: vi.fn(),
  updateShift: vi.fn(),
  removeShift: vi.fn(),
  createArea: vi.fn(),
}));
const state = vi.hoisted(() => ({ rota: undefined as SupervisionRota | undefined, readOnly: false }));

vi.mock("./use-supervision", () => ({
  useSupervisionAreas: () => ({ data: state.rota?.areas ?? [], isLoading: false, isError: false }),
  useSupervisionRota: () => ({ data: state.rota, isLoading: false, isError: false }),
  useAreaMutations: () => ({
    create: { mutateAsync: mutations.createArea, isPending: false },
    update: { mutateAsync: vi.fn(), isPending: false },
    remove: { mutateAsync: vi.fn(), isPending: false },
  }),
  useShiftMutations: () => ({
    create: { mutateAsync: mutations.createShift, isPending: false },
    update: { mutateAsync: mutations.updateShift, isPending: false },
    remove: { mutateAsync: mutations.removeShift, isPending: false },
  }),
}));
vi.mock("../rooms/use-sites", () => ({ useSites: () => ({ data: { sites: [], travelTimes: [], roomsWithoutSite: 0 } }) }));
vi.mock("@/lib/queries", () => ({
  usePeople: () => ({
    data: [
      { id: "anna", role: "TEACHER", firstName: "Anna", lastName: "Lind", isActive: true },
      { id: "bo", role: "TEACHER", firstName: "Bo", lastName: "Ek", isActive: true },
      { id: "pupil", role: "STUDENT", firstName: "Elev", lastName: "Ett", isActive: true },
    ],
  }),
}));
vi.mock("@/components/schedule/year-select", () => ({
  useYearScope: () => ({ years: [YEAR], year: YEAR, yearId: YEAR.id, setYearId: vi.fn(), isLoading: false, isError: false }),
  YearSelect: () => null,
}));
vi.mock("@/components/profile-context", () => ({ useReadOnly: () => state.readOnly }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join("|")})` : key;
    t.has = () => false;
    return t;
  },
}));

beforeEach(() => {
  state.rota = ROTA;
  state.readOnly = false;
  for (const mock of Object.values(mutations)) mock.mockReset().mockResolvedValue({});
});

describe("SupervisionPage", () => {
  it("lists the breaks nobody watches first, with the minutes and the dates they are short", () => {
    render(<SupervisionPage />);
    // The gaps card's own translator is the namespace's: its keys come unprefixed.
    const gaps = screen.getByRole("region", { name: "count(2)" });
    const items = within(gaps).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("nobody(10:00|10:20) wholeYear"),
      expect.stringContaining("nobody(10:10|10:20) dates(2027-01-07|2027-06-11)"),
    ]);
  });

  it("draws an area's breaks by weekday with who watches them, the short ones marked, and a pass in no break apart", () => {
    render(<SupervisionPage />);
    const grid = screen.getByRole("table", { name: "grid.caption(Skolgården)" });
    const row = within(grid).getByRole("row", { name: /10:00–10:20/ });
    const cells = within(row).getAllByRole("cell");
    expect(cells[0]).toHaveTextContent("Anna Lind");
    expect(cells[1]).toHaveTextContent("grid.short");
    // Bo's Wednesday pass is shorter than the break and dated: both are said.
    expect(cells[2]).toHaveTextContent("Bo Ek");
    expect(cells[2]).toHaveTextContent("grid.passTime(10:00|10:10)");
    expect(cells[2]).toHaveTextContent("grid.from(2027-01-07)");
    expect(screen.getByText("grid.other")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "grid.edit(Bo Ek|5|15:00|15:15)" })).toBeInTheDocument();
  });

  it("states each teacher's minutes against the ram their Rastvakt uppdrag set", () => {
    render(<SupervisionPage />);
    const table = screen.getByRole("table", { name: "caption" });
    expect(within(table).getByRole("row", { name: /Anna Lind/ })).toHaveTextContent("under(40)");
    expect(within(table).getByRole("row", { name: /Bo Ek/ })).toHaveTextContent("noRam");
  });

  it("opens a new pass from a gap with the break's time, and saves it in the year", async () => {
    const user = userEvent.setup();
    render(<SupervisionPage />);
    await user.click(screen.getByRole("button", { name: "add(Skolgården|2|10:00)" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("start")).toHaveValue("10:00");
    expect(within(dialog).getByLabelText("end")).toHaveValue("10:20");
    // A gap all year leaves the pass undated.
    expect(within(dialog).getByLabelText(/validFrom/)).toHaveValue("");
    await user.click(within(dialog).getByRole("combobox", { name: "teacher" }));
    await user.click(await screen.findByRole("option", { name: "Bo Ek" }));
    await user.click(within(dialog).getByRole("button", { name: "save" }));
    expect(mutations.createShift).toHaveBeenCalledWith({
      academicYearId: YEAR.id,
      areaId: "garden",
      userId: "bo",
      dayOfWeek: 2,
      startTime: "10:00",
      endTime: "10:20",
      validFrom: null,
      validTo: null,
      note: null,
    });
  });

  it("seeds a gap's own dates when it is short only part of the year", async () => {
    const user = userEvent.setup();
    render(<SupervisionPage />);
    await user.click(screen.getByRole("button", { name: "add(Skolgården|3|10:00)" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(/validFrom/)).toHaveValue("2027-01-07");
    expect(within(dialog).getByLabelText(/validTo/)).toHaveValue("2027-06-11");
  });

  it("offers only active staff a pass", async () => {
    const user = userEvent.setup();
    render(<SupervisionPage />);
    await user.click(screen.getByRole("button", { name: "addShift" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: "teacher" }));
    // By surname, as every teacher list is.
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Bo Ek", "Anna Lind"]);
  });

  it("lets a läsare read every pass by name, with no control that opens a form", () => {
    state.readOnly = true;
    render(<SupervisionPage />);
    expect(screen.getAllByText("Anna Lind").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /grid\.edit/ })).not.toBeInTheDocument();
    // What remains of the writing controls is marked for planering, which the läsare's style hides.
    for (const button of screen.getAllByRole("button")) {
      expect(button.closest("[data-writes]")).not.toBeNull();
    }
  });

  it("asks for areas before passes, and says the year has none", () => {
    state.rota = { ...ROTA, areas: [], shifts: [], breaks: [], gaps: [], teachers: [] };
    render(<SupervisionPage />);
    expect(screen.getByText("noAreasTitle")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "addShift" })).toBeDisabled();
  });
});
