import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import { downloadCsv } from "@/lib/csv-export";
import RequirementsPage from "./page";

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
  /** The pupils' ombyte and dusch, 0 on every subject that needs none. */
  minutesBefore: number;
  minutesAfter: number;
  /** Optional here: a fixture without them is a row at the column default, 100. */
  teacherLoadPercent?: number;
  coTeacherLoadPercent?: number;
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
    minutesBefore: 0,
    minutesAfter: 0,
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
    minutesBefore: 0,
    minutesAfter: 0,
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

/**
 * A lov as the page reads one — lib/teaching-hours.ts's ClosedRange plus the
 * fields the row carries. Spelled out for the same reason RequirementFixture
 * is: from a literal, `minGradeLevel: null` infers as the type `null` and a
 * fixture that then narrows a break to a year span fails to compile.
 */
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
 * Höstlovet: Monday 2026-10-26 to Friday 2026-10-30, ISO week 44 — an EVEN
 * week, which is what makes it visible in the fixture above. Slöjd runs even
 * weeks, so it loses one of its 21 to this and is worth 20 * 2 * 60 = 2400 min
 * = 40 h; SO runs odd weeks and is untouched at 44 h. 7A therefore reads 84 h
 * with this lov and 86 h without, and the two are far enough apart that no
 * rounding can confuse them.
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

const SEVEN_A_HOURS_AFTER_HOSTLOV = "84 h";

/** A roster row as the page reads it: role decides the picker, home class the span. */
interface PersonFixture {
  id: string;
  role: "TEACHER" | "STUDENT" | "SCHOOL_ADMIN";
  firstName: string;
  lastName: string;
  email: string;
  isActive: boolean;
  studentGroupId: string | null;
}

/** The slice of the load report the candidate line reads: one balance per teacher. */
interface LoadFixture {
  teachers: { userId: string; balanceMinutesPerWeek: number | null }[];
}

interface QualificationFixture {
  id: string;
  userId: string;
  subjectId: string;
  minGradeLevel: number;
  maxGradeLevel: number;
  kind: "LEGITIMATION" | "BEHORIG" | "TILLATEN";
  validFrom: string | null;
  validTo: string | null;
  note: string | null;
}

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
  /**
   * No lov by default, so every hour figure above keeps the arithmetic it was
   * derived from. The lov tests set this themselves — and an empty list is the
   * honest reading of "this school has entered none", which is what the page
   * shows when the query has answered and held nothing.
   */
  breaks: loaded([] as BreakFixture[]),
  people: loaded([] as PersonFixture[]),
  /**
   * The two reads the cell dialog's candidate badges hang on. Disabled rather
   * than loaded-empty by default: a page with no läsår asks for no report, and
   * no test above mentions a candidate. The candidate tests set both.
   */
  load: disabled<LoadFixture>(),
  qualifications: loaded([] as QualificationFixture[]),
  /**
   * Set only by the export tests, which are the ones that care WHICH year the
   * page asked for. Left null everywhere else so `useRequirements` keeps
   * answering `state.requirements` regardless of the argument, and none of the
   * tests above have to grow a year they never mention.
   */
  requirementsByYear: null as Record<string, RequirementFixture[]> | null,
  /**
   * GET /academic-years/:id/rosters as the page receives it, and the years it
   * was asked for. Null (nothing to lay over) unless a test plans next year.
   */
  rosters: null as unknown,
  rostersAskedFor: [] as (string | null)[],
  /**
   * Mål mode's two reads: which plan each årskurs follows this year, and
   * those plans with their entries. Nothing reads them until the toggle is
   * pressed; the Mål tests set them.
   */
  yearTimplans: loaded([] as YearTimplanFixture[]),
  planDetails: { data: [] as PlanFixture[] | undefined, isError: false },
});

interface YearTimplanFixture {
  gradeLevel: number;
  localTimplanId: string;
  planName: string;
  planStatus: "DRAFT" | "DECIDED";
}

interface PlanFixture {
  id: string;
  name: string;
  status: "DRAFT" | "DECIDED";
  entries: { id: string; subjectId: string; gradeLevel: number; minutesPerWeek: number; note: null }[];
}

let state = freshState();

/**
 * Hoisted so a test can read what was SENT. They used to be built fresh inside
 * the factory, which meant every call landed on a function nobody held a
 * reference to — the whole submit path, including the null-versus-omitted
 * distinction the period depends on, ran unobserved.
 */
const { createMock, updateMock, removeMock, importMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  updateMock: vi.fn(),
  removeMock: vi.fn(),
  importMock: vi.fn(),
}));

/**
 * The hooks are replaced; everything else in the module is not.
 *
 * The import dialog this page mounts reads IMPORT_NEEDS_YEAR and
 * IMPORT_UPDATES_ROWS out of the same module, and a hand-written stand-in for
 * those two tables would be a second copy of the decision the page is here to
 * prove — green in this file while the real one says the opposite.
 */
vi.mock("@/lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries")>()),
  useAcademicYears: () => state.years,
  useSubjects: () => state.subjects,
  useGroups: () => state.groups,
  usePeople: () => state.people,
  useGroupMemberships: () => state.memberships,
  // Year-aware, so a test can prove the page asked for the year the picker is
  // showing and not merely "some requirements".
  useRequirements: (yearId: string | null) =>
    state.requirementsByYear
      ? loaded(state.requirementsByYear[yearId ?? ""] ?? [])
      : state.requirements,
  useSchoolBreaks: () => state.breaks,
  useCrudMutations: () => ({
    create: { mutateAsync: createMock, isPending: false },
    update: { mutateAsync: updateMock, isPending: false },
    remove: { mutateAsync: removeMock, isPending: false },
  }),
  // The dialog's own mutation, which needs a QueryClientProvider this page
  // test does not set up. What it POSTs is csv-import-dialog.test.tsx's
  // subject; here the dialog only has to open.
  useImportCsv: () => ({ mutateAsync: importMock, isPending: false }),
}));

