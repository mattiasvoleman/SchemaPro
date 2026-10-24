import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { SupervisionArea, SupervisionGap, SupervisionRota } from "@/lib/supervision";
import SupervisionPage from "./page";

/**
 * Rastvaktsschema: the page draws the gateway's answer — the breaks short of
 * rastvakter first, each area's grid of breaks by weekday with who watches
 * them, the teachers' minutes beside their ram — and a läsare reads it all
 * without a control that writes. The translator below prints a key with its
 * values ("grid.add(Skolgården|dayName(1)|10:00)"), so a test reads what
 * the page put into each sentence.
 */

// The area dialog's Switch measures itself; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

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
const gap = (dayOfWeek: number, rest: Partial<SupervisionGap>): SupervisionGap => ({
  ...brk(dayOfWeek),
  fewest: 0,
  shortFrom: "10:00",
  shortTo: "10:20",
  from: "2026-08-18",
  to: "2027-06-08",
  fromYearStart: true,
  toYearEnd: true,
  ...rest,
});
const shiftRow = (id: string, userId: string, dayOfWeek: number, startTime: string, endTime: string, rest: Record<string, unknown> = {}) => ({
  id,
  academicYearId: YEAR.id,
  areaId: "garden",
  userId,
  dayOfWeek,
  startTime,
  endTime,
  validFrom: null,
  validTo: null,
  note: null,
  inactiveFrom: null,
  lessonClashes: [],
  ...rest,
});
const ROTA: SupervisionRota = {
  academicYearId: YEAR.id,
  year: { startDate: YEAR.startDate, endDate: YEAR.endDate },
  areas: [GARDEN],
  shifts: [
    shiftRow("s1", "anna", 1, "10:00", "10:20"),
    shiftRow("s2", "bo", 3, "10:00", "10:10", { validFrom: "2027-01-13" }),
    shiftRow("bus", "bo", 5, "15:00", "15:15"),
    // Cilla left in January: her Thursday is listed and watches until the day before.
    shiftRow("s3", "cilla", 4, "10:00", "10:20", { inactiveFrom: "2027-01-11" }),
  ],
  breaks: [brk(1, ["s1"]), brk(2), brk(3, ["s2"]), brk(4, ["s3"]), brk(5)],
  gaps: [
    gap(2, {}),
    gap(3, { shortFrom: "10:10", from: "2027-01-13", fromYearStart: false }),
    gap(3, { from: "2026-08-19", to: "2027-01-06", toYearEnd: false }),
    gap(4, {}),
    gap(5, {}),
  ],
  teachers: [
    { userId: "bo", shiftCount: 2, minutesPerWeek: 20, countedMinutesPerWeek: 0, peakMinutesPerWeek: 25, hoursPerYear: 12.2, ramMinutesPerWeek: null, ramCountedMinutesPerWeek: 0 },
    { userId: "anna", shiftCount: 1, minutesPerWeek: 20, countedMinutesPerWeek: 0, peakMinutesPerWeek: 20, hoursPerYear: 12.7, ramMinutesPerWeek: 60, ramCountedMinutesPerWeek: 0 },
  ],
};

const mutations = vi.hoisted(() => ({
  createShift: vi.fn(),
  updateShift: vi.fn(),
  removeShift: vi.fn(),
  createArea: vi.fn(),
}));
const state = vi.hoisted(() => ({ rota: undefined as SupervisionRota | undefined, readOnly: false, has: false }));

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
    isLoading: false,
    isError: false,
    data: [
      { id: "anna", role: "TEACHER", firstName: "Anna", lastName: "Lind", isActive: true },
      { id: "bo", role: "TEACHER", firstName: "Bo", lastName: "Ek", isActive: true },
      { id: "cilla", role: "TEACHER", firstName: "Cilla", lastName: "Ås", isActive: false },
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
    t.has = () => state.has;
    return t;
  },
}));

beforeEach(() => {
  state.rota = ROTA;
  state.readOnly = false;
  state.has = false;
  for (const mock of Object.values(mutations)) mock.mockReset().mockResolvedValue({});
});

