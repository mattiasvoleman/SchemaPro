import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BreaksPage from "./page";

// Radix needs these in jsdom to open a Select or a Dialog — environment, not
// behaviour under test.
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
 * What this file is actually guarding.
 *
 * Saving a lov DELETES published calendar lessons. The endpoint answers with
 * how many, and the whole point of this page is that the number is said out
 * loud rather than left to be discovered by a teacher standing in an empty
 * classroom. Every failure mode of that is silent: a count read off the request
 * instead of the response, a notice rendered only when it is non-zero, a live
 * region mounted together with its text so no screen reader announces it, a
 * sentence that scrolls away with the toast. So the assertions read the exact
 * string the region holds, and never that "something was rendered".
 *
 * The other half is what gets SENT. The grade span is all-or-nothing at the
 * database, and half of it is refused — so a form that sends `minGradeLevel`
 * without its partner, or sends both when the admin chose the whole school,
 * fails in a way that only shows up against a real API.
 */

const year = {
  id: "y1",
  name: "2026/2027",
  isActive: true,
  startDate: "2026-08-17",
  endDate: "2027-06-11",
};

const NEXT_YEAR = {
  id: "y2",
  name: "2027/2028",
  isActive: false,
  startDate: "2027-08-16",
  endDate: "2028-06-09",
};

interface BreakFixture {
  id: string;
  academicYearId: string;
  name: string;
  kind: "HOLIDAY" | "STAFF_DAY";
  startDate: string;
  endDate: string;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
}

/**
 * A real Swedish läsår's opening pair, and the two shapes the list has to tell
 * apart: a multi-day school-wide lov, and a one-day studiedag narrowed to the
 * lower years. In the order the query returns them, earliest first.
 */
const HOSTLOV: BreakFixture = {
  id: "b-host",
  academicYearId: "y1",
  name: "Höstlov",
  kind: "HOLIDAY",
  startDate: "2026-10-26",
  endDate: "2026-10-30",
  minGradeLevel: null,
  maxGradeLevel: null,
};

const STUDIEDAG: BreakFixture = {
  id: "b-studie",
  academicYearId: "y1",
  name: "Studiedag",
  kind: "STAFF_DAY",
  startDate: "2027-01-08",
  endDate: "2027-01-08",
  minGradeLevel: 0,
  maxGradeLevel: 6,
};

interface QueryState<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
}

const loaded = <T,>(data: T): QueryState<T> => ({
  data,
  isLoading: false,
  isError: false,
});
const pending = <T,>(): QueryState<T> => ({
  data: undefined,
  isLoading: true,
  isError: false,
});
/**
 * A query that has GIVEN UP — data-less and NOT loading, because `isLoading` is
 * `isPending && isFetching` and an errored query is neither. Indistinguishable
 * from an empty answer to anything reading `data`, which is exactly why the
 * page needs a second gate and this needs to be its own fixture.
 */
const failed = <T,>(): QueryState<T> => ({
  data: undefined,
  isLoading: false,
  isError: true,
});
/** What useSchoolBreaks is while no läsår has been picked. */
const disabled = <T,>(): QueryState<T> => ({
  data: undefined,
  isLoading: false,
  isError: false,
});

/**
 * The third row exists to make the ordering test able to fail.
 *
 * With only Höstlov and Studiedag the two orders agree — H before S by name
 * and by date — so re-sorting the list alphabetically passed the ordering
 * assertion unnoticed. Found by mutation. Påsklov falls after Studiedag in the
 * calendar and before it in the alphabet, so the two orders now disagree and
 * only one of them is right.
 */
const PASKLOV: BreakFixture = {
  id: "b-pask",
  academicYearId: "y1",
  name: "Påsklov",
  kind: "HOLIDAY",
  startDate: "2027-03-29",
  endDate: "2027-04-05",
  minGradeLevel: null,
  maxGradeLevel: null,
};

const freshState = () => ({
  years: loaded([year]),
  breaks: loaded([HOSTLOV, STUDIEDAG, PASKLOV]),
});

let state = freshState();

/**
 * Hoisted, so a test can read what was SENT and decide what the server ANSWERS.
 * The answer is the whole subject of half this file — the removed-lesson count
 * exists nowhere else.
 */
const { createMock, updateMock, removeMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  updateMock: vi.fn(),
  removeMock: vi.fn(),
}));