// Next year's förberäknade klasslistor. The overlay itself (withProjectedHomes)
// is the real one; only the request is replaced — and recorded, so a test can
// say which year the page asked about.
vi.mock("@/lib/planning-year", () => ({
  useYearRosters: (year: { id: string } | null, active: { id: string } | null) => {
    const projectable = year !== null && active !== null && year.id !== active.id;
    state.rostersAskedFor.push(projectable ? year.id : null);
    return { data: projectable ? state.rosters : undefined };
  },
}));

// The two staffing reads the teacher picker's badges need, from the module
// the staffing surfaces share. Replaced whole: nothing else in it is mounted
// by this page.
vi.mock("@/lib/staffing-queries", () => ({
  useStaffingLoad: () => state.load,
  useTeacherQualifications: () => state.qualifications,
}));

// Mål mode's reads, from the hooks file the lazily loaded module imports.
vi.mock("@/lib/year-timplan-queries", () => ({
  useYearTimplans: () => state.yearTimplans,
  useLocalTimplanDetails: () => state.planDetails,
}));

// The real requirementsToCsv runs — the file's CONTENTS are what the export
// tests assert. Only the browser download is stubbed.
vi.mock("@/lib/csv-export", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/csv-export")>()),
  downloadCsv: vi.fn(),
}));

const mockDownloadCsv = downloadCsv as unknown as Mock;