const grid = () => screen.getByRole("table", { name: "grid.caption(Skolgården)" });

describe("SupervisionPage", () => {
  it("lists the breaks short first, before the grids, counting a break short in two stretches once", () => {
    render(<SupervisionPage />);
    // The card's own translator is the namespace's: its keys come unprefixed.
    const gaps = screen.getByRole("region", { name: "count(4)" });
    expect(gaps.compareDocumentPosition(grid()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(gaps).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("nobody(10:00|10:20) wholeYear"),
      expect.stringContaining("nobody(10:00|10:20) to(2027-01-06)"),
      expect.stringContaining("nobody(10:10|10:20) from(2027-01-13)"),
      expect.stringContaining("nobody(10:00|10:20) wholeYear"),
      expect.stringContaining("nobody(10:00|10:20) wholeYear"),
    ]);
    // A weekday inside a sentence is the lower-case name.
    expect(within(gaps).getAllByRole("listitem")[0]).toHaveTextContent("where(Skolgården|dayName(2)|10:00|10:20)");
  });

  it("says nothing of gaps when no break needs a rastvakt", () => {
    state.rota = { ...ROTA, breaks: ROTA.breaks.map((row) => ({ ...row, needed: 0 })), gaps: [] };
    render(<SupervisionPage />);
    expect(screen.queryByText("gaps.none")).not.toBeInTheDocument();
    expect(screen.queryByText("none")).not.toBeInTheDocument();
  });

  it("draws an area's breaks by weekday with who watches them, only the short cells marked, and a pass in no break apart", () => {
    render(<SupervisionPage />);
    const cells = within(within(grid()).getByRole("row", { name: /10:00–10:20/ })).getAllByRole("cell");
    expect(cells[0]).toHaveTextContent("Anna Lind");
    expect(cells[0]).not.toHaveTextContent("grid.short");
    expect(cells[1]).toHaveTextContent("grid.short");
    // Bo's Wednesday pass is shorter than the break and dated: both are said.
    expect(cells[2]).toHaveTextContent("Bo Ek");
    expect(cells[2]).toHaveTextContent("grid.passTime(10:00|10:10)");
    expect(cells[2]).toHaveTextContent("grid.from(2027-01-13)");
    // A deactivated teacher's pass is listed as theirs, from when it stopped watching, and the break is short.
    expect(cells[3]).toHaveTextContent("grid.inactiveFrom(Cilla Ås|2027-01-11)");
    expect(cells[3]).toHaveTextContent("grid.short");
    expect(screen.getByText("grid.other")).toBeInTheDocument();
    // Each pass's button says the pass, dates included.
    expect(screen.getByRole("button", { name: "grid.edit(Bo Ek|dayName(3)|10:00|10:10), grid.from(2027-01-13)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "grid.edit(Bo Ek|dayName(5)|15:00|15:15)" })).toBeInTheDocument();
  });

  it("states each teacher's minutes against the ram, by surname", () => {
    render(<SupervisionPage />);
    const table = screen.getByRole("table", { name: "caption" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[0]!.textContent)).toEqual(["Bo Ek", "Anna Lind"]);
    expect(rows[1]).toHaveTextContent("under(40)");
    expect(rows[0]).toHaveTextContent("noRam");
  });

  it("opens a new pass from a gap with the break's time, and saves it in the year", async () => {
    const user = userEvent.setup();
    render(<SupervisionPage />);
    await user.click(screen.getByRole("button", { name: "add(Skolgården|dayName(2)|10:00)" }));
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

  it("seeds a gap's own dates where it does not reach the year's bound, and leaves the bound it reaches empty", async () => {
    const user = userEvent.setup();
    render(<SupervisionPage />);
    // Wednesday's two gaps, in date order: the autumn from the year's start, the spring to its end.
    const [autumn, spring] = screen.getAllByRole("button", { name: "add(Skolgården|dayName(3)|10:00)" });
    await user.click(autumn!);
    let dialog = await screen.findByRole("dialog");
    expect([within(dialog).getByLabelText(/validFrom/), within(dialog).getByLabelText(/validTo/)].map((field) => (field as HTMLInputElement).value)).toEqual([
      "",
      "2027-01-06",
    ]);
    await user.click(within(dialog).getByRole("button", { name: "cancel" }));
    await user.click(spring!);
    dialog = await screen.findByRole("dialog");
    expect([within(dialog).getByLabelText(/validFrom/), within(dialog).getByLabelText(/validTo/)].map((field) => (field as HTMLInputElement).value)).toEqual([
      "2027-01-13",
      "",
    ]);
  });

  it("names the teacher's other pass before the save, says it beside the teacher and puts focus there", async () => {
    const user = userEvent.setup();
    render(<SupervisionPage />);
    await user.click(screen.getByRole("button", { name: "grid.add(Skolgården|dayName(1)|10:00)" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: "teacher" }));
    await user.click(await screen.findByRole("option", { name: "Anna Lind" }));
    expect(within(dialog).getByText("faults.clash(Skolgården|dayName(1)|10:00|10:20)")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "save" }));
    expect(mutations.createShift).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("combobox", { name: "teacher" })).toHaveFocus();
    expect(within(dialog).getByRole("combobox", { name: "teacher" })).toHaveAttribute("aria-invalid", "true");
  });

  it("offers only active staff a new pass, and an edited pass keeps its own deactivated teacher", async () => {
    const user = userEvent.setup();
    render(<SupervisionPage />);
    await user.click(screen.getByRole("button", { name: "addShift" }));
    let dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: "teacher" }));
    // By surname, as every teacher list is; no pupil, nobody deactivated.
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Bo Ek", "Anna Lind"]);
    await user.keyboard("{Escape}");
    await user.click(within(dialog).getByRole("button", { name: "cancel" }));

    await user.click(screen.getByRole("button", { name: "grid.edit(grid.inactiveFrom(Cilla Ås|2027-01-11)|dayName(4)|10:00|10:20)" }));
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("combobox", { name: "teacher" })).toHaveTextContent("grid.inactive(Cilla Ås)");
    // The dialog says from when her pass stopped watching, by her name alone.
    expect(within(dialog).getByText("inactiveNotice(Cilla Ås|2027-01-11)")).toBeInTheDocument();
  });

  it("says a pass of a teacher deactivated before it began watches nothing, and keeps quiet about one that ended before", async () => {
    state.rota = {
      ...ROTA,
      shifts: ROTA.shifts.map((row) =>
        row.id === "s3" ? { ...row, validFrom: "2027-02-04" } : row.id === "s1" ? { ...row, validTo: "2026-12-14", inactiveFrom: "2027-01-11" } : row,
      ),
    };
    const user = userEvent.setup();
    render(<SupervisionPage />);
    await user.click(screen.getByRole("button", { name: /^grid\.edit\(grid\.inactiveFrom\(Cilla Ås\|2027-01-11\)\|dayName\(4\)/ }));
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("inactiveNoticeNever(Cilla Ås|2027-01-11)")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "cancel" }));
    await user.click(screen.getByRole("button", { name: /^grid\.edit\(grid\.inactiveFrom\(Anna Lind\|2027-01-11\)\|dayName\(1\)/ }));
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText(/inactiveNotice/)).not.toBeInTheDocument();
  });

  it("moves a stored pass's dates to the new weekday within their week", async () => {
    state.rota = {
      ...ROTA,
      shifts: ROTA.shifts.map((row) => (row.id === "s1" ? { ...row, validFrom: "2027-01-11", validTo: "2027-03-01" } : row)),
    };
    const user = userEvent.setup();
    render(<SupervisionPage />);
    await user.click(screen.getByRole("button", { name: /^grid\.edit\(Anna Lind\|dayName\(1\)/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: "day" }));
    await user.click(await screen.findByRole("option", { name: "3" }));
    expect([within(dialog).getByLabelText(/validFrom/), within(dialog).getByLabelText(/validTo/)].map((field) => (field as HTMLInputElement).value)).toEqual([
      "2027-01-13",
      "2027-03-03",
    ]);
  });

  it("marks a pass during the teacher’s lesson in the grid, and says it when the pass is opened", async () => {
    const lesson = { subject: "Matematik", group: "8A", dayOfWeek: 1, startTime: "10:00", endTime: "11:00" };
    state.rota = { ...ROTA, shifts: ROTA.shifts.map((row) => (row.id === "s1" ? { ...row, lessonClashes: [lesson] } : row)) };
    const user = userEvent.setup();
    render(<SupervisionPage />);
    const monday = within(within(grid()).getByRole("row", { name: /10:00–10:20/ })).getAllByRole("cell")[0]!;
    expect(monday).toHaveTextContent("grid.duringLesson(Matematik 8A)");
    await user.click(screen.getByRole("button", { name: "grid.edit(Anna Lind|dayName(1)|10:00|10:20), grid.duringLesson(Matematik 8A)" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("lessonClashTitle")).toBeInTheDocument();
    expect(within(dialog).getByText("lessonClashItem(Matematik|8A|dayName(1)|10:00|11:00)")).toBeInTheDocument();
  });

  it("keeps the dialog open to say a saved pass runs during the teacher’s lesson", async () => {
    mutations.createShift.mockResolvedValue({
      ...shiftRow("new", "bo", 2, "10:00", "10:20"),
      lessonClashes: [{ subject: "Svenska", group: "7A", dayOfWeek: 2, startTime: "09:40", endTime: "10:40" }],
    });
    const user = userEvent.setup();
    render(<SupervisionPage />);
    await user.click(screen.getByRole("button", { name: "add(Skolgården|dayName(2)|10:00)" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: "teacher" }));
    await user.click(await screen.findByRole("option", { name: "Bo Ek" }));
    await user.click(within(dialog).getByRole("button", { name: "save" }));
    expect(mutations.createShift).toHaveBeenCalled();
    expect(await within(dialog).findByText("lessonClashSavedTitle")).toBeInTheDocument();
    expect(within(dialog).getByText("lessonClashItem(Svenska|7A|dayName(2)|09:40|10:40)")).toBeInTheDocument();
    // The footer's Stäng has focus (the dialog's own corner button is the other one).
    const closers = within(dialog).getAllByRole("button", { name: "close" });
    expect(closers).toContain(document.activeElement);
    await user.click(document.activeElement as HTMLElement);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("says the gateway’s refusal of a field beside it and puts focus there", async () => {
    mutations.updateShift.mockRejectedValue(
      new ApiError(400, "validTo: ingen måndag ligger mellan 2027-06-08 och 2027-06-11, så passet skulle aldrig gå."),
    );
    const user = userEvent.setup();
    render(<SupervisionPage />);
    await user.click(screen.getByRole("button", { name: "grid.edit(Anna Lind|dayName(1)|10:00|10:20)" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "save" }));
    const till = within(dialog).getByLabelText(/validTo/);
    expect(await within(dialog).findByText("ingen måndag ligger mellan 2027-06-08 och 2027-06-11, så passet skulle aldrig gå.")).toBeInTheDocument();
    expect(till).toHaveFocus();
    expect(till).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).queryByText("saveFailed")).not.toBeInTheDocument();
  });

  it("says where a typed date is not the pass’s weekday when the pass first runs, and sends that day", async () => {
    const user = userEvent.setup();
    render(<SupervisionPage />);
    await user.click(screen.getByRole("button", { name: "add(Skolgården|dayName(2)|10:00)" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: "teacher" }));
    await user.click(await screen.findByRole("option", { name: "Bo Ek" }));
    // A Tuesday pass from Thursday 7 January runs first on the 12th.
    await user.type(within(dialog).getByLabelText(/validFrom/), "2027-01-07");
    expect(within(dialog).getByText("firstRun(2027-01-12)")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "save" }));
    expect(mutations.createShift).toHaveBeenCalledWith(expect.objectContaining({ validFrom: "2027-01-12" }));
  });

  it("edits a pass with its id and every field, and removes one after asking", async () => {
    const user = userEvent.setup();
    render(<SupervisionPage />);
    await user.click(screen.getByRole("button", { name: "grid.edit(Anna Lind|dayName(1)|10:00|10:20)" }));
    const dialog = await screen.findByRole("dialog");
    await user.clear(within(dialog).getByLabelText("end"));
    await user.type(within(dialog).getByLabelText("end"), "10:25");
    await user.click(within(dialog).getByRole("button", { name: "save" }));
    expect(mutations.updateShift).toHaveBeenCalledWith({
      id: "s1",
      areaId: "garden",
      userId: "anna",
      dayOfWeek: 1,
      startTime: "10:00",
      endTime: "10:25",
      validFrom: null,
      validTo: null,
      note: null,
    });

    await user.click(screen.getByRole("button", { name: "grid.edit(Anna Lind|dayName(1)|10:00|10:20)" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "delete" }));
    await user.click(await screen.findByRole("button", { name: "delete" }));
    expect(mutations.removeShift).toHaveBeenCalledWith("s1");
  });

  it("says a refusal the gateway names by its code in the reader's language", async () => {
    state.has = true;
    mutations.createShift.mockRejectedValue(new ApiError(409, "Läraren har redan rastvakt…", "SUPERVISION_SHIFT_CLASH"));
    const user = userEvent.setup();
    render(<SupervisionPage />);
    await user.click(screen.getByRole("button", { name: "add(Skolgården|dayName(2)|10:00)" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: "teacher" }));
    await user.click(await screen.findByRole("option", { name: "Bo Ek" }));
    await user.click(within(dialog).getByRole("button", { name: "save" }));
    // At the teacher, where the clash is, not above the form.
    expect(await within(dialog).findByText("errors.SUPERVISION_SHIFT_CLASH")).toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: "teacher" })).toHaveFocus();
    expect(within(dialog).getByRole("combobox", { name: "teacher" })).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).queryByText("saveFailed")).not.toBeInTheDocument();
  });

  it("says a name another area has beside the name, and puts focus there", async () => {
    state.has = true;
    mutations.createArea.mockRejectedValue(new ApiError(409, "Skolan har redan…", "SUPERVISION_AREA_NAME_TAKEN"));
    const user = userEvent.setup();
    render(<SupervisionPage />);
    await user.click(screen.getByRole("button", { name: "areas.add" }));
    const dialog = await screen.findByRole("dialog");
    // The field says the name is the school's, sites included.
    expect(within(dialog).getByText("nameHint")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/name/), "Skolgården");
    await user.click(within(dialog).getByRole("button", { name: "save" }));
    expect(await within(dialog).findByText("errors.SUPERVISION_AREA_NAME_TAKEN")).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/name/)).toHaveFocus();
    expect(within(dialog).getByLabelText(/name/)).toHaveAttribute("aria-invalid", "true");
  });

  it("adds an area with the defaults, and says an empty name rather than greying the button", async () => {
    const user = userEvent.setup();
    render(<SupervisionPage />);
    await user.click(screen.getByRole("button", { name: "areas.add" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "save" }));
    expect(within(dialog).getByText("nameMissing")).toBeInTheDocument();
    expect(mutations.createArea).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText(/name/), "Matsalen");
    await user.click(within(dialog).getByRole("button", { name: "save" }));
    expect(mutations.createArea).toHaveBeenCalledWith({
      name: "Matsalen",
      siteId: null,
      minGradeLevel: null,
      maxGradeLevel: null,
      duringRasts: true,
      duringLunch: false,
      guardsNeeded: 1,
      countsAsTeaching: false,
    });
  });

  it("lets a läsare read every pass by name, in the grid and apart, with no control that opens a form", () => {
    state.readOnly = true;
    render(<SupervisionPage />);
    expect(within(grid()).getByText("Anna Lind")).toBeInTheDocument();
    expect(within(grid()).getByText("Bo Ek")).toBeInTheDocument();
    const apart = screen.getByText("grid.other").parentElement!;
    expect(within(apart).getByText("Bo Ek")).toBeInTheDocument();
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