vi.mock("@/lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries")>()),
  useAcademicYears: () => state.years,
  useSchoolBreaks: () => state.breaks,
  useSchoolBreakActions: () => ({
    create: { mutateAsync: createMock, isPending: false },
    update: { mutateAsync: updateMock, isPending: false },
    remove: { mutateAsync: removeMock, isPending: false },
  }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("next-intl", () => ({
  // DateField reads the active locale for its month and weekday names.
  useLocale: () => "sv",
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join("|")})` : key;
    return t;
  },
}));

/** The live region, which is mounted from the first render whether or not it holds anything. */
const notice = () => screen.getByRole("status");

const rowFor = (name: string) => screen.getByText(name).closest("tr")!;
const cellsOf = (row: HTMLElement) =>
  [...row.querySelectorAll("td")].map((cell) => cell.textContent);

/** What the endpoint answers with — the row it wrote, plus the damage. */
const savedAs = (fixture: BreakFixture, removedCalendarLessons: number) => ({
  ...fixture,
  removedCalendarLessons,
});

const openCreate = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "addBreak" }));
  return user;
};

const fillDates = (from: string, to: string) => {
  fireEvent.change(screen.getByLabelText("startDate"), { target: { value: from } });
  fireEvent.change(screen.getByLabelText("endDate"), { target: { value: to } });
};

beforeEach(() => {
  state = freshState();
  createMock.mockReset().mockResolvedValue(savedAs(HOSTLOV, 0));
  updateMock.mockReset().mockResolvedValue(savedAs(HOSTLOV, 0));
  removeMock.mockReset().mockResolvedValue(undefined);
});

describe("Lovlistan", () => {
  it("shows each lov with its name, kind, dates and year span", () => {
    // Every cell, in order, against literals. A list that renders the right
    // number of rows with the wrong columns in them is the failure this page
    // can have without looking broken: dates and årskurser are the two fields
    // that decide which lessons get deleted.
    render(<BreaksPage />);

    expect(cellsOf(rowFor("Höstlov")).slice(0, 4)).toEqual([
      "Höstlov",
      "kindHoliday",
      "2026-10-26 – 2026-10-30",
      "gradeAll",
    ]);
    expect(cellsOf(rowFor("Studiedag")).slice(0, 4)).toEqual([
      "Studiedag",
      "kindStaffDay",
      // A single day, printed once. "2027-01-08 – 2027-01-08" is not wrong so
      // much as it is a sentence nobody would write, and it reads as a range
      // whose ends someone got wrong.
      "2027-01-08",
      "gradeRange(0|6)",
    ]);
  });

  it("keeps the order the query gave, earliest first", () => {
    // The query orders by startDate and so does the API; a third opinion here
    // would be a third place for it to drift. What is pinned is that the page
    // does not re-order at all — sorting by name would put Höstlov after
    // Studiedag and make a calendar read as a glossary.
    render(<BreaksPage />);

    const names = within(screen.getByRole("table"))
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelector("td")?.textContent);
    expect(names).toEqual(["Höstlov", "Studiedag", "Påsklov"]);
  });

  it("names both row actions after the lov they act on", () => {
    // Icon-only controls in a column of six. "Redigera" repeated six times
    // names nothing, and the one that deletes is the one worth being sure
    // about.
    render(<BreaksPage />);

    expect(screen.getByRole("button", { name: "editNamed(Höstlov)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "deleteNamed(Studiedag)" })).toBeTruthy();
  });

  it("names the table for a reader who arrives inside it", () => {
    // Table navigation lands in the grid, past the paragraph that says what
    // these rows do to the calendar.
    const { container } = render(<BreaksPage />);

    expect(container.querySelector("table > caption")?.textContent).toBe("tableCaption");
  });
});

describe("Vad som sägs när lektioner försvinner", () => {
  it("mounts the live region before there is anything to announce", () => {
    // A region added to the DOM together with its text is not announced by
    // most screen readers — the region has to already be there for the change
    // to be a change. So an implementation that renders the whole block only
    // when `notice` is set says nothing to the reader who most needs it, while
    // looking perfect on screen.
    render(<BreaksPage />);

    expect(notice().getAttribute("aria-live")).toBe("polite");
    expect(notice().getAttribute("aria-atomic")).toBe("true");
    expect(notice().textContent).toBe("");
  });

  it("says how many published lessons a new lov threw away", async () => {
    // The sentence this page exists for. 42 is the server's count, from the
    // response and from nowhere else — the client cannot compute it, because
    // the protection rules (future, still SCHEDULED, no attendance recorded)
    // are applied inside the write's own transaction.
    createMock.mockResolvedValue(savedAs({ ...HOSTLOV, name: "Sportlov" }, 42));
    render(<BreaksPage />);
    const user = await openCreate();

    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Sportlov" } });
    fillDates("2027-02-22", "2027-02-26");
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(notice().textContent).toBe("removedLessons(Sportlov|42)");
  });

  it("says so when a lov removed nothing, rather than going quiet", async () => {
    // Silence would be ambiguous exactly where it must not be: an admin who
    // saved a sportlov and heard nothing cannot tell "no lessons were
    // published for that week" from "the deletion happened and nobody
    // mentioned it".
    createMock.mockResolvedValue(savedAs({ ...HOSTLOV, name: "Sportlov" }, 0));
    render(<BreaksPage />);
    const user = await openCreate();

    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Sportlov" } });
    fillDates("2027-02-22", "2027-02-26");
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(notice().textContent).toBe("removedNone(Sportlov)");
  });

  it("reports what a MOVE removed too, not only a create", async () => {
    // A move is a create all over again as far as the calendar is concerned —
    // the service purges on every update, deliberately — so an update that
    // reported nothing would be the same silent deletion by a different route.
    updateMock.mockResolvedValue(savedAs({ ...HOSTLOV, name: "Höstlov" }, 7));
    render(<BreaksPage />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "editNamed(Höstlov)" }));
    fillDates("2026-11-02", "2026-11-06");
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(notice().textContent).toBe("removedLessons(Höstlov|7)");
  });

  it("drops the notice when the year picker moves", async () => {
    // It describes a write against the year it was made in. Left up, "42
    // lektioner togs bort" would sit above a different läsår's list and read
    // as a claim about that one.
    state.years = loaded([year, NEXT_YEAR]);
    createMock.mockResolvedValue(savedAs({ ...HOSTLOV, name: "Sportlov" }, 42));
    render(<BreaksPage />);
    const user = await openCreate();

    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Sportlov" } });
    fillDates("2027-02-22", "2027-02-26");
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(notice().textContent).toBe("removedLessons(Sportlov|42)");

    await user.click(screen.getByRole("combobox", { name: "yearLabel" }));
    await user.click(screen.getByRole("option", { name: "2027/2028" }));

    expect(notice().textContent).toBe("");
  });

  it("warns before the save, where the half that cannot be undone still matters", async () => {
    // Narrowing a lov does not restore the lessons the wider version deleted —
    // they were rows, not a view. Afterwards is too late to say so.
    render(<BreaksPage />);
    await openCreate();

    expect(within(screen.getByRole("dialog")).getByText("deletesWarning")).toBeTruthy();
  });

  it("says on the delete confirm that the lessons do not come back", async () => {
    // Not tCommon("deleteConfirmBody") — "åtgärden kan inte ångras" is true of
    // the row and silent about the part that matters.
    render(<BreaksPage />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "deleteNamed(Höstlov)" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("deleteBody")).toBeTruthy();
    expect(within(dialog).queryByText("deleteConfirmBody")).toBeNull();
  });

  it("clears the notice when a lov is deleted, since deleting restores nothing", async () => {
    // The panel says what a SAVE removed. Leaving it up beside a list the row
    // has just left would read as if taking the lov away had undone it.
    createMock.mockResolvedValue(savedAs({ ...HOSTLOV, name: "Sportlov" }, 42));
    render(<BreaksPage />);
    const user = await openCreate();
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Sportlov" } });
    fillDates("2027-02-22", "2027-02-26");
    await user.click(screen.getByRole("button", { name: "save" }));

    await user.click(screen.getByRole("button", { name: "deleteNamed(Höstlov)" }));
    await user.click(screen.getByRole("button", { name: "delete" }));

    expect(removeMock).toHaveBeenCalledWith("b-host");
    expect(notice().textContent).toBe("");
  });
});

describe("Vad formuläret skickar", () => {
  it("sends a school-wide lov with both year bounds as null", async () => {
    // All or nothing: the table CHECKs the pair and the service refuses half of
    // it. Omitting them would leave the field alone on an update — which for a
    // lov that WAS narrowed means it silently stays narrowed.
    render(<BreaksPage />);
    const user = await openCreate();

    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Sportlov" } });
    fillDates("2027-02-22", "2027-02-26");
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0]).toEqual({
      academicYearId: "y1",
      name: "Sportlov",
      kind: "HOLIDAY",
      startDate: "2027-02-22",
      endDate: "2027-02-26",
      minGradeLevel: null,
      maxGradeLevel: null,
    });
  });

  it("trims the name before sending it", async () => {
    // The table CHECKs that the name is non-empty once trimmed, and a
    // constraint violation leaves as a 500 that names a constraint. " Sportlov "
    // would also be stored with its padding and then sort and print with it.
    render(<BreaksPage />);
    const user = await openCreate();

    fireEvent.change(screen.getByLabelText("name"), { target: { value: "  Sportlov  " } });
    fillDates("2027-02-22", "2027-02-26");
    await user.click(screen.getByRole("button", { name: "save" }));

    expect((createMock.mock.calls[0][0] as { name: string }).name).toBe("Sportlov");
  });

  it("sends a narrowed lov with both bounds as numbers", async () => {
    // Numbers, not the strings the selects hold: `@IsInt()` refuses "0", and
    // "0" is förskoleklass — a real year this app stores, and the one a falsy
    // check would drop.
    render(<BreaksPage />);
    const user = await openCreate();

    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Prao" } });
    fillDates("2027-03-01", "2027-03-05");
    await user.click(screen.getByRole("combobox", { name: "scope" }));
    await user.click(screen.getByRole("option", { name: "scopeGrades" }));
    await user.click(screen.getByRole("button", { name: "save" }));

    const sent = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.minGradeLevel).toBe(0);
    expect(sent.maxGradeLevel).toBe(6);
  });

  it("keeps the year span ordered as the admin picks it", async () => {
    // Picking a lower bound above the upper one is never what anybody meant,
    // and refusing it afterwards is a worse conversation than not letting it
    // happen. Same rule admin/constraints follows.
    render(<BreaksPage />);
    const user = await openCreate();

    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Prao" } });
    fillDates("2027-03-01", "2027-03-05");
    await user.click(screen.getByRole("combobox", { name: "scope" }));
    await user.click(screen.getByRole("option", { name: "scopeGrades" }));
    await user.click(screen.getByRole("combobox", { name: "gradeFromLabel" }));
    await user.click(screen.getByRole("option", { name: "grade(9)" }));
    await user.click(screen.getByRole("button", { name: "save" }));

    const sent = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.minGradeLevel).toBe(9);
    expect(sent.maxGradeLevel).toBe(9);
  });

  it("keeps the span ordered when the UPPER bound is dragged below the lower", async () => {
    // The other direction, which nothing covered. Raising the lower bound
    // pushed the upper one along; lowering the upper bound has to pull the
    // lower one back, or an inverted span reaches the API and is refused by a
    // DB CHECK as a 500 naming a constraint.
    render(<BreaksPage />);
    const user = await openCreate();

    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Prao" } });
    fillDates("2027-03-01", "2027-03-05");
    await user.click(screen.getByRole("combobox", { name: "scope" }));
    await user.click(screen.getByRole("option", { name: "scopeGrades" }));
    // Take the lower bound up to 9 first, then bring the upper bound down to 4.
    await user.click(screen.getByRole("combobox", { name: "gradeFromLabel" }));
    await user.click(screen.getByRole("option", { name: "grade(9)" }));
    await user.click(screen.getByRole("combobox", { name: "gradeToLabel" }));
    await user.click(screen.getByRole("option", { name: "grade(4)" }));
    await user.click(screen.getByRole("button", { name: "save" }));

    const sent = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.minGradeLevel).toBe(4);
    expect(sent.maxGradeLevel).toBe(4);
  });

  it("edits in place, without offering to move the lov to another läsår", async () => {
    // `academicYearId` is absent from the update DTO on purpose: moving a lov
    // to another year is not an edit, it is a different lov, and allowing it
    // would let the range escape the year it was validated against by changing
    // the other side.
    render(<BreaksPage />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "editNamed(Studiedag)" }));
    await user.click(screen.getByRole("button", { name: "save" }));

    const sent = updateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.id).toBe("b-studie");
    expect(Object.hasOwn(sent, "academicYearId")).toBe(false);
    // Opened on the row's own values, span included — an edit dialog that
    // silently resets the span to the default would widen a studiedag from
    // åk 0-6 to the whole school on a rename.
    expect(sent.minGradeLevel).toBe(0);
    expect(sent.maxGradeLevel).toBe(6);
    expect(sent.startDate).toBe("2027-01-08");
    expect(sent.endDate).toBe("2027-01-08");
    expect(sent.kind).toBe("STAFF_DAY");
  });

  it("lets a narrowed lov be widened back to the whole school", async () => {
    // The other direction, and the one the explicit nulls exist for. Without
    // it a studiedag entered for åk 0-6 can never be corrected.
    render(<BreaksPage />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "editNamed(Studiedag)" }));
    await user.click(screen.getByRole("combobox", { name: "scope" }));
    await user.click(screen.getByRole("option", { name: "scopeSchool" }));
    await user.click(screen.getByRole("button", { name: "save" }));

    const sent = updateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.minGradeLevel).toBeNull();
    expect(sent.maxGradeLevel).toBeNull();
    // Null, not absent: the DTO reads `undefined` as "leave it alone", so an
    // omitted field would make the narrowing permanent.
    expect(Object.hasOwn(sent, "minGradeLevel")).toBe(true);
  });

  it.each([
    ["a name that is only spaces", () => ({ name: "   ", from: "2027-02-22", to: "2027-02-26" })],
    ["no dates at all", () => ({ name: "Sportlov", from: "", to: "" })],
    // Refused here rather than by the API because the answer is instant and
    // the range is never what anybody meant. Whether the dates fall inside the
    // läsår is deliberately NOT checked here — that rule lives on the server,
    // and a copy is the one that goes stale.
    ["a range that runs backwards", () => ({ name: "Sportlov", from: "2027-02-26", to: "2027-02-22" })],
  ])("will not send %s", async (_which, build) => {
    const { name, from, to } = build();
    render(<BreaksPage />);
    const user = await openCreate();

    fireEvent.change(screen.getByLabelText("name"), { target: { value: name } });
    fillDates(from, to);

    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(createMock).not.toHaveBeenCalled();
  });

  it("does send once the form holds a range it can defend", () => {
    // The other half. Without it the three above are satisfied by a button
    // that is disabled always, which would be its own bug.
    render(<BreaksPage />);
    fireEvent.click(screen.getByRole("button", { name: "addBreak" }));

    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Sportlov" } });
    fillDates("2027-02-22", "2027-02-26");

    expect(screen.getByRole("button", { name: "save" })).toBeEnabled();
  });

  it("will not offer a day outside the läsår in the calendar", async () => {
    /*
     * An affordance, not a check: the API is still the only place that knows
     * which year the id names, and it still refuses. But offering a day that
     * is going to be rejected is a worse conversation than not offering it.
     *
     * Asserted on the calendar rather than on `min`/`max` attributes. The field
     * is no longer `<input type="date">` — it could not be, because no browser
     * shows week numbers in its own picker — so the bounds live where the days
     * are drawn.
     */
    const user = userEvent.setup();
    render(<BreaksPage />);
    fireEvent.click(screen.getByRole("button", { name: "addBreak" }));

    fireEvent.change(screen.getByLabelText("startDate"), {
      target: { value: "2026-08-19" },
    });
    // Each field's calendar button now names the field it belongs to, so two
    // date pickers in one dialog can be told apart by a screen reader.
    await user.click(screen.getByRole("button", { name: "openCalendarFor(startDate)" }));

    // The läsår opens 2026-08-17, so the 16th is the day before it starts. The
    // days carry their whole date as their name — "16" alone said nothing about
    // which month the arrows had wandered into.
    expect(screen.getByRole("button", { name: "16 augusti 2026" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "19 augusti 2026" })).toBeEnabled();
  });
});

describe("Lovlistan medan den inte vet", () => {
  it("shows a skeleton rather than an empty list while the lov are in flight", () => {
    // An empty list is a claim: "this school has no lov". An admin who
    // believes it enters them all a second time.
    state.breaks = pending();
    render(<BreaksPage />);

    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("noResults")).toBeNull();
    expect(document.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("says the fetch failed rather than showing an empty list", () => {
    // The harder of the two: a loading gate closes on its own and this does
    // not. `isLoading` is `isPending && isFetching`, so an errored query falls
    // straight through a loading check into the empty state.
    state.breaks = failed();
    render(<BreaksPage />);

    expect(screen.getByText("loadFailed")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("noResults")).toBeNull();
  });

  it("does not tell a school to create a läsår while the list is still loading", () => {
    state.years = pending();
    state.breaks = disabled();
    render(<BreaksPage />);

    expect(screen.queryByText("noYear")).toBeNull();
    expect(document.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("says it once the läsår list has answered and held nothing", () => {
    // The other half of the same gate: a loading check that swallows the real
    // empty state trades a false claim for a skeleton that never resolves.
    state.years = loaded([]);
    state.breaks = disabled();
    render(<BreaksPage />);

    expect(screen.getByText("noYear")).toBeTruthy();
    expect(document.querySelector(".animate-pulse")).toBeNull();
    // And there is nothing to add a lov to.
    expect(screen.getByRole("button", { name: "addBreak" })).toBeDisabled();
  });

  it("says what an empty list MEANS for the timplan", () => {
    // "Inget här ännu" alone is neutral, and this state is not: with no lov
    // entered, the timplan counts every calendar week as taught and reads
    // 8-10 weeks high across a Swedish läsår. The page has the only chance to
    // say so.
    state.breaks = loaded([]);
    render(<BreaksPage />);

    expect(screen.getByText("noResults")).toBeTruthy();
    expect(screen.getByText("empty")).toBeTruthy();
  });
});
