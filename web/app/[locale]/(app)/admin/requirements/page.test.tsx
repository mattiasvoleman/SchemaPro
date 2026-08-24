import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RequirementsPage from "./page";

/**
 * The matrix has to stay legible while an admin scrolls a hundred groups.
 *
 * jsdom computes no layout, so this cannot prove the header visually sticks —
 * that was checked in a browser against the same structure. What it does pin
 * is the arrangement that makes sticking possible at all: the container is
 * the scrolling element, and the header cells are positioned against it.
 * Reverting either silently returns the bug, and nothing else would notice.
 *
 * The other half of this file is about numbers the page STATES. Every figure
 * here has a failure mode that lands on zero — an index built on the wrong
 * key, a year without bounds, a query that has not answered yet — and a test
 * that accepts "0 h" is a test that passes through all of them. So the hour
 * assertions are exact, derived below from the fixture year, and never a
 * shape match.
 */

const groups = [
  { id: "g-7a", academicYearId: "y1", name: "7A", kind: "CLASS", gradeLevel: 7 },
  { id: "g-ma71", academicYearId: "y1", name: "Ma71", kind: "TEACHING_GROUP", gradeLevel: null },
];

/**
 * As the hook delivers them: sorted by NAME, in Swedish.
 *
 * SO and Slöjd are the pair that exposed the bug, and they are a school's real
 * subjects, not a contrivance: by name Samhällsorientering sorts before Slöjd,
 * so the hook hands over SO then SL — while the header shows codes, and an eye
 * reading codes sees SL before SO. Övrigt is kept for the Swedish collation.
 */
const subjects = [
  { id: "s-bi", name: "Bild", code: "BI", color: "#4f46e5", requiredRoomTypeId: null },
  { id: "s-so", name: "Samhällsorientering", code: "SO", color: "#0ea5e9", requiredRoomTypeId: null },
  { id: "s-sl", name: "Slöjd", code: "SL", color: "#db2777", requiredRoomTypeId: null },
  { id: "s-ov", name: "Övrigt", code: "ÖV", color: "#059669", requiredRoomTypeId: null },
];

/**
 * A läsår with real bounds, because the hours column measures every period
 * against them — a year without dates makes every requirement worth zero and
 * would let a broken calculation pass unnoticed.
 */
const year = {
  id: "y1",
  name: "2026/2027",
  isActive: true,
  startDate: "2026-08-17",
  endDate: "2027-06-11",
};

/**
 * Two requirements for 7A that never share a week: SO runs odd weeks all year,
 * Slöjd runs even weeks. Flat addition calls that four lessons a week; no week
 * of the year holds more than two.
 */
/**
 * Spelled out rather than inferred: from a literal, `startDate: null` infers as
 * the type `null`, and a test that hands the page a real period then fails to
 * compile — which is exactly the fixture a period needs to be tested at all.
 */
interface RequirementFixture {
  id: string;
  academicYearId: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  lessonsPerWeek: number;
  minutesPerLesson: number;
  recurrence: "ALL_WEEKS" | "ODD_WEEKS" | "EVEN_WEEKS";
  startDate: string | null;
  endDate: string | null;
}

const requirements: RequirementFixture[] = [
  {
    id: "r-so",
    academicYearId: "y1",
    subjectId: "s-so",
    studentGroupId: "g-7a",
    teacherId: null,
    coTeacherId: null,
    lessonsPerWeek: 2,
    minutesPerLesson: 60,
    recurrence: "ODD_WEEKS",
    startDate: null,
    endDate: null,
  },
  {
    id: "r-sl",
    academicYearId: "y1",
    subjectId: "s-sl",
    studentGroupId: "g-7a",
    teacherId: null,
    coTeacherId: null,
    lessonsPerWeek: 2,
    minutesPerLesson: 60,
    recurrence: "EVEN_WEEKS",
    startDate: null,
    endDate: null,
  },
];