// Mål mode's Täckning pill links to the coverage page. next-intl's real Link
// cannot load under vitest (next/navigation), so it is a plain anchor here,
// as the staffing page's test has it — passing its other props through, since
// the pill's accessible name is an aria-label.
vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("next-intl", () => ({
  // DateField reads the active locale for its month and weekday names.
  useLocale: () => "sv",
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join("|")})` : key;
    // lib/engine-message.ts asks `has` before rendering a code; every key
    // "exists" here, so a STAFF_* sentence renders as its code and params.
    t.has = () => true;
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
  importMock.mockReset().mockResolvedValue({ created: 0, skipped: 0, errors: [] });
  mockDownloadCsv.mockReset();
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

  it("takes the läsår's lov off the hours", () => {
    // The figure this page was wrong about until SchoolBreak existed: every
    // hour was counted on whole calendar weeks, lov included, which reads
    // 8-10 weeks high across a Swedish läsår. Höstlovet is a full Mon-Fri week
    // and it is an EVEN one, so Slöjd loses a week and SO does not — 44 + 40
    // rather than 44 + 42.
    state.breaks = loaded([HOSTLOV]);

    render(<RequirementsPage />);

    expect(hoursFor("7A")).toBe(SEVEN_A_HOURS_AFTER_HOSTLOV);
    expect(screen.getByRole("status").textContent).toBe(
      `summary(${PEAK_LESSONS}|${SEVEN_A_HOURS_AFTER_HOSTLOV})`,
    );
  });

  it("does not let a lov drag the busiest week down", () => {
    /*
     * The other half, and the reason peakLessonsPerWeek takes no closures at
     * all: a lov week holds no lessons, so subtracting it from the peak would
     * answer "do these lessons fit in a week" with an average over the weeks
     * they never had to fit in.
     *
     * The requirement is narrowed to the höstlov week and NOTHING else, which
     * is what makes the test able to fail. With the ordinary all-year fixture a
     * closure-aware peak still finds 2 in the other forty-two weeks, so the
     * assertion held whether or not the closures reached the wrong function —
     * it was the shape it was written to catch.
     *
     * 2026-10-26 is the Monday of the lov week and 2026-10-30 the Friday, so
     * the period and the lov are the same five days. The right answer is still
     * PEAK_LESSONS: those lessons had to fit in a week, and whether the week
     * was later declared a lov does not change how full it was.
     */
    state.requirements = loaded([
      { ...requirements[0], recurrence: "ALL_WEEKS", startDate: "2026-10-26", endDate: "2026-10-30" },
    ]);
    state.breaks = loaded([HOSTLOV]);

    render(<RequirementsPage />);

    expect(peakFor("7A")).toBe(String(PEAK_LESSONS));
    // And the hours for that same requirement ARE zero, from the same render,
    // so a closure list handed to neither function cannot pass both.
    expect(hoursFor("7A")).toBe("0 h");
  });

  it("applies a year-narrowed lov to the classes inside the span and to no others", () => {
    /*
     * The reason the closures are applied per group rather than once to a
     * total. Both groups here read the SAME requirement — two 60-minute
     * lessons every week of the year, 43 weeks, 86 h — and the only thing that
     * differs is which of them the lov reaches.
     *
     * 7A is årskurs 7 and inside the span, so it loses the week: 84 h. Ma71 is
     * a teaching group with no årskurs of its own, which puts it inside no
     * span at all (closesForGrade), so its year is untouched: 86 h. An
     * implementation that ignores the span, or that passes a single gradeLevel
     * for the whole page, gives the two rows the same number and fails.
     */
    const everyWeek = {
      ...requirements[0],
      recurrence: "ALL_WEEKS" as const,
      lessonsPerWeek: 2,
      minutesPerLesson: 60,
    };
    state.requirements = loaded([
      { ...everyWeek, id: "r-7a", studentGroupId: "g-7a" },
      { ...everyWeek, id: "r-ma71", subjectId: "s-bi", studentGroupId: "g-ma71" },
    ]);
    state.breaks = loaded([{ ...HOSTLOV, minGradeLevel: 7, maxGradeLevel: 7 }]);

    render(<RequirementsPage />);

    expect(hoursFor("7A")).toBe("84 h");
    expect(hoursFor("Ma71")).toBe("86 h");
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

  it("shows no hours until it knows which weeks are lov", () => {
    /*
     * The subtlest of the gates, and the only one whose failure is not a zero.
     * `closures` is optional in lib/teaching-hours.ts and omitting it silently
     * reproduces the pre-lov calendar-week figure — so a page that draws before
     * the lov arrive prints 86 h under a caveat that promises 84 h, in the same
     * weight as a measurement. There is nothing on screen to tell the two
     * apart, which is why the skeleton has to cover this query too.
     */
    state.breaks = pending();
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
    // A dead lov query is the one that does not read as zero: it reads as the
    // old overestimate, under a footnote now promising the lov are deducted.
    ["the lov", () => (state.breaks = failed())],
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

  /*
   * The pupils' own time, which is not the lesson's.
   *
   * The whole design rests on the buffers lying OUTSIDE the teaching: 60
   * minutes with 10 before and 20 after occupies the class for 90 and is still
   * 60 minutes of undervisning. The failure that would look fine on screen is
   * the dialog quietly folding them into minutesPerLesson — every hour figure
   * on the page would then grow, and the timplan would claim teaching the
   * school does not do. So these assert both halves: the buffers arrive, and
   * the lesson length is untouched.
   */
  it("sends the pupils' ombyte and dusch without touching the lesson's length", async () => {
    render(<RequirementsPage />);
    const user = await openCell("cellLabel(7A|Bild)");

    fireEvent.change(screen.getByLabelText("minutesBefore"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("minutesAfter"), { target: { value: "20" } });
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(createMock).toHaveBeenCalledTimes(1);
    const sent = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.minutesBefore).toBe(10);
    expect(sent.minutesAfter).toBe(20);
    // Numbers, not the strings the form holds: the DTO is @IsInt and a "10"
    // would be a 400 the admin reads as "something went wrong".
    expect(sent.minutesPerLesson).toBe(60);
  });

  it("reads an existing buffer back into the dialog, and lets an admin take it off", async () => {
    // A school that stops showering after idrotten has to be able to say so,
    // and 0 is the only way to say it: the columns are plain integers with a
    // default of 0, so there is no null to clear them with the way a period
    // has one. An omitted key would leave the old 20 standing forever.
    state.requirements = loaded([
      { ...requirements[0], recurrence: "ALL_WEEKS", minutesBefore: 10, minutesAfter: 20 },
    ]);
    render(<RequirementsPage />);
    const user = await openCell("cellLabelSet(7A|Samhällsorientering|2|60)");

    expect((screen.getByLabelText("minutesBefore") as HTMLInputElement).value).toBe("10");
    expect((screen.getByLabelText("minutesAfter") as HTMLInputElement).value).toBe("20");

    fireEvent.change(screen.getByLabelText("minutesBefore"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("minutesAfter"), { target: { value: "" } });
    await user.click(screen.getByRole("button", { name: "save" }));

    const sent = updateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.minutesBefore).toBe(0);
    expect(sent.minutesAfter).toBe(0);
  });

  it("refuses to save a buffer the database would reject", async () => {
    // `min`/`max` on an <input type="number"> constrain the spinner and
    // nothing else — a typed 90 passes them and comes back as a 400 about a
    // column the admin never named. 0..60 is the CHECK on the column itself.
    render(<RequirementsPage />);
    await openCell("cellLabel(7A|Bild)");

    fireEvent.change(screen.getByLabelText("minutesAfter"), { target: { value: "90" } });
    expect(
      (screen.getByRole("button", { name: "save" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.change(screen.getByLabelText("minutesAfter"), { target: { value: "60" } });
    expect(
      (screen.getByRole("button", { name: "save" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("keeps the hours footnote with the figure it qualifies", () => {
    // A rektor may well put the number in a document. Deleting the caveat
    // leaves a figure that reads more exact than it is, and the
    // aria-describedby is how a screen reader hears the two together at all.
    state.breaks = loaded([HOSTLOV]);
    render(<RequirementsPage />);

    const caveat = screen.getByText("hoursCaveat");
    expect(caveat.id).toBe("requirements-hours-caveat");
    expect(
      screen.getByRole("status").getAttribute("aria-describedby"),
    ).toBe("requirements-hours-caveat");
  });

  it("does not claim the lov are deducted when the school has entered none", () => {
    /*
     * The default state of the feature, and the one the whole change exists to
     * stop lying about. With an empty admin/breaks nothing is deducted, so the
     * figure is the old one — roughly 8-10 weeks high — and the footnote used
     * to promise the deduction underneath it regardless. That is the same
     * silent overstatement the lov model was built to remove, one layer up.
     *
     * Empty is not absent: `loading` and `failed` hold the whole table back, so
     * reaching this text means the list arrived and held nothing.
     */
    state.breaks = loaded([]);
    render(<RequirementsPage />);

    expect(screen.getByText("hoursCaveatNoBreaks").id).toBe(
      "requirements-hours-caveat",
    );
    expect(screen.queryByText("hoursCaveat")).toBeNull();
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

/**
 * CSV in and out of the timplan.
 *
 * The export is the half with a way to be quietly wrong: the page holds every
 * year's groups and the picker's own year, and a builder handed the wrong one
 * writes a plausible file for a läsår nobody asked about. So the assertions
 * read the FILE — the real requirementsToCsv runs, only the download is
 * stubbed — rather than checking that a function was called.
 */
const NEXT_YEAR = {
  id: "y2",
  name: "2027/2028",
  isActive: false,
  startDate: "2027-08-16",
  endDate: "2028-06-09",
};

/** A group that exists only in the second läsår, so the two files differ. */
const NEXT_YEAR_GROUP = {
  id: "g-8b",
  academicYearId: "y2",
  name: "8B",
  kind: "CLASS",
  gradeLevel: 8,
};

const NEXT_YEAR_REQUIREMENT: RequirementFixture = {
  ...requirements[0],
  id: "r-next",
  academicYearId: "y2",
  studentGroupId: "g-8b",
  subjectId: "s-bi",
  lessonsPerWeek: 1,
  recurrence: "ALL_WEEKS",
};

/** Puts both läsår on the page, each with a timplan of its own. */
const twoYears = () => {
  state.years = loaded([year, NEXT_YEAR]);
  state.groups = loaded([...groups, NEXT_YEAR_GROUP]);
  state.requirementsByYear = { y1: requirements, y2: [NEXT_YEAR_REQUIREMENT] };
};

const exportButton = () => screen.getByRole("button", { name: "exportButton" });

// Review reproduction (P2 review, lens webb): Skapa timplansposter's
// "Öppna Timplansposter" after generating next year's posts opened the ACTIVE
// year, which shows none of them. The link carries ?year=, read once after
// mount; an id that is no year of the school is ignored.
describe("the ?year= deep link", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("opens the linked läsår rather than the active one", async () => {
    twoYears();
    window.history.replaceState(null, "", "/?year=y2");
    render(<RequirementsPage />);
    expect(await screen.findByText("8B")).toBeInTheDocument();
    expect(screen.queryByText("7A")).not.toBeInTheDocument();
  });

  it("falls back to the active läsår for an id that is no year", async () => {
    twoYears();
    window.history.replaceState(null, "", "/?year=nope");
    render(<RequirementsPage />);
    expect(await screen.findByText("7A")).toBeInTheDocument();
  });
});

describe("Timplan CSV", () => {
  it("has nothing to hand over when the timplan is empty", async () => {
    // Not a disabled-for-the-sake-of-it button: the alternative is a file with
    // a header row and no rows, downloaded without a word of explanation, and
    // an admin who opens that in Excel concludes the export is broken rather
    // than that the year they picked has no timplan.
    state.requirements = loaded([]);
    render(<RequirementsPage />);

    expect(exportButton()).toBeDisabled();

    // And it is the timplan that decides, not the page being empty in general:
    // the groups and subjects are all still there.
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("waits for the staff register before it will write a file", async () => {
    // requirementsToCsv DROPS a row whose teacher the roster cannot name,
    // rather than writing a blank teacher cell — blank means "no teacher" to
    // the importer, and the import updates, so a blank would strip the teacher
    // off a requirement that has one. While `usePeople` is in flight that
    // silently empties the file of every requirement that has a teacher. The
    // page deliberately does not hold the matrix back on people; the wait is
    // paid on this button alone.
    state.people = pending();
    render(<RequirementsPage />);

    expect(exportButton()).toBeDisabled();
    // The matrix itself is not held back — that is the trade being made.
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("exports the timplan of the year the picker is showing", async () => {
    twoYears();
    const user = userEvent.setup();
    render(<RequirementsPage />);

    // The active year first: 7A's two alternating requirements, no 8B.
    await user.click(exportButton());
    const [firstName, firstFile] = mockDownloadCsv.mock.calls[0] as [string, string];
    expect(firstName).toBe("timplansposter.csv");
    expect(firstFile).toContain("7A;SO;2;60;0;0;;;udda;;");
    expect(firstFile).toContain("7A;SL;2;60;0;0;;;jamna;;");
    expect(firstFile).not.toContain("8B");

    // Move the picker to next autumn and ask again. The file has to follow —
    // a builder reading the ACTIVE year, or every requirement the school has,
    // both pass a test that only ever looks at the first download.
    await user.click(screen.getByRole("combobox", { name: "yearLabel" }));
    await user.click(screen.getByRole("option", { name: "2027/2028" }));

    await user.click(exportButton());
    const [, secondFile] = mockDownloadCsv.mock.calls[1] as [string, string];
    expect(secondFile).toContain("8B;BI;1;60;0;0;;;alla;;");
    expect(secondFile).not.toContain("7A");
  });

  it("names the year picker, now that it stands among buttons", () => {
    // Its value is the year, so a trigger without a name announces as
    // "2026/2027, combobox" — which of the three controls in that header is
    // anybody's guess. The name is what makes it the year picker.
    render(<RequirementsPage />);

    expect(screen.getByRole("combobox", { name: "yearLabel" })).toBeTruthy();
  });

  it("opens the import dialog, offering the timplan and nothing else", async () => {
    const user = userEvent.setup();
    render(<RequirementsPage />);

    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "button" }));

    const dialog = await screen.findByRole("dialog");
    // Every other kind has a page of its own, and an import of elever launched
    // from here would land somewhere the admin cannot see the result.
    await user.click(within(dialog).getByRole("combobox", { name: "kindLabel" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "kinds.requirements",
    ]);
  });

  it.each([
    ["people", () => (state.people = pending())],
    ["subjects", () => (state.subjects = pending())],
    ["groups", () => (state.groups = pending())],
    ["requirements", () => (state.requirements = pending())],
  ])("will not export a file while %s is still unknown", (_which, breakIt) => {
    // requirementsToCsv drops any row whose group, subject or teacher it cannot
    // name. A query that has not answered therefore does not produce a smaller
    // file — it produces a plausible one that is missing most of the school,
    // and nothing about it says so afterwards.
    breakIt();

    render(<RequirementsPage />);

    // getByRole, not queryByRole with an if: a lookup that finds nothing has to
    // fail here rather than quietly assert nothing.
    expect(screen.getByRole("button", { name: "exportButton" })).toBeDisabled();
  });

  it("does export once every one of them has answered", () => {
    // The other half. Without it the four above are satisfied by a button that
    // is disabled always, which would be its own bug.
    render(<RequirementsPage />);

    expect(screen.getByRole("button", { name: "exportButton" })).toBeEnabled();
  });

  it("hands the dialog the läsår the page is showing", async () => {
    /*
     * The one place this can regress, and it was unpinned: the whole
     * `academicYearId` prop could be deleted with every other test green.
     *
     * The fixture year is deliberately NOT flagged active here. The page falls
     * back to the first year and draws its matrix; the dialog, left to itself,
     * resolves the ACTIVE year and would find none — so it would tell an admin
     * looking at a full timplan that there is no läsår to import into. With two
     * years and a picker, the same disagreement is quieter and worse: the rows
     * land in a year the admin never opened.
     */
    state.years = loaded([{ ...year, isActive: false }]);
    const user = userEvent.setup();
    render(<RequirementsPage />);

    await user.click(screen.getByRole("button", { name: "button" }));

    const dialog = await screen.findByRole("dialog");
    // This file's translator mock joins values without their keys.
    expect(within(dialog).getByText("importingIntoYear(2026/2027)")).toBeTruthy();
    expect(within(dialog).queryByText("noActiveYear")).toBeNull();
  });

  it("says in the dialog that a row taken out of the file is not taken out of the timplan", async () => {
    // The timplan is the only import that overwrites, which makes it the only
    // one an admin can read as the file REPLACING what was there. Uploading a
    // spreadsheet holding only årskurs 7 removes nothing, and there is no undo
    // to reach for either way.
    const user = userEvent.setup();
    render(<RequirementsPage />);

    await user.click(screen.getByRole("button", { name: "button" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("updatesNotDeletes")).toBeTruthy();
  });
});

/**
 * The behörighet badge and the "kvar" figure beside each candidate.
 *
 * Both are READ, not computed here: the kind comes from the school's
 * qualification rows through the report's own cover rule, and the minutes are
 * the balance the load report already states for that teacher. So the
 * assertions are about which row's facts land beside which name, for THIS
 * cell's subject and group — the failure this guards against is a badge that
 * answers for the wrong subject, or a figure recomputed to a second answer.
 */
describe("Timplan cell dialog and the tjänstefördelning policy", () => {
  const openCell = async (label: string) => {
    render(<RequirementsPage />);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText(label));
    return user;
  };
  const SO_CELL = "cellLabelPeriod(7A|Samhällsorientering|2|60|badgeOdd)";
  const saveButton = () => screen.getByRole("button", { name: "save" }) as HTMLButtonElement;

  it("keeps the load percentages folded away on a row that counts in full, and sends 100", async () => {
    const user = await openCell(SO_CELL);

    const details = screen.getByText("advanced").closest("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    await user.click(saveButton());

    const sent = updateMock.mock.calls[0][0] as Record<string, unknown>;
    // Numbers, always present: the DTO is @IsInt, and the columns have no
    // "leave it alone" value for an omitted key to mean.
    expect(sent.teacherLoadPercent).toBe(100);
    expect(sent.coTeacherLoadPercent).toBe(100);
  });

  it("opens Avancerat on a row that already carries another charge, and sends the edit", async () => {
    state.requirements = loaded([{ ...requirements[0], coTeacherLoadPercent: 50 }]);
    const user = await openCell(SO_CELL);

    expect(screen.getByText("advanced").closest("details")?.open).toBe(true);
    expect((screen.getByLabelText("coTeacherLoadPercent") as HTMLInputElement).value).toBe("50");
    fireEvent.change(screen.getByLabelText("teacherLoadPercent"), { target: { value: "80" } });
    await user.click(saveButton());

    const sent = updateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.teacherLoadPercent).toBe(80);
    expect(sent.coTeacherLoadPercent).toBe(50);
  });

  it("will not save a charge outside 0..200, a decimal or an emptied field", async () => {
    await openCell("cellLabel(7A|Bild)");
    const field = screen.getByLabelText("teacherLoadPercent");

    for (const bad of ["250", "-5", "12.5", ""]) {
      fireEvent.change(field, { target: { value: bad } });
      expect(saveButton().disabled).toBe(true);
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByText("loadPercentInvalid")).toBeInTheDocument();
    }
    // Both ends of the range are real answers.
    for (const good of ["0", "200"]) {
      fireEvent.change(field, { target: { value: good } });
      expect(saveButton().disabled).toBe(false);
    }
  });

  it("saves a WARN, closes the dialog and keeps the warning above the matrix until dismissed", async () => {
    updateMock.mockResolvedValue({
      ...requirements[0],
      warnings: [
        {
          code: "STAFF_TEACHER_OVER_TARGET",
          params: { role: "TEACHER", minutes: 1200, target: 1000, limit: 1100, tolerance: 10 },
        },
      ],
    });
    const user = await openCell(SO_CELL);
    await user.click(saveButton());

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const banner = screen.getByText("warnedTitle 7A · Samhällsorientering").closest(
      "[role=status]",
    ) as HTMLElement;
    expect(banner).not.toBeNull();

    // Group · subject says which row; the teacher's name is never in it.
    expect(within(banner).getByText("warnedTitle 7A · Samhällsorientering")).toBeInTheDocument();
    expect(
      within(banner).getByText("STAFF_TEACHER_OVER_TARGET(TEACHER|1200|1000|1100|10)"),
    ).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalled();

    await user.click(within(banner).getByRole("button", { name: "warnedDismiss" }));
    expect(screen.queryByText(/warnedTitle/)).not.toBeInTheDocument();
  });

  it("says nothing extra when the save came back with no warnings", async () => {
    updateMock.mockResolvedValue({ ...requirements[0], warnings: [] });
    const user = await openCell(SO_CELL);
    await user.click(saveButton());

    expect(screen.queryByText(/warnedTitle/)).not.toBeInTheDocument();
  });

  it("keeps the dialog open on a REFUSE and names the refusal from the catalogue", async () => {
    createMock.mockRejectedValue(
      new ApiError(409, "Läraren saknar behörighet i Bild för åk 7.", "STAFF_TEACHER_NOT_QUALIFIED", {
        role: "TEACHER",
        subject: "Bild",
        grades: "7",
      }),
    );
    const user = await openCell("cellLabel(7A|Bild)");
    await user.click(saveButton());

    const dialog = screen.getByRole("dialog");
    const alert = within(dialog).getByRole("alert");
    expect(alert).toHaveTextContent("refusedTitle");
    expect(alert).toHaveTextContent("STAFF_TEACHER_NOT_QUALIFIED(TEACHER|Bild|7)");
    // Inline, not a toast: the admin's input is still there to change.
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.queryByText(/warnedTitle/)).not.toBeInTheDocument();
  });

  it("forgets a refusal when another cell is opened", async () => {
    createMock.mockRejectedValueOnce(
      new ApiError(409, "x", "STAFF_TEACHER_OVER_TARGET", { role: "TEACHER" }),
    );
    const user = await openCell("cellLabel(7A|Bild)");
    await user.click(saveButton());
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "cancel" }));
    await user.click(screen.getByLabelText(SO_CELL));
    expect(within(screen.getByRole("dialog")).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("still toasts a 409 that is not the policy's", async () => {
    createMock.mockRejectedValue(new ApiError(409, "Posten finns redan.", "SOMETHING_ELSE"));
    const user = await openCell("cellLabel(7A|Bild)");
    await user.click(saveButton());

    expect(toast.error).toHaveBeenCalledWith("Posten finns redan.");
    expect(within(screen.getByRole("dialog")).queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("Timplan cell dialog candidates", () => {

  const anna: PersonFixture = {
    id: "t-anna",
    role: "TEACHER",
    firstName: "Anna",
    lastName: "Svensson",
    email: "anna@example.test",
    isActive: true,
    studentGroupId: null,
  };
  const bo: PersonFixture = { ...anna, id: "t-bo", firstName: "Bo", lastName: "Lind", email: "bo@example.test" };
  const cilla: PersonFixture = {
    ...anna,
    id: "t-cilla",
    firstName: "Cilla",
    lastName: "Ek",
    email: "cilla@example.test",
  };
  /** A pupil in 7A: the member whose home class gives Ma71 its grade. */
  const pupil: PersonFixture = {
    id: "p-1",
    role: "STUDENT",
    firstName: "Pelle",
    lastName: "Pupil",
    email: "pelle@example.test",
    isActive: true,
    studentGroupId: "g-7a",
  };

  const qualification = (overrides: Partial<QualificationFixture>): QualificationFixture => ({
    id: "q",
    userId: "t-anna",
    subjectId: "s-so",
    minGradeLevel: 7,
    maxGradeLevel: 9,
    kind: "LEGITIMATION",
    validFrom: null,
    validTo: null,
    note: null,
    ...overrides,
  });

  beforeEach(() => {
    state.people = loaded([anna, bo, cilla, pupil]);
    state.memberships = loaded([{ studentGroupId: "g-ma71", studentId: "p-1" }] as never);
    state.load = loaded({
      teachers: [
        { userId: "t-anna", balanceMinutesPerWeek: 120 },
        { userId: "t-bo", balanceMinutesPerWeek: -30 },
        { userId: "t-cilla", balanceMinutesPerWeek: null },
      ],
    });
    state.qualifications = loaded([
      // Anna: legitimerad i SO för 7–9 — covers 7A.
      qualification({ id: "q-anna-so" }),
      // Bo: behörig i SO men bara 1–6 — does NOT cover 7A.
      qualification({ id: "q-bo-so", userId: "t-bo", kind: "BEHORIG", minGradeLevel: 1, maxGradeLevel: 6 }),
      // Cilla: tillåten i Bild, nothing in SO.
      qualification({ id: "q-cilla-bi", userId: "t-cilla", subjectId: "s-bi", kind: "TILLATEN" }),
    ]);
  });

  const openTeacherPicker = async (cellLabel: string) => {
    render(<RequirementsPage />);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText(cellLabel));
    const dialog = screen.getByRole("dialog");
    // The first combobox in the dialog is the teacher's; the co-teacher's and
    // the period's come after it.
    await user.click(within(dialog).getAllByRole("combobox")[0]);
    return user;
  };

  const optionNamed = (name: string) =>
    screen.getAllByRole("option").find((option) => option.textContent?.includes(name));

  it("names each candidate's behörighet for this cell's subject and span, and their minutes left", async () => {
    await openTeacherPicker("cellLabelPeriod(7A|Samhällsorientering|2|60|badgeOdd)");

    const annaOption = optionNamed("Anna Svensson");
    expect(annaOption?.textContent).toContain("kindLEGITIMATION");
    expect(annaOption?.textContent).toContain("candidateRemaining(120)");

    // Bo's 1–6 does not reach åk 7, so the row counts as unqualified here —
    // and the report has him over his mål.
    const boOption = optionNamed("Bo Lind");
    expect(boOption?.textContent).toContain("candidateUnqualified");
    expect(boOption?.textContent).not.toContain("kindBEHORIG");
    expect(boOption?.textContent).toContain("candidateOver(30)");

    // Cilla has a behörighet, in another subject: unqualified for SO, no mål.
    const cillaOption = optionNamed("Cilla Ek");
    expect(cillaOption?.textContent).toContain("candidateUnqualified");
    expect(cillaOption?.textContent).toContain("candidateNoTarget");

    // The unassigned option carries no badge at all.
    expect(optionNamed("notAssigned")?.textContent).toBe("notAssigned");
  });

  it("answers for the cell's own subject: the same teacher reads differently under Bild", async () => {
    await openTeacherPicker("cellLabel(7A|Bild)");

    expect(optionNamed("Cilla Ek")?.textContent).toContain("kindTILLATEN");
    expect(optionNamed("Anna Svensson")?.textContent).toContain("candidateUnqualified");
  });

  it("gives a teaching group the span of its members' home classes", async () => {
    // Ma71 has no year of its own; its one member sits in 7A, so it is åk 7
    // and Bo's 1–6 still falls short while Anna's 7–9 covers it.
    await openTeacherPicker("cellLabel(Ma71|Samhällsorientering)");

    expect(optionNamed("Anna Svensson")?.textContent).toContain("kindLEGITIMATION");
    expect(optionNamed("Bo Lind")?.textContent).toContain("candidateUnqualified");
  });

  /*
   * Next year before its activation. Ma81 is a teaching group of next year
   * whose one member still has this year's 7A as home class — the activation
   * moves her to next year's 8A, and the gateway's load report already reads
   * her there. Without the overlay Ma81 has no member in any class of its
   * year, so it gets no span and every behörighet in SO covers it: Bo's 1–6
   * would read as fine for an åk 8 group.
   */
  describe("next year, before its activation", () => {
    const nextYear = {
      id: "y2",
      name: "2027/2028",
      isActive: false,
      predecessorId: "y1",
      startDate: "2027-08-16",
      endDate: "2028-06-09",
    };
    beforeEach(() => {
      state.years = loaded([{ ...year, predecessorId: null }, nextYear] as never);
      state.groups = loaded([
        ...groups,
        { id: "g-8a", academicYearId: "y2", name: "8A", kind: "CLASS", gradeLevel: 8 },
        { id: "g-ma81", academicYearId: "y2", name: "Ma81", kind: "TEACHING_GROUP", gradeLevel: null },
      ]);
      state.memberships = loaded([{ studentGroupId: "g-ma81", studentId: "p-1" }] as never);
      state.requirementsByYear = { y1: requirements, y2: [] };
      state.rosters = {
        academicYearId: "y2",
        basis: "PROJECTED",
        homeClasses: [{ studentId: "p-1", studentGroupId: "g-8a" }],
        counts: { moved: 1, graduates: 0, unplaced: 0 },
        membershipsOutOfDate: { missing: 0, stale: 0 },
      };
      window.history.replaceState(null, "", "/?year=y2");
    });
    afterEach(() => window.history.replaceState(null, "", "/"));

    it("gives a teaching group the span of the class its members move into", async () => {
      await openTeacherPicker("cellLabel(Ma81|Samhällsorientering)");

      expect(state.rostersAskedFor).toContain("y2");
      expect(optionNamed("Anna Svensson")?.textContent).toContain("kindLEGITIMATION");
      expect(optionNamed("Bo Lind")?.textContent).toContain("candidateUnqualified");
    });

    it("reads Ma81 as yearless without the overlay — the case the overlay exists for", async () => {
      state.rosters = null;
      await openTeacherPicker("cellLabel(Ma81|Samhällsorientering)");

      expect(optionNamed("Bo Lind")?.textContent).toContain("kindBEHORIG");
    });

    it("asks for no rosters while this year is on screen", () => {
      window.history.replaceState(null, "", "/");
      render(<RequirementsPage />);

      expect(state.rostersAskedFor.every((id) => id === null)).toBe(true);
    });
  });

  it("shows no behörighet badge at all for a school that has recorded none, but still the minutes", async () => {
    state.qualifications = loaded([]);
    await openTeacherPicker("cellLabelPeriod(7A|Samhällsorientering|2|60|badgeOdd)");

    const annaOption = optionNamed("Anna Svensson");
    expect(annaOption?.textContent).not.toContain("kind");
    expect(annaOption?.textContent).not.toContain("candidateUnqualified");
    expect(annaOption?.textContent).toContain("candidateRemaining(120)");
  });

  it("says the badge is a note and not a gate, in the dialog itself", async () => {
    render(<RequirementsPage />);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("cellLabel(7A|Bild)"));
    expect(within(screen.getByRole("dialog")).getByText("candidateHint")).toBeTruthy();
  });
});

/**
 * Mål mode: the year's lokal timplan laid over the matrix.
 *
 * Its own fixture, all-weeks posts only, so every figure is its face value
 * per standardvecka and the cell texts can be asserted exactly — the
 * standardvecka weight of odd weeks is lib/timplan-planned.ts's and pinned by
 * its contract test. 7A follows a DECIDED plan for åk 7 that asks:
 *
 *   SO    180 min/vecka   planned 3 × 60 = 180   on target
 *   Slöjd  60 min/vecka   planned 1 × 40 =  40   20 under (amber)
 *   Bild   60 min/vecka   no post          =   0   unplanned (red)
 *   Övrigt  —             no post                  no target, the plain plus
 *
 * 7A's total is therefore 220 of 300 min/vecka, and one line of three is on
 * target (the roster is empty, so "covered" is the class's own posts).
 */
describe("Timplansposter in Mål mode", () => {
  const targetRequirements: RequirementFixture[] = [
    { ...requirements[0], id: "r-so", lessonsPerWeek: 3, recurrence: "ALL_WEEKS" },
    { ...requirements[1], id: "r-sl", lessonsPerWeek: 1, minutesPerLesson: 40, recurrence: "ALL_WEEKS" },
  ];
  const plan = (status: "DRAFT" | "DECIDED"): PlanFixture => ({
    id: "p-7",
    name: "Grundskola 2026",
    status,
    entries: [
      { id: "e-so", subjectId: "s-so", gradeLevel: 7, minutesPerWeek: 180, note: null },
      { id: "e-sl", subjectId: "s-sl", gradeLevel: 7, minutesPerWeek: 60, note: null },
      { id: "e-bi", subjectId: "s-bi", gradeLevel: 7, minutesPerWeek: 60, note: null },
    ],
  });
  const attach = (status: "DRAFT" | "DECIDED") => {
    state.yearTimplans = loaded([
      { gradeLevel: 7, localTimplanId: "p-7", planName: "Grundskola 2026", planStatus: status },
    ]);
    state.planDetails = { data: [plan(status)], isError: false };
  };

  const cellOf = (subjectName: string) =>
    within(screen.getByText("7A").closest("tr")!)
      .getAllByRole("button")
      .find((button) => button.getAttribute("aria-label")?.includes(`|${subjectName}`))!;

  /** Presses the toggle and waits for the lazily loaded module to paint. */
  const enterTargetMode = async () => {
    await userEvent.click(screen.getByRole("button", { name: "target.toggle" }));
    await screen.findByText("target.legend");
  };

  beforeEach(() => {
    state.requirements = loaded(targetRequirements);
    attach("DECIDED");
  });

  it("is off until pressed, and says so through aria-pressed", async () => {
    render(<RequirementsPage />);
    const toggle = screen.getByRole("button", { name: "target.toggle" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("180 / 180")).not.toBeInTheDocument();
    expect(screen.getByText("3×60")).toBeInTheDocument();

    await enterTargetMode();
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("paints each class cell planned / target, with the difference under it", async () => {
    render(<RequirementsPage />);
    await enterTargetMode();

    expect(within(cellOf("Samhällsorientering")).getByText("180 / 180")).toBeInTheDocument();
    expect(within(cellOf("Slöjd")).getByText("40 / 60")).toBeInTheDocument();
    expect(within(cellOf("Slöjd")).getByText("−20")).toBeInTheDocument();
    // A cell the plan asks for and nothing plans is no longer a quiet plus.
    expect(within(cellOf("Bild")).getByText("0 / 60")).toBeInTheDocument();
    // No target and no post: still the plus that adds one.
    expect(cellOf("Övrigt").textContent).toBe("");
  });

  // Review reproduction (P2 review, lens webb): Mål mode dropped the
  // recurrence badge, so an odd-weeks 3 × 60 read as an unexplained "90 / 180".
  it("keeps a weighted post's badge under its figures, so 90 / 180 says why", async () => {
    state.requirements = loaded([
      { ...targetRequirements[0]!, recurrence: "ODD_WEEKS" },
      targetRequirements[1]!,
    ]);
    render(<RequirementsPage />);
    await enterTargetMode();
    expect(within(cellOf("Samhällsorientering")).getByText("90 / 180")).toBeInTheDocument();
    expect(within(cellOf("Samhällsorientering")).getByText("badgeOdd")).toBeInTheDocument();
  });

  it("says under in amber and unplanned in red, and says both in words too", async () => {
    render(<RequirementsPage />);
    await enterTargetMode();

    expect(cellOf("Slöjd").className).toContain("bg-warning/15");
    expect(cellOf("Bild").className).toContain("border-destructive");
    expect(cellOf("Samhällsorientering").className).toContain("bg-accent/70");
    // The accessible name keeps what the cell is and adds the verdict.
    expect(cellOf("Slöjd")).toHaveAttribute(
      "aria-label",
      "cellLabelSet(7A|Slöjd|1|40). target.cellUnder(40|60|20|-20)",
    );
    expect(cellOf("Bild")).toHaveAttribute(
      "aria-label",
      "cellLabel(7A|Bild). target.cellUnplanned(0|60|60|-60)",
    );
  });

  it("adds a total column and a classes' total row in min/vecka and hours", async () => {
    render(<RequirementsPage />);
    await enterTargetMode();

    expect(within(matrix()).getByRole("columnheader", { name: "target.totalHeader" })).toBeInTheDocument();
    const row = screen.getByText("7A").closest("tr")!;
    // 220 of 300 per week; over the year's 43 teaching weeks 157,7 of 215 h.
    expect(within(row).getByText("220 / 300")).toBeInTheDocument();
    expect(within(row).getByText("157,7 h / 215 h")).toBeInTheDocument();
    // The year's hours stay the last column, where they were.
    expect(hoursFor("7A")).toBe("157,7 h");

    const totals = within(matrix()).getByRole("rowheader", { name: "target.totalsRow" }).closest("tr")!;
    expect(within(totals).getByText("180 / 180")).toBeInTheDocument();
    expect(within(totals).getByText("0 / 60")).toBeInTheDocument();
    expect(screen.getByText("target.total(220|300|157,7 h|215 h)")).toBeInTheDocument();
  });

  it("gives a class a Täckning pill linking to its coverage, and a teaching group none", async () => {
    render(<RequirementsPage />);
    await enterTargetMode();

    const pill = screen.getByRole("link", { name: "target.pillLabel(7A|1|3)" });
    expect(pill).toHaveTextContent("1/3");
    expect(pill).toHaveAttribute("href", "/admin/timplan/tackning?year=y1&group=g-7a");
    expect(within(screen.getByText("Ma71").closest("tr")!).queryByRole("link")).toBeNull();
  });

  it("leaves a teaching group's cells as they were", async () => {
    render(<RequirementsPage />);
    await enterTargetMode();
    const ma71 = within(screen.getByText("Ma71").closest("tr")!).getAllByRole("button");
    expect(ma71.every((button) => !button.getAttribute("aria-label")?.includes("target."))).toBe(true);
  });

  it("marks a draft plan as not decided, in the notice and on the pill", async () => {
    attach("DRAFT");
    render(<RequirementsPage />);
    await enterTargetMode();

    expect(screen.getByText("target.draft(Grundskola 2026|target.grade(7))")).toBeInTheDocument();
    const pill = screen.getByRole("link", { name: "target.pillLabelDraft(7A|1|3)" });
    expect(pill).toHaveTextContent("target.pillDraft");
  });

  it("says which årskurs follows no plan, and judges nothing against one", async () => {
    state.yearTimplans = loaded([]);
    state.planDetails = { data: [], isError: false };
    render(<RequirementsPage />);
    await enterTargetMode();

    expect(screen.getByText("target.unattached(target.grade(7))")).toBeInTheDocument();
    expect(within(cellOf("Samhällsorientering")).getByText("180 / –")).toBeInTheDocument();
    expect(screen.getByText("target.pillNoPlan")).toBeInTheDocument();
  });

  it("waits for the roster before it judges a class by its pupils", async () => {
    state.people = pending();
    render(<RequirementsPage />);
    await userEvent.click(screen.getByRole("button", { name: "target.toggle" }));

    expect(await screen.findByText("target.loading")).toBeInTheDocument();
    expect(screen.queryByText("180 / 180")).not.toBeInTheDocument();
  });

  it("says the targets could not be read, and paints no cell from half the data", async () => {
    state.planDetails = { data: undefined, isError: true };
    render(<RequirementsPage />);
    await userEvent.click(screen.getByRole("button", { name: "target.toggle" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("target.failed");
    expect(screen.getByText("3×60")).toBeInTheDocument();
  });

  it("goes back to the posts when pressed again", async () => {
    render(<RequirementsPage />);
    await enterTargetMode();
    await userEvent.click(screen.getByRole("button", { name: "target.toggle" }));

    expect(screen.queryByText("180 / 180")).not.toBeInTheDocument();
    expect(screen.getByText("3×60")).toBeInTheDocument();
    expect(within(matrix()).queryByRole("columnheader", { name: "target.totalHeader" })).toBeNull();
  });

  it("says in the cell dialog what the timplan asks, and follows the fields", async () => {
    render(<RequirementsPage />);
    await enterTargetMode();
    await userEvent.click(cellOf("Samhällsorientering"));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("target.hintMet(180|target.grade(7)|3|60|180|0|0)"),
    ).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText("lessonsPerWeek"), { target: { value: "2" } });
    expect(
      within(dialog).getByText("target.hintUnder(180|target.grade(7)|2|60|120|60|-60)"),
    ).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText("lessonsPerWeek"), { target: { value: "" } });
    expect(within(dialog).getByText("target.hintTarget(180|target.grade(7)|0|0|0|0|0)")).toBeInTheDocument();
  });

  it("tells a teaching group's dialog where its pupils are judged", async () => {
    render(<RequirementsPage />);
    await enterTargetMode();
    await userEvent.click(
      within(screen.getByText("Ma71").closest("tr")!).getAllByRole("button")[0]!,
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("target.hintTeachingGroup")).toBeInTheDocument();
  });

  it("has no hint in the dialog outside Mål mode", async () => {
    render(<RequirementsPage />);
    await userEvent.click(cellOf("Samhällsorientering"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText(/target\.hint/)).toBeNull();
  });
});
