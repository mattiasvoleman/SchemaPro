import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SchoolCalendarDialog } from "./school-calendar-dialog";
import type { SchoolBreak } from "@/lib/types";

// Radix needs these in jsdom to open a Dialog — environment, not behaviour under test.
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
 * What this file guards. A lov saved DELETES published lessons, so the dialog's whole job is to show, before the save,
 * which rows it will make and how many lessons they take: a row ticked that is not sent, a row sent that was unticked,
 * a SAME or COVERED row sent anyway (the gateway would answer UNCHANGED, but a row that is not in the body cannot take
 * a lesson), and a count that is asked for the wrong rows are the failures, and none of them show on a screen.
 */

const YEAR = { id: "y1", name: "2026/2027", startDate: "2026-08-17", endDate: "2027-06-11" };

const lov = (over: Partial<SchoolBreak> & { name: string }): SchoolBreak => ({
  id: `b-${over.name}`,
  academicYearId: "y1",
  kind: "HOLIDAY",
  startDate: "2026-10-26",
  endDate: "2026-10-30",
  minGradeLevel: null,
  maxGradeLevel: null,
  ...over,
});

const queries = vi.hoisted(() => ({
  count: { data: undefined as unknown, isPending: false, isError: false },
  seenBodies: [] as Array<{ breaks: Array<{ name: string; id?: string }>; dryRun: boolean }>,
  apply: vi.fn(),
}));
vi.mock("@/lib/school-calendar-queries", () => ({
  useSchoolCalendarCount: (body: { breaks: Array<{ name: string; id?: string }>; dryRun: boolean }, enabled: boolean) => {
    if (enabled) queries.seenBodies.push(body);
    return queries.count;
  },
  useApplySchoolCalendar: () => ({ mutateAsync: queries.apply, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}(${Object.values(values).join("|")})` : key),
}));

const COUNTED = { dryRun: true, created: 8, updated: 0, unchanged: 0, removedCalendarLessons: 14, items: [] };

const open = (breaks: SchoolBreak[] = [lov({ name: "Höstlov" })], onSaved = vi.fn()) => {
  render(<SchoolCalendarDialog open onOpenChange={vi.fn()} year={YEAR} breaks={breaks} onSaved={onSaved} />);
  return { onSaved };
};

const rows = () => screen.getAllByRole("row").slice(1);
const rowOf = (name: string) => rows().find((row) => within(row).queryByText(name))!;
const lastBody = () => queries.seenBodies.at(-1)!;

beforeEach(() => {
  queries.count = { data: COUNTED, isPending: false, isError: false };
  queries.seenBodies = [];
  queries.apply.mockReset();
  queries.apply.mockResolvedValue({ ...COUNTED, dryRun: false });
});

describe("the school calendar dialog", () => {
  it("shows the year's red days that fall on a school day, each as a lov to add, and asks for their count", () => {
    open();
    expect(rows().map((row) => within(row).getAllByRole("cell")[1]!.textContent)).toEqual([
      "Julafton",
      "Juldagen",
      "Nyårsafton",
      "Nyårsdagen",
      "Trettondedag jul",
      "Långfredagen",
      "Annandag påsk",
      "Kristi himmelsfärdsdag",
    ]);
    for (const row of rows()) expect(within(row).getByRole("checkbox")).toBeChecked();
    expect(lastBody()).toMatchObject({ dryRun: true });
    expect(lastBody().breaks.map((row) => row.name)).toHaveLength(8);
    expect(screen.getByRole("status")).toHaveTextContent("willSave(8|14)");
  });

  it("makes no proposal for a year that has lov, and proposes the year's lov for one that has none", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<SchoolCalendarDialog open onOpenChange={vi.fn()} year={YEAR} breaks={[lov({ name: "Höstlov" })]} onSaved={vi.fn()} />);
    expect(screen.queryByText("Sportlov")).toBeNull();
    await user.click(screen.getByLabelText(/^proposals/));
    expect(rowOf("Sportlov")).toBeDefined();
    unmount();
    render(<SchoolCalendarDialog open onOpenChange={vi.fn()} year={YEAR} breaks={[]} onSaved={vi.fn()} />);
    expect(["Höstlov", "Jullov", "Sportlov", "Påsklov"].map((name) => within(rowOf(name)).getByRole("checkbox"))).toHaveLength(4);
  });

  it("covers a red day inside a lov the year has, and leaves it unticked and unsent", () => {
    open([lov({ name: "Jullov", startDate: "2026-12-21", endDate: "2027-01-06" })]);
    const julafton = rowOf("Julafton");
    expect(julafton).toHaveTextContent("status.COVERED(Jullov)");
    expect(within(julafton).getByRole("checkbox")).toBeDisabled();
    expect(within(julafton).getByRole("checkbox")).not.toBeChecked();
    expect(lastBody().breaks.map((row) => row.name)).toEqual(["Långfredagen", "Annandag påsk", "Kristi himmelsfärdsdag"]);
  });

  it("sends what is ticked and nothing else, and asks for the count of exactly that", async () => {
    const user = userEvent.setup();
    open();
    await user.click(within(rowOf("Julafton")).getByRole("checkbox"));
    await user.click(within(rowOf("Nyårsafton")).getByRole("checkbox"));
    expect(lastBody().breaks.map((row) => row.name)).toEqual(["Juldagen", "Nyårsdagen", "Trettondedag jul", "Långfredagen", "Annandag påsk", "Kristi himmelsfärdsdag"]);
    await user.click(screen.getByRole("button", { name: /^save/ }));
    await waitFor(() => expect(queries.apply).toHaveBeenCalledTimes(1));
    const body = queries.apply.mock.calls[0]![0] as { dryRun: boolean; academicYearId: string; breaks: Array<{ name: string }> };
    expect(body).toMatchObject({ academicYearId: "y1", dryRun: false });
    expect(body.breaks.map((row) => row.name)).toEqual(["Juldagen", "Nyårsdagen", "Trettondedag jul", "Långfredagen", "Annandag påsk", "Kristi himmelsfärdsdag"]);
  });

  it("hands the page what the save answered with, and closes", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onSaved = vi.fn();
    render(<SchoolCalendarDialog open onOpenChange={onOpenChange} year={YEAR} breaks={[]} onSaved={onSaved} />);
    await user.click(screen.getByRole("button", { name: /^save/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ...COUNTED, dryRun: false }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("says the lessons it takes before the save, and the warning that they do not come back", () => {
    open();
    expect(screen.getByRole("status")).toHaveTextContent("willSave(8|14)");
    expect(screen.getByText("deletesWarning")).toBeInTheDocument();
  });

  it("says nothing is taken, and shows no warning, when the count is zero", () => {
    queries.count = { data: { ...COUNTED, removedCalendarLessons: 0 }, isPending: false, isError: false };
    open();
    expect(screen.getByRole("status")).toHaveTextContent("willSave(8|0)");
    expect(screen.queryByText("deletesWarning")).toBeNull();
  });

  it("says it is counting while it is, and that it could not when it could not, and still lets the save go", () => {
    queries.count = { data: undefined, isPending: true, isError: false };
    const first = render(<SchoolCalendarDialog open onOpenChange={vi.fn()} year={YEAR} breaks={[]} onSaved={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("counting");
    first.unmount();
    queries.count = { data: undefined, isPending: false, isError: true };
    render(<SchoolCalendarDialog open onOpenChange={vi.fn()} year={YEAR} breaks={[]} onSaved={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("countFailed");
    expect(screen.getByRole("button", { name: /^save/ })).toBeEnabled();
  });

  it("offers nothing to save when every red day is there already, and disables the button", async () => {
    const user = userEvent.setup();
    open([lov({ name: "Allt", startDate: "2026-08-17", endDate: "2027-06-11" })]);
    expect(screen.getByRole("status")).toHaveTextContent("nothingToAdd");
    expect(screen.getByRole("button", { name: /^save/ })).toBeDisabled();
    await user.click(screen.getByLabelText(/^holidays/));
    expect(screen.queryAllByRole("row")).toHaveLength(0);
    expect(screen.getByText("nothingChosen")).toBeInTheDocument();
  });

  describe("a municipality's file", () => {
    const upload = async (user: ReturnType<typeof userEvent.setup>, text: string, name: string) => {
      const input = screen.getByLabelText("chooseFile") as HTMLInputElement;
      await user.upload(input, new File([text], name, { type: name.endsWith(".ics") ? "text/calendar" : "text/csv" }));
    };

    it("reads an ICS file into rows measured against the school's lov: a move, a new row, and what the school has that the file does not", async () => {
      const user = userEvent.setup();
      open([lov({ name: "Höstlov" }), lov({ name: "Friluftsdag", startDate: "2027-05-20", endDate: "2027-05-20" })]);
      await user.click(screen.getByLabelText(/^holidays/));
      await upload(
        user,
        ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20261102", "DTEND;VALUE=DATE:20261107", "SUMMARY:Höstlov", "END:VEVENT", "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20270301", "DTEND;VALUE=DATE:20270306", "SUMMARY:Sportlov", "END:VEVENT", "END:VCALENDAR"].join("\r\n"),
        "kommunen.ics",
      );
      await waitFor(() => expect(screen.getByText("Sportlov")).toBeInTheDocument());
      expect(rowOf("Höstlov")).toHaveTextContent("status.CHANGED(2026-10-26 – 2026-10-30)");
      expect(rowOf("Sportlov")).toHaveTextContent("status.NEW");
      expect(screen.getByText(/^onlyHere\(Friluftsdag\)/)).toBeInTheDocument();
      // A moved lov goes by its id, a new one without.
      expect(lastBody().breaks).toEqual([expect.objectContaining({ name: "Höstlov", id: "b-Höstlov" }), expect.not.objectContaining({ id: expect.anything() })]);
    });

    it("leaves a row that reads as a term date unticked, and sends it only once it is ticked", async () => {
      const user = userEvent.setup();
      open([]);
      await user.click(screen.getByLabelText(/^holidays/));
      await user.click(screen.getByLabelText(/^proposals/));
      await upload(user, "namn;start;slut\nTerminsstart;2026-08-17;2026-08-17\nHöstlov;2026-10-26;2026-10-30\n", "lov.csv");
      await waitFor(() => expect(screen.getByText("Terminsstart")).toBeInTheDocument());
      expect(within(rowOf("Terminsstart")).getByRole("checkbox")).not.toBeChecked();
      expect(lastBody().breaks.map((row) => row.name)).toEqual(["Höstlov"]);
      await user.click(within(rowOf("Terminsstart")).getByRole("checkbox"));
      expect(lastBody().breaks.map((row) => row.name).sort()).toEqual(["Höstlov", "Terminsstart"]);
    });

    it("names what in the file could not be read, with its place", async () => {
      const user = userEvent.setup();
      open();
      await upload(user, "namn;start;slut\nA;inte-ett-datum;\nB;2026-11-02;2026-11-03\n", "x.csv");
      await waitFor(() => expect(screen.getByText("problemsTitle(1)")).toBeInTheDocument());
      expect(screen.getByText("placeRow(2): problem.BAD_DATE(inte-ett-datum)")).toBeInTheDocument();
    });

    it("lets the file go, and the rows with it", async () => {
      const user = userEvent.setup();
      open();
      await upload(user, "namn;start;slut\nB;2026-11-02;2026-11-03\n", "x.csv");
      await waitFor(() => expect(screen.getByText("B")).toBeInTheDocument());
      await user.click(screen.getByRole("button", { name: "removeFile" }));
      expect(screen.queryByText("B")).toBeNull();
    });
  });
});