/**
 * What 7A is worth, worked out here rather than read off the render.
 *
 * 2026-08-17 is a Monday and 2027-06-11 a Friday, so the läsår is 43 whole ISO
 * weeks: 22 odd-numbered and 21 even (the year crosses the 2026/2027 seam,
 * where ISO week 53 sits next to week 1 — two odd weeks running, which is why
 * the split is 22/21 and not 22/22 or 21/21). Two 60-minute lessons a week in
 * each of them:
 *
 *   SO,    odd weeks:  22 * 2 * 60 = 2640 min = 44 h
 *   Slöjd, even weeks: 21 * 2 * 60 = 2520 min = 42 h
 *   7A total                                  = 86 h
 *
 * 86 h is also exactly what ONE all-weeks 2x60 requirement would be worth over
 * the same 43 weeks — the halving this fixture exists to demonstrate. The
 * figure a flat full-year reading would print is 172 h, and the figure every
 * plumbing failure prints is 0 h; the assertions below can tell all three
 * apart, which the old `/^\d+([,.]\d)? h$/` could not.
 */
const SEVEN_A_HOURS = "86 h";
/** School-wide, and 7A is the only group with requirements at all. */
const SCHOOL_HOURS = "86 h";
/** No week of the year holds more than one of the two alternating pairs. */
const PEAK_LESSONS = 2;

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
/** A query still in flight: react-query gives no data and isLoading true. */
const pending = <T,>(): QueryState<T> => ({
  data: undefined,
  isLoading: true,
  isError: false,
});
/**
 * A query that has GIVEN UP — the shape retry:1 leaves behind.
 *
 * `isLoading` is `isPending && isFetching`, and an errored query is neither, so
 * this is data-less and not loading: indistinguishable from an answer of zero
 * to everything downstream of `data`. That is the whole reason it needs its own
 * gate, and the reason a test for it cannot be folded into `pending()`.
 */
const failed = <T,>(): QueryState<T> => ({
  data: undefined,
  isLoading: false,
  isError: true,
});
/**
 * A DISABLED query — what useRequirements is while no läsår is selected.
 * react-query v5 computes isLoading as isPending && isFetching, so a disabled
 * query is pending without being loading, and the page must fall through to
 * its empty state rather than wait for an answer that is never coming.
 */
const disabled = <T,>(): QueryState<T> => ({
  data: undefined,
  isLoading: false,
  isError: false,
});

/**
 * Every hook's state in one mutable object, so a single test can put one query
 * back in flight without re-mocking the module. Rebuilt before each test: a
 * leaked `pending()` would leave a later test asserting against a skeleton and
 * reporting it as a rendering bug.
 */
const freshState = () => ({
  years: loaded([year]),
  subjects: loaded(subjects),
  groups: loaded(groups),
  memberships: loaded([] as { studentGroupId: string }[]),
  requirements: loaded(requirements),
});

let state = freshState();

/**
 * Hoisted so a test can read what was SENT. They used to be built fresh inside
 * the factory, which meant every call landed on a function nobody held a
 * reference to — the whole submit path, including the null-versus-omitted
 * distinction the period depends on, ran unobserved.
 */
const { createMock, updateMock, removeMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  updateMock: vi.fn(),
  removeMock: vi.fn(),
}));

vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => state.years,
  useSubjects: () => state.subjects,
  useGroups: () => state.groups,
  usePeople: () => ({ data: [] }),
  useGroupMemberships: () => state.memberships,
  useRequirements: () => state.requirements,
  useCrudMutations: () => ({
    create: { mutateAsync: createMock, isPending: false },
    update: { mutateAsync: updateMock, isPending: false },
    remove: { mutateAsync: removeMock, isPending: false },
  }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join("|")})` : key;
    return t;
  },
}));

const matrix = () => screen.getByRole("table");

/** The last cell of a group's row, which is its hours for the läsår. */
const hoursFor = (groupName: string) =>
  screen.getByText(groupName).closest("tr")?.lastElementChild?.textContent;

/** The cell before it: lessons in that group's own heaviest week. */
const peakFor = (groupName: string) =>
  screen.getByText(groupName).closest("tr")?.lastElementChild
    ?.previousElementSibling?.textContent;

beforeEach(() => {
  state = freshState();
  createMock.mockReset().mockResolvedValue(undefined);
  updateMock.mockReset().mockResolvedValue(undefined);
  removeMock.mockReset().mockResolvedValue(undefined);
});

describe("Timplan matrix", () => {
  it("orders the columns by the label they actually show", () => {
    // The header shows the CODE while the hook sorts by NAME, and sorting one
    // string while displaying another reads as no order at all — the school's
    // own list came out "EN IDH MA MU NO SO SL SV". Each view is alphabetical
    // in what it shows: names in the dropdowns, codes here.
    render(<RequirementsPage />);

    // Group column first, then the subjects, then the two summary columns —
    // peak week and year hours. Sliced by name rather than by index so adding
    // a third summary column fails the assertion instead of silently eating
    // the last subject.
    const SUMMARY_HEADERS = ["peakHeader", "hoursHeader"];
    const codes = within(matrix())
      .getAllByRole("columnheader")
      .slice(1)
      .map((cell) => cell.textContent?.trim())
      .filter((label) => !SUMMARY_HEADERS.includes(label ?? ""));
    expect(codes).toEqual(["BI", "SL", "SO", "ÖV"]);
  });

  it("keeps every row's cells under the column they belong to", () => {
    // Counting cells is not enough: a header ordered one way and cells another
    // gives the same count and files every lesson under the wrong subject —
    // silently, in the one view a school uses to decide what it teaches. Each
    // cell names its own subject, so the two can be compared position by
    // position.
    render(<RequirementsPage />);

    const order = ["Bild", "Slöjd", "Samhällsorientering", "Övrigt"];
    // The mocked translator joins values in object order: group, then subject.
    const valuesOf = (button: Element) =>
      button.getAttribute("aria-label")?.replace(/^[^(]*\(|\)$/g, "").split("|") ?? [];

    const rowsChecked: (string | undefined)[] = [];
    for (const row of within(matrix()).getAllByRole("row").slice(1)) {
      const buttons = within(row).queryAllByRole("button");
      if (buttons.length === 0) continue; // section heading row
      rowsChecked.push(valuesOf(buttons[0])[0]);
      expect(buttons.map((button) => valuesOf(button)[1])).toEqual(order);
    }
    // The `continue` above is what made this test unfalsifiable: a matrix that
    // rendered no cells at all — an empty state, a skeleton, a broken section
    // split — skipped every row and passed. Name the rows that had to be
    // examined, so "nothing was examined" is a failure and not a pass.
    expect(rowsChecked).toEqual(["7A", "Ma71"]);
  });

  it("renders a column per subject and a row per group", () => {
    render(<RequirementsPage />);

    const headers = within(matrix()).getAllByRole("columnheader");
    expect(headers.map((cell) => cell.textContent?.trim())).toEqual([
      "group",
      "BI",
      "SL",
      "SO",
      "ÖV",
      "peakHeader",
      "hoursHeader",
    ]);

    // The name promises a row per group and the old test never looked at one,
    // so every group row could go missing without this failing. The name lives
    // in its own span; the member count sits beside it in a second one.
    expect(
      within(matrix())
        .getAllByRole("rowheader")
        .map((cell) => cell.querySelector("span")?.textContent),
    ).toEqual(["7A", "Ma71"]);
  });

  it("scrolls inside its own container, which is what sticky resolves against", () => {
    render(<RequirementsPage />);

    // `overflow-x: auto` alone makes the element a scroll container whose
    // vertical extent never scrolls, so a sticky header would never engage.
    const container = matrix().parentElement;
    expect(container?.className).toContain("overflow-auto");
    expect(container?.className).toMatch(/max-h-/);
  });

  it("pins the subject header row to the top of that container", () => {
    render(<RequirementsPage />);

    for (const header of within(matrix()).getAllByRole("columnheader")) {
      expect(header.className).toContain("sticky");
      expect(header.className).toContain("top-0");
    }
  });

  it("keeps the group column pinned to the left as well", () => {
    render(<RequirementsPage />);

    const [corner] = within(matrix()).getAllByRole("columnheader");
    expect(corner?.className).toContain("left-0");

    // The name renders in a span inside the cell; the cell is what sticks. It
    // is a `th scope="row"` rather than a `td`, which is what pairs the hours
    // in the last column with the group they belong to for a screen reader.
    const groupCell = screen.getByText("7A").closest("th");
    expect(groupCell).not.toBeNull();
    expect(groupCell!.getAttribute("scope")).toBe("row");
    expect(groupCell!.className).toContain("sticky");
    expect(groupCell!.className).toContain("left-0");
  });

  it("layers the corner above both header row and group column", () => {
    // Where the two sticky axes meet, one has to win or the corner is painted
    // over by whichever cell scrolls under it.
    render(<RequirementsPage />);

    const [corner, subject] = within(matrix()).getAllByRole("columnheader");
    const zOf = (element: Element | undefined) =>
      Number(/z-(\d+)/.exec(element?.className ?? "")?.[1] ?? 0);

    const groupCell = screen.getByText("7A").closest("th") ?? undefined;
    // A missing z-index reads as 0 and would satisfy every ">" below by being
    // absent, so the group column is asked to have one at all first — dropping
    // it is exactly the regression this test is for.
    expect(zOf(groupCell)).toBeGreaterThan(0);
    expect(zOf(corner)).toBeGreaterThan(zOf(subject));
    expect(zOf(subject)).toBeGreaterThan(zOf(groupCell));
  });

  it("pins the hours column to the right, above the columns scrolling under it", () => {
    // Same argument as the group column on the left: a school with a dozen
    // subjects scrolls this table sideways, and a per-group total you have to
    // scroll away from the row to read is a total nobody checks.
    render(<RequirementsPage />);

    const headers = within(matrix()).getAllByRole("columnheader");
    const hours = headers[headers.length - 1];
    expect(hours.className).toContain("sticky");
    expect(hours.className).toContain("right-0");

    const zOf = (element: Element | undefined) =>
      Number(/z-(\d+)/.exec(element?.className ?? "")?.[1] ?? 0);
    expect(zOf(hours)).toBeGreaterThan(zOf(headers[1]));
  });

  it("gives each group the heaviest week it has itself, not a slice of the school's", () => {
    /*
     * The distinction the column exists for, and the only fixture that can
     * tell the two apart.
     *
     * 7A reads four lessons a week on ODD weeks and nothing on even ones.
     * Ma71 reads five on EVEN weeks plus one every week, so six on even and
     * one on odd. The school's own heaviest week is therefore an EVEN one, at
     * 0 + 6 = 6 — a week in which 7A is not taught at all.
     *
     * So an implementation that finds the school's peak week and reads each
     * group out of THAT week hands 7A a 0. Its real answer is 4, in a week the
     * school is quieter overall. Every group peaks in its own week or the
     * number means nothing.
     */
    state.requirements = loaded([
      { ...requirements[0], id: "r-a", lessonsPerWeek: 4, recurrence: "ODD_WEEKS" },
      {
        ...requirements[1],
        id: "r-b",
        studentGroupId: "g-ma71",
        lessonsPerWeek: 5,
        recurrence: "EVEN_WEEKS",
      },
      {
        ...requirements[1],
        id: "r-c",
        subjectId: "s-bi",
        studentGroupId: "g-ma71",
        lessonsPerWeek: 1,
        recurrence: "ALL_WEEKS",
      },
    ]);

    render(<RequirementsPage />);

    expect(peakFor("7A")).toBe("4");
    expect(peakFor("Ma71")).toBe("6");
    // And the school-wide figure is the even week, where 7A contributes none —
    // which is what makes the two 7A numbers differ at all.
    expect(screen.getByRole("status").textContent).toContain("summary(6|");
  });

  it("counts a group's alternating courses as the weeks they really share", () => {
    // The fixture's own case: SO odd and Slöjd even, two lessons each. A flat
    // sum says four a week; no week holds more than two.
    render(<RequirementsPage />);

    expect(peakFor("7A")).toBe(String(PEAK_LESSONS));
    // A group with no requirements at all is a real zero, not a gap.
    expect(peakFor("Ma71")).toBe("0");
  });

  it("pins the peak column exactly the hours column's width from the edge", () => {
    // Two sticky columns and one offset: `min-w-24`/`max-w-24` on hours and
    // `right-24` here are the same 6rem, and drifting them apart either opens a
    // gap the subjects scroll through or slides one column under the other.
    // jsdom computes no layout — the widths were measured in a browser — so
    // what is checkable here is that the two numbers still agree, and that the
    // width is pinned by min AND max rather than by `w-`, which the browser
    // treats as a suggestion and shrank to the content.
    render(<RequirementsPage />);

    const headers = within(matrix()).getAllByRole("columnheader");
    const hours = headers[headers.length - 1];
    const peak = headers[headers.length - 2];

    const widthOf = (element: Element | undefined) => {
      const className = element?.className ?? "";
      const min = /(?:^|\s)min-w-(\d+)/.exec(className)?.[1];
      const max = /(?:^|\s)max-w-(\d+)/.exec(className)?.[1];
      // Both, and equal: one alone leaves the column free to move in the other
      // direction, and the offset only holds while it cannot move at all.
      expect(min).toBeDefined();
      expect(max).toBe(min);
      return min;
    };
    const offsetOf = (element: Element | undefined) =>
      /(?:^|\s)right-(\d+)/.exec(element?.className ?? "")?.[1];

    expect(peak?.className).toContain("sticky");
    expect(offsetOf(hours)).toBe("0");
    expect(offsetOf(peak)).toBe(widthOf(hours));
    // Same pairing on the body cells, which stick independently of the header
    // and carry their own width — a header pinned to 6rem does not hold a body
    // cell that has drifted back to `w-`, and the column takes the wider of the
    // two. Found by mutation: this assertion checked only the header, and
    // reverting the body cell alone reopened the gap with all 32 tests green.
    const row = screen.getByText("7A").closest("tr");
    const bodyHours = row?.lastElementChild ?? undefined;
    const bodyPeak = row?.lastElementChild?.previousElementSibling ?? undefined;
    expect(offsetOf(bodyHours)).toBe("0");
    expect(widthOf(bodyHours)).toBe(widthOf(hours));
    expect(offsetOf(bodyPeak)).toBe(widthOf(hours));
  });

  it("lets the section label span the whole row, totals included", () => {
    // colSpan is written by hand against the column count. One short and the
    // label stops before the summary columns, leaving a gap exactly where the
    // numbers are.
    const { container } = render(<RequirementsPage />);

    const headerCount = within(matrix()).getAllByRole("columnheader").length;
    const spans = [...container.querySelectorAll("td[colspan]")].map((cell) =>
      Number(cell.getAttribute("colspan")),
    );
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) expect(span).toBe(headerCount);
  });

  it("reports the busiest week and the year's teaching, both to the figure", () => {
    // 7A reads SO on odd weeks and Slöjd on even weeks, two lessons each. The
    // old flat sum said four lessons a week; no week of the year holds more
    // than two, and a timplan that claims to need four slots where two will do
    // sends an admin looking for room that was never missing.
    //
    // Asserted whole rather than with `toContain("summary(2|")`: the hours half
    // of the same sentence was unchecked, and 0 h there is the shape every
    // wiring failure takes.
    render(<RequirementsPage />);

    expect(screen.getByRole("status").textContent).toBe(
      `summary(${PEAK_LESSONS}|${SCHOOL_HOURS})`,
    );
  });

  it("gives every group its year total in hours, to the hour", () => {
    // Alternating weeks halve the year, so neither requirement is worth its
    // full-year figure — the point of counting hours here rather than
    // multiplying lessons by 40 in someone's head. See SEVEN_A_HOURS above for
    // the arithmetic.
    //
    // This used to assert /^\d+([,.]\d)? h$/, which "0 h" matches — and 0 h is
    // what a requirementIndex keyed the wrong way, an empty totals map and a
    // läsår without bounds all produce. Every failure mode the test existed to
    // catch passed it. The expected number is worked out from the fixture and
    // compared against instead.
    render(<RequirementsPage />);

    expect(hoursFor("7A")).toBe(SEVEN_A_HOURS);
    // Ma71 has no requirements at all, and an empty row says so as a number.
    // Only meaningful now that 7A's cell is pinned to a non-zero figure: with
    // both cells free to read 0 h, this assertion was the bug's alibi.
    expect(hoursFor("Ma71")).toBe("0 h");
  });

  it("puts each requirement in the cell it belongs to, with the period it runs in", () => {
    // Found by mutation: keying requirementIndex the wrong way round —
    // subject:group instead of group:subject — broke nothing in this file.
    // Every cell simply rendered as empty, the column order still held, the
    // aria-labels still named their subject and the hours column reads a
    // different map entirely. A matrix that has quietly forgotten every
    // requirement the school entered is the worst version of this page there
    // is, and it passed.
    render(<RequirementsPage />);

    // The badge is the only thing on the cell saying this is not a year-long
    // course, so it counts as cell content, not decoration.
    expect(screen.getByLabelText("cellLabelPeriod(7A|Samhällsorientering|2|60|badgeOdd)")
        .textContent).toBe(
      "2×60badgeOdd",
    );
    expect(
      screen.getByLabelText("cellLabelPeriod(7A|Slöjd|2|60|badgeEven)").textContent,
    ).toBe("2×60badgeEven");
    // ...and 7A has no Bild, which is a plus icon and no text.
    expect(screen.getByLabelText("cellLabel(7A|Bild)").textContent).toBe("");
  });

  it("paints the empty cell's plus at a contrast that can be seen", () => {
    // Measured from the tokens in app/globals.css, light / dark: the icon was
    // `text-muted-foreground/40`, and lucide inherits currentColor, so what
    // was painted was the 40% blend — 1.70:1 and 2.01:1, under even the 3:1
    // WCAG 2.1 asks of a graphical object. Hover was no better (4.40:1 in
    // light). Undiluted the token is 4.83 / 6.17 and hover on `foreground` is
    // 17.00 / 13.19. jsdom cannot measure a colour, so the class is what is
    // pinned; the ratios live in the page's own file header.
    render(<RequirementsPage />);

    const emptyCell = screen.getByLabelText("cellLabel(Ma71|Bild)");
    expect(emptyCell.className).toContain("text-muted-foreground");
    expect(emptyCell.className).not.toMatch(/text-muted-foreground\/\d/);
    expect(emptyCell.className).toContain("hover:text-foreground");
  });
});

/**
 * A number that is zero because nothing arrived must not be printed like a
 * number that is zero because nothing is taught. The gate used to be
 * `subjectsLoading` alone, and ["subjects"] is not year-scoped — so the usual
 * case was a fully drawn matrix reading "0 h" per group while the requirements
 * were still in flight.
 */
describe("Timplan while its data is still arriving", () => {
  it("shows no figures at all while the requirements are in flight", () => {
    state.requirements = pending();
    render(<RequirementsPage />);

    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/\d+ h/)).toBeNull();
    expect(document.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("waits for the groups before it can claim a school has none", () => {
    state.groups = pending();
    render(<RequirementsPage />);

    expect(screen.queryByText("empty")).toBeNull();
    expect(document.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("waits for the memberships before calling a teaching group empty", () => {
    // "0 elever" renders in destructive red — the page accusing the school of
    // an unschedulable group. An unloaded membership list produces exactly
    // that for every teaching group there is.
    state.memberships = pending();
    render(<RequirementsPage />);

    expect(screen.queryByText("memberCount(0)")).toBeNull();
  });

  it("does not tell a school to create a läsår while the läsår list is loading", () => {
    // "Skapa och aktivera ett läsår först" is a claim about the school's
    // configuration, and it was shown before ["academicYears"] had answered —
    // to admins with three läsår already.
    state.years = pending();
    state.requirements = disabled();
    render(<RequirementsPage />);

    expect(screen.queryByText("noYear")).toBeNull();
    expect(document.querySelector(".animate-pulse")).not.toBeNull();
  });

  /*
   * A query that has GIVEN UP is the other way this page can print a lie, and
   * the harder one: the loading gate closes on its own, this does not.
   *
   * Found by mutation after the loading gate was added — `isLoading` is
   * `isPending && isFetching`, so an errored query is data-less and NOT
   * loading, and it fell straight through the skeleton. The matrix then drew
   * "0 h" on every row and "0 lektioner den tyngsta veckan · 0 h undervisning
   * per läsår" in the header, in the same weight as a measurement, on a school
   * whose network had simply died.
   */
  it.each([
    ["requirements", () => (state.requirements = failed())],
    ["the läsår list", () => (state.years = failed())],
    ["the groups", () => (state.groups = failed())],
    ["the memberships", () => (state.memberships = failed())],
    ["the subjects", () => (state.subjects = failed())],
  ])("prints no figure at all when %s could not be fetched", (_which, breakIt) => {
    breakIt();

    render(<RequirementsPage />);

    expect(screen.getByText("loadFailed")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    // The two shapes a zero would have taken.
    expect(screen.queryByText(/^summary\(/)).toBeNull();
    expect(screen.queryByText("0 h")).toBeNull();
  });

  it("does not accuse a school of having no läsår when the list merely failed", () => {
    // The sentence "skapa ett läsår först" is a claim about how the school is
    // set up. A dead request is not evidence for it.
    state.years = failed();

    render(<RequirementsPage />);

    expect(screen.queryByText("noYear")).toBeNull();
    expect(screen.getByText("loadFailed")).toBeTruthy();
  });

  /*
   * What the dialog SENDS, which nothing used to look at.
   *
   * The mutation mocks were built fresh inside the vi.mock factory, so every
   * call landed on a function no test held — the largest block of logic added
   * to this page ran entirely unobserved. It could have sent the period as the
   * empty string, or omitted it, or dropped the recurrence, and all 17 tests
   * stayed green.
   *
   * The empty-string-versus-null distinction is the one worth pinning: the DTO
   * reads `undefined` as "leave it alone" and `null` as "clear it", so an
   * emptied field that arrives as `undefined` makes a period permanent — an
   * admin can enter one and then never take it off.
   */
  const openCell = async (label: string) => {
    const user = userEvent.setup();
    await user.click(screen.getByLabelText(label));
    return user;
  };

  it("sends an untouched period as explicit nulls, keeping the recurrence", async () => {
    render(<RequirementsPage />);
    const user = await openCell("cellLabelPeriod(7A|Samhällsorientering|2|60|badgeOdd)");

    await user.click(screen.getByRole("button", { name: "save" }));

    expect(updateMock).toHaveBeenCalledTimes(1);
    const sent = updateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.recurrence).toBe("ODD_WEEKS");
    expect(sent.startDate).toBeNull();
    expect(sent.endDate).toBeNull();
    // Null, not absent: `'startDate' in sent` is the whole distinction, and
    // toBeNull() alone passes on an undefined that was never set.
    expect(Object.hasOwn(sent, "startDate")).toBe(true);
    expect(Object.hasOwn(sent, "endDate")).toBe(true);
  });

  it("sends a period an admin typed, as the dates they typed", async () => {
    render(<RequirementsPage />);
    const user = await openCell("cellLabel(7A|Bild)");

    fireEvent.change(screen.getByLabelText("periodFrom"), {
      target: { value: "2027-01-11" },
    });
    fireEvent.change(screen.getByLabelText("periodTo"), {
      target: { value: "2027-06-11" },
    });
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(createMock).toHaveBeenCalledTimes(1);
    const sent = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.startDate).toBe("2027-01-11");
    expect(sent.endDate).toBe("2027-06-11");
    expect(sent.subjectId).toBe("s-bi");
    expect(sent.studentGroupId).toBe("g-7a");
  });

  it("lets an admin take a period off again", async () => {
    // The case the null mapping exists for. A spring-only course that turns out
    // to run all year has to be able to say so.
    state.requirements = loaded([
      {
        ...requirements[0],
        recurrence: "ALL_WEEKS",
        startDate: "2027-01-11",
        endDate: "2027-06-11",
      },
    ]);
    render(<RequirementsPage />);
    const user = await openCell("cellLabelPeriod(7A|Samhällsorientering|2|60|badgePeriod)");

    expect((screen.getByLabelText("periodFrom") as HTMLInputElement).value).toBe(
      "2027-01-11",
    );
    fireEvent.change(screen.getByLabelText("periodFrom"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("periodTo"), { target: { value: "" } });
    await user.click(screen.getByRole("button", { name: "save" }));

    const sent = updateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.startDate).toBeNull();
    expect(sent.endDate).toBeNull();
  });

  it("keeps the hours footnote with the figure it qualifies", () => {
    // The number is calendar weeks, lov included, and a rektor may well put it
    // in a document. Deleting the caveat leaves a figure that reads more exact
    // than it is, and the aria-describedby is how a screen reader hears the two
    // together at all.
    render(<RequirementsPage />);

    const caveat = screen.getByText("hoursCaveat");
    expect(caveat.id).toBe("requirements-hours-caveat");
    expect(
      screen.getByRole("status").getAttribute("aria-describedby"),
    ).toBe("requirements-hours-caveat");
  });

  it("names the table for a reader who never sees the heading above it", () => {
    // Table navigation lands inside the grid. Without a caption the whole
    // matrix announces as an unnamed table of codes and numbers.
    expect(
      render(<RequirementsPage />).container.querySelector("table > caption"),
    ).toBeTruthy();
  });

  it("still says so once the läsår list has answered and is empty", () => {
    // The other half of the same gate: a loading check that swallows the real
    // empty state trades a false claim for a skeleton that never resolves.
    state.years = loaded([]);
    state.requirements = disabled();
    render(<RequirementsPage />);

    expect(screen.getByText("noYear")).toBeTruthy();
    expect(document.querySelector(".animate-pulse")).toBeNull();
  });
});
