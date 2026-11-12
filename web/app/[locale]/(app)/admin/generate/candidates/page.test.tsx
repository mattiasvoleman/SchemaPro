import { render as renderPlain, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import CandidatesPage from "./page";

/*
 * /admin/generate/candidates, in the generate page's test style: every read
 * is a stub the test sets, every write a spy, next-intl an echo of the key
 * and its values — so what is asserted is which sentence the page chose and
 * what it handed it, not the Swedish.
 *
 * The håltimmar and the week sheet are the page's lazy modules, loaded for
 * real: the figures asserted below are lib/gaps.ts's own, on a school small
 * enough to count by hand.
 */

function render(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = renderPlain(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  // A rerender keeps the same client, as the page would.
  const rerender = (next: React.ReactElement) =>
    result.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>);
  return { ...result, rerender };
}

const ACTIVE = { id: "y-1", name: "2026/27", isActive: true, predecessorId: null, startDate: "2026-08-17", endDate: "2027-06-11" };

const person = (id: string, role: string, firstName: string, studentGroupId: string | null = null) => ({
  id, role, firstName, lastName: "Ek", email: `${id}@x`, phone: null, isActive: true, invitedAt: null, studentGroupId,
});

let seq = 0;
const master = (
  studentGroupId: string,
  subjectId: string,
  teacherId: string,
  dayOfWeek: number,
  start: string,
  end: string,
  overrides: Record<string, unknown> = {},
) => ({
  id: `m-${++seq}`, academicYearId: "y-1", subjectId, studentGroupId, teacherId, coTeacherId: null, roomId: "r-1", dayOfWeek,
  startTime: `${start}:00`, endTime: `${end}:00`, isLocked: false, isParked: false, isGenerated: true, recurrence: "ALL_WEEKS",
  startDate: null, endDate: null, extraGroupIds: [], studentIds: [], ...overrides,
});
const placed = (studentGroupId: string, subjectId: string, teacherId: string, dayOfWeek: number, startTime: string, endTime: string) => ({
  requirementId: `req-${studentGroupId}-${subjectId}`, subjectId, studentGroupId, teacherId, coTeacherId: null, roomId: "r-1",
  dayOfWeek, startTime, endTime, recurrence: "ALL_WEEKS", startDate: null, endDate: null,
});

/*
 * The draft: 7A has Ma at 08 and 11 on Monday (a two-hour hole for 7A and
 * Anna), 7B has a locked Sv at 08 on Tuesday and a generated one at 09.
 * Förslag 1 keeps it all. Förslag 2 closes Anna's hole and opens one for Bo:
 * the school's teacher total stays, and Bo is whom it gets worse for.
 */
const DRAFT = [
  master("g-7a", "s-ma", "t-1", 1, "08:00", "09:00"),
  master("g-7a", "s-ma", "t-1", 1, "11:00", "12:00"),
  master("g-7b", "s-sv", "t-2", 2, "08:00", "09:00", { isLocked: true }),
  master("g-7b", "s-sv", "t-2", 2, "09:00", "10:00"),
];
const KEPT = [
  placed("g-7a", "s-ma", "t-1", 1, "08:00", "09:00"),
  placed("g-7a", "s-ma", "t-1", 1, "11:00", "12:00"),
  placed("g-7b", "s-sv", "t-2", 2, "09:00", "10:00"),
];
const MOVED = [
  placed("g-7a", "s-ma", "t-1", 1, "08:00", "09:00"),
  placed("g-7a", "s-ma", "t-1", 1, "09:00", "10:00"),
  placed("g-7b", "s-sv", "t-2", 2, "11:00", "12:00"),
];

const RUN = {
  id: "run-1", status: "SUCCEEDED", requested: 3, progress: 3, createdAt: "2026-10-17T08:00:00.000Z",
  startedAt: "2026-10-17T08:00:01.000Z", finishedAt: "2026-10-17T08:01:30.000Z", error: null, errorCode: null,
  errorParams: null, createdById: "u-1", createdByName: "Ada Admin", appliedCandidateId: null, appliedAt: null, refreshOfId: null,
};
const candidate = (ordinal: number, variant: string, overrides: Record<string, unknown> = {}) => ({
  id: `c-${ordinal}`, ordinal, variant, weights: null, solverStatus: "OPTIMAL", lessonCount: 3, errorCode: null, errorParams: null,
  metrics: { moved: 0, movedOf: 3, roomChanges: 0, kept: 3, sameAs: null }, conflicts: [], ...overrides,
});
const BATCH = {
  run: RUN,
  candidates: [
    candidate(1, "KEEP"),
    candidate(2, "TEACHER_GAPS", { metrics: { moved: 2, movedOf: 3, roomChanges: 0, kept: 1, sameAs: null } }),
    candidate(3, "SPREAD", { solverStatus: "TIMEOUT", metrics: null }),
  ],
};
const CHECK = { stale: false, changed: [], refusalCode: null, mode: "DRAFT", futureCalendarLessons: 0, coverAssignments: 0 };

const state = vi.hoisted(() => ({
  overview: undefined as unknown,
  check: undefined as unknown,
  checkFetching: false,
  checkPaused: false,
  checkRefetch: vi.fn(),
  checkFailed: false,
  lessons: {} as Record<string, unknown>,
  origin: undefined as unknown,
}));

const apiGet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { get: apiGet },
}));

/*
 * One array per read, made once: react-query hands a page the same data
 * until it changes, and the page's measuring rests on that — a new array on
 * every render would have it measure every week again, every render.
 */
const SCHOOL = vi.hoisted(() => ({
  years: [] as unknown[],
  subjects: [{ id: "s-ma", name: "Matematik" }, { id: "s-sv", name: "Svenska" }],
  groups: [
    { id: "g-7a", academicYearId: "y-1", name: "7A", kind: "CLASS", gradeLevel: 7, halfOfId: null },
    { id: "g-7b", academicYearId: "y-1", name: "7B", kind: "CLASS", gradeLevel: 7, halfOfId: null },
    // A teaching group nobody is in unless a test says so: the figures above are the classes' alone.
    { id: "g-ma71", academicYearId: "y-1", name: "Ma71", kind: "TEACHING_GROUP", gradeLevel: 7, halfOfId: null },
  ],
  rooms: [{ id: "r-1", name: "Sal 1" }],
  people: [] as unknown[],
  /** The teaching-group rows; emptied before every test. */
  memberships: [] as unknown[],
  empty: [] as unknown[],
}));
SCHOOL.years.push(ACTIVE);
SCHOOL.people.push(
  person("t-1", "TEACHER", "Anna"),
  person("t-2", "TEACHER", "Bo"),
  person("p-1", "STUDENT", "Cia", "g-7a"),
  person("p-2", "STUDENT", "Dan", "g-7b"),
);

vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({ data: SCHOOL.years, isLoading: false, isError: false }),
  useSubjects: () => ({ data: SCHOOL.subjects }),
  useGroups: () => ({ data: SCHOOL.groups }),
  useRooms: () => ({ data: SCHOOL.rooms }),
  usePeople: () => ({ data: SCHOOL.people }),
  useConstraints: () => ({ data: SCHOOL.empty }),
  useGroupMemberships: () => ({ data: SCHOOL.memberships }),
  useFrameTimes: () => ({ data: SCHOOL.empty }),
  useLunchSettings: () => ({ data: null }),
  useRequirements: () => ({ data: SCHOOL.empty }),
}));

const start = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
const apply = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
const discard = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
vi.mock("../use-schedule-candidates", () => ({
  useScheduleCandidates: () => ({ data: state.overview, isLoading: false, isError: false }),
  useStartCandidates: () => start,
}));
vi.mock("./use-candidate-details", () => ({
  useCandidateCheck: (runId: string | null) => ({
    data: runId ? state.check : undefined,
    isLoading: false,
    isError: state.checkFailed,
    isFetching: state.checkFetching,
    fetchStatus: state.checkFetching ? "fetching" : state.checkPaused ? "paused" : "idle",
    refetch: state.checkRefetch,
  }),
  useCandidateLessons: (() => {
    // A stable answer per call pattern, as the real hook's combine gives;
    // a test that sets other lessons under the same ids gets them too.
    let last: { key: string; source: unknown; value: unknown } | null = null;
    return (ids: string[]) => {
      const key = ids.join(",") + JSON.stringify(Object.keys(state.lessons));
      if (last?.key !== key || last.source !== state.lessons) {
        last = {
          key,
          source: state.lessons,
          value: {
            byId: new Map(ids.filter((id) => state.lessons[id]).map((id) => [id, state.lessons[id]])),
            failed: new Set(ids.filter((id) => state.lessons[id] === "failed")),
          },
        };
      }
      return last.value;
    };
  })(),
  useOriginMasters: () => ({ data: state.origin, isError: false }),
  useApplyCandidate: () => apply,
  useDiscardCandidates: () => discard,
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${namespace}.${key}(${Object.values(values).join("|")})` : `${namespace}.${key}`;
    return Object.assign(t, { has: () => true });
  },
}));

beforeEach(() => {
  apiGet.mockReset();
  start.mutateAsync.mockReset();
  apply.mutateAsync.mockReset();
  discard.mutateAsync.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  state.overview = { latest: BATCH, batch: BATCH, unplaced: { lines: 0, minutes: 0, draftLines: 1, draftMinutes: 40 } };
  state.check = CHECK;
  state.checkFetching = false;
  state.checkPaused = false;
  state.checkRefetch = vi.fn();
  state.checkFailed = false;
  state.origin = DRAFT;
  state.lessons = { "c-1": KEPT, "c-2": MOVED };
  SCHOOL.memberships.length = 0;
});

const table = () => screen.getByRole("table", { name: "scheduleCandidates.table.caption" });
const applyButton = (ordinal: number, variant: string) =>
  screen.getByRole("button", { name: `scheduleCandidates.apply.buttonLabel(${ordinal}|scheduleCandidates.variant.${variant})` });

describe("the comparison table", () => {
  it("sets each candidate beside the current draft, with headers on both axes", () => {
    render(<CandidatesPage />);

    const heads = within(table()).getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(heads).toEqual([
      "scheduleCandidates.table.measure",
      "scheduleCandidates.table.currentDraft",
      "scheduleCandidates.table.candidate(1)scheduleCandidates.variant.KEEP",
      "scheduleCandidates.table.candidate(2)scheduleCandidates.variant.TEACHER_GAPS",
      "scheduleCandidates.table.candidate(3)scheduleCandidates.variant.SPREADscheduleCandidates.solver.TIMEOUT",
    ]);
    const moved = within(table()).getByRole("rowheader", { name: /scheduleCandidates\.row\.moved/ }).closest("tr")!;
    expect([...moved.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual([
      "—scheduleCandidates.cell.notApplicable",
      "scheduleCandidates.cell.movedOf(0|3)",
      "scheduleCandidates.cell.movedOf(2|3)",
      "scheduleCandidates.cell.notApplicable",
    ]);
  });

  it("shows the unplaced figure once for the run, with its difference from the draft", () => {
    render(<CandidatesPage />);

    const row = within(table()).getByRole("rowheader", { name: /scheduleCandidates\.row\.unplaced/ }).closest("tr")!;
    const cells = row.querySelectorAll("td");
    expect(cells).toHaveLength(2);
    expect(cells[0]!.textContent).toBe("scheduleCandidates.cell.unplaced(1|40)");
    expect(cells[1]!.getAttribute("colspan")).toBe("3");
    expect(cells[1]!.textContent).toContain("scheduleCandidates.cell.unplaced(0|0)");
    expect(cells[1]!.textContent).toContain("scheduleCandidates.cell.delta(−scheduleCandidates.cell.lines(1))");
  });

  it("fills the håltimmar rows from lib/gaps.ts once the lazy module has measured every week", async () => {
    render(<CandidatesPage />);

    const teachers = within(table()).getByRole("rowheader", { name: /scheduleCandidates\.row\.teachers/ }).closest("tr")!;
    // The first import of the lazy module (lib/gaps, lib/conflicts) is the
    // slow part on a loaded runner; waitFor's default second is not a bound
    // on the page, only on this test's patience.
    await waitFor(() => expect(teachers.querySelector('[aria-busy="true"]')).toBeNull(), { timeout: 10_000 });
    const cells = [...teachers.querySelectorAll("td")].map((cell) => cell.textContent);
    // Now: Anna's two hours. Förslag 1 keeps them; Förslag 2 trades them for Bo's.
    expect(cells[0]).toContain("scheduleCandidates.cell.minutes(120)");
    expect(cells[0]).toContain("scheduleCandidates.cell.teachersDetail(1|120)");
    expect(cells[1]).toContain("scheduleCandidates.cell.delta(±scheduleCandidates.cell.minutes(0))");
    expect(cells[2]).toContain("scheduleCandidates.cell.minutes(120)");
    expect(cells[3]).toBe("scheduleCandidates.cell.notApplicable");

    const pupils = within(table()).getByRole("rowheader", { name: /scheduleCandidates\.row\.pupils/ }).closest("tr")!;
    const pupilCells = [...pupils.querySelectorAll("td")].map((cell) => cell.textContent);
    // Now Cia waits 120 minutes of 7A's Monday; Förslag 2 hands the same two
    // hours to Dan's Tuesday in 7B. Two pupils in the year's classes either way.
    expect(pupilCells[0]).toContain("scheduleCandidates.cell.perPupil(60)");
    expect(pupilCells[0]).toContain("scheduleCandidates.cell.pupilsDetail(1|120)");
    expect(pupilCells[2]).toContain("scheduleCandidates.cell.perPupil(60)");
    expect(pupilCells[2]).toContain("scheduleCandidates.cell.delta(±scheduleCandidates.cell.minutes(0))");
  });

  /*
   * Önskad ledig dag: the gateway measured each candidate and the draft when
   * it stored them, and names the teachers; the page counts them, says the
   * difference from the draft, and lists whom and which weekday.
   */
  describe("the free-day wishes", () => {
    const wish = (day: number, names: string[]) => ({
      category: "AVAILABILITY",
      code: "TEACHER_FREE_DAY_WISH_NOT_KEPT",
      params: { day },
      message: "A teacher wishes … free",
      resourceNames: names,
    });
    const wishesRow = () =>
      [...within(table()).getByRole("rowheader", { name: /scheduleCandidates\.row\.wishes/ }).closest("tr")!.querySelectorAll("td")].map(
        (cell) => cell.textContent,
      );

    it("counts each candidate's against the draft's, and names the teacher and the weekday under it", () => {
      state.overview = {
        latest: BATCH,
        batch: {
          ...BATCH,
          candidates: [
            candidate(1, "KEEP", { notes: [wish(1, ["Anna Ek"])] }),
            candidate(2, "TEACHER_GAPS", { notes: [] }),
            candidate(3, "SPREAD", { solverStatus: "TIMEOUT", metrics: null, notes: null }),
          ],
        },
        unplaced: null,
        draftNotes: [wish(1, ["Anna Ek"]), wish(5, [])],
      };
      render(<CandidatesPage />);

      expect(wishesRow()).toEqual([
        // A teacher no longer in the school is "a teacher", not a blank.
        "scheduleCandidates.cell.wishes(2)scheduleCandidates.cell.wish(Anna Ek|1)scheduleCandidates.cell.wish(scheduleCandidates.cell.wishNobody|5)",
        "scheduleCandidates.cell.wishes(1)scheduleCandidates.cell.delta(−scheduleCandidates.cell.wishCount(1))scheduleCandidates.cell.wish(Anna Ek|1)",
        "scheduleCandidates.cell.wishes(0)scheduleCandidates.cell.delta(−scheduleCandidates.cell.wishCount(2))",
        "scheduleCandidates.cell.notApplicable",
      ]);
    });

    it("tells a limit on teaching in a row from a free-day wish, counts both as wishes, and names the teacher with the figures", () => {
      // Sammanhängande undervisning: the same notes list, so the same row.
      // One teacher can have both kinds, which is why the count is of wishes
      // and not of teachers.
      const stretch = (day: number, minutes: number, max: number, names: string[]) => ({
        category: "AVAILABILITY",
        code: "TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT",
        params: { day, minutes, max, breakMinutes: 20 },
        message: "A teacher should teach at most … in a row",
        resourceNames: names,
      });
      state.overview = {
        latest: BATCH,
        batch: {
          ...BATCH,
          candidates: [
            candidate(1, "KEEP", { notes: [wish(1, ["Anna Ek"]), stretch(2, 240, 180, ["Anna Ek"])] }),
            candidate(2, "TEACHER_GAPS", { notes: [stretch(2, 240, 180, ["Anna Ek"])] }),
            candidate(3, "SPREAD", { solverStatus: "TIMEOUT", metrics: null, notes: null }),
          ],
        },
        unplaced: null,
        draftNotes: [wish(1, ["Anna Ek"]), stretch(2, 240, 180, ["Anna Ek"]), stretch(4, 210, 180, [])],
      };
      render(<CandidatesPage />);

      expect(wishesRow()).toEqual([
        "scheduleCandidates.cell.wishes(3)scheduleCandidates.cell.wish(Anna Ek|1)scheduleCandidates.cell.stretch(Anna Ek|2|240|180)scheduleCandidates.cell.stretch(scheduleCandidates.cell.wishNobody|4|210|180)",
        "scheduleCandidates.cell.wishes(2)scheduleCandidates.cell.delta(−scheduleCandidates.cell.wishCount(1))scheduleCandidates.cell.wish(Anna Ek|1)scheduleCandidates.cell.stretch(Anna Ek|2|240|180)",
        "scheduleCandidates.cell.wishes(1)scheduleCandidates.cell.delta(−scheduleCandidates.cell.wishCount(2))scheduleCandidates.cell.stretch(Anna Ek|2|240|180)",
        "scheduleCandidates.cell.notApplicable",
      ]);
    });

    it("draws the limit on teaching in a row as one sentence with no name and no figure for a reader without HR-läs", () => {
      // The limit is HR (set on the post): the gateway sends
      // TEACHER_CONSECUTIVE_TEACHING_HIDDEN, one note, params {}, no names. The
      // row counts it as a wish and reads nothing else off it — even a name
      // that slipped into resourceNames is not drawn.
      const hidden = (names: string[] = []) => ({
        category: "AVAILABILITY",
        code: "TEACHER_CONSECUTIVE_TEACHING_HIDDEN",
        params: {},
        message: "The new timetable does not keep a teacher's limit on teaching in a row.",
        resourceNames: names,
      });
      state.overview = {
        latest: BATCH,
        batch: {
          ...BATCH,
          candidates: [
            candidate(1, "KEEP", { notes: [wish(1, ["Anna Ek"]), hidden()] }),
            candidate(2, "TEACHER_GAPS", { notes: [hidden(["Anna Ek"])] }),
            candidate(3, "SPREAD", { solverStatus: "TIMEOUT", metrics: null, notes: null }),
          ],
        },
        unplaced: null,
        draftNotes: [wish(1, ["Anna Ek"]), hidden()],
      };
      render(<CandidatesPage />);

      expect(wishesRow()).toEqual([
        "scheduleCandidates.cell.wishes(2)scheduleCandidates.cell.wish(Anna Ek|1)scheduleCandidates.cell.stretchHidden",
        "scheduleCandidates.cell.wishes(2)scheduleCandidates.cell.delta(±scheduleCandidates.cell.wishCount(0))scheduleCandidates.cell.wish(Anna Ek|1)scheduleCandidates.cell.stretchHidden",
        "scheduleCandidates.cell.wishes(1)scheduleCandidates.cell.delta(−scheduleCandidates.cell.wishCount(1))scheduleCandidates.cell.stretchHidden",
        "scheduleCandidates.cell.notApplicable",
      ]);
    });

    it("says not measured for a batch stored before the gateway measured them, and no difference without the draft's", () => {
      state.overview = {
        latest: BATCH,
        batch: { ...BATCH, candidates: [candidate(1, "KEEP"), candidate(2, "TEACHER_GAPS", { notes: [wish(3, ["Bo Ek"])] })] },
        unplaced: null,
      };
      render(<CandidatesPage />);

      expect(wishesRow()).toEqual([
        "scheduleCandidates.cell.notMeasured",
        "scheduleCandidates.cell.notMeasured",
        "scheduleCandidates.cell.wishes(1)scheduleCandidates.cell.wish(Bo Ek|3)",
      ]);
    });
  });

  it("says a duplicate is the same as an earlier proposal", () => {
    state.overview = {
      latest: null,
      batch: { ...BATCH, candidates: [BATCH.candidates[0], candidate(2, "TEACHER_GAPS", { metrics: { moved: 0, movedOf: 3, roomChanges: 0, kept: 3, sameAs: 1 } })] },
      unplaced: null,
    };
    render(<CandidatesPage />);

    expect(within(table()).getByText("scheduleCandidates.table.sameAs(1)")).toBeInTheDocument();
  });
});

describe("reviewing a candidate", () => {
  it("names the teachers it gets worse for and lists what it moves", async () => {
    render(<CandidatesPage />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("scheduleCandidates.review.pick"), "c-2");

    expect(await screen.findByText("scheduleCandidates.worse.row(Bo Ek|0|120)")).toBeInTheDocument();
    const moved = screen.getByRole("table", { name: /scheduleCandidates\.moved\.caption/ });
    const rows = within(moved).getAllByRole("row").slice(1).map((row) => row.textContent);
    expect(rows).toEqual([
      "7AMatematikscheduleCandidates.moved.slot(days.1|11:00|12:00)scheduleCandidates.moved.slot(days.1|09:00|10:00)Sal 1",
      "7BSvenskascheduleCandidates.moved.slot(days.2|09:00|10:00)scheduleCandidates.moved.slot(days.2|11:00|12:00)Sal 1",
    ]);
  });

  it("says when a candidate keeps everything where it is", async () => {
    render(<CandidatesPage />);

    expect(screen.getByText("scheduleCandidates.moved.none")).toBeInTheDocument();
    expect(await screen.findByText("scheduleCandidates.worse.none")).toBeInTheDocument();
  });

  it("draws a class's week of the candidate with the shared week sheet", async () => {
    render(<CandidatesPage />);

    expect(await screen.findByRole("heading", { level: 2, name: "7A" })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("scheduleCandidates.week.kind"), "TEACHER");
    expect(await screen.findByRole("heading", { level: 2, name: "Anna Ek" })).toBeInTheDocument();
  });

  it("puts a teaching group's lesson on the week of the class its pupils come from, and offers the group itself", async () => {
    // Cia's home is 7A and she is in Ma71: the candidate's Wednesday Ma71
    // maths is an hour of 7A's week, as on the timetable's class filter.
    SCHOOL.memberships.push({ studentId: "p-1", studentGroupId: "g-ma71" });
    state.lessons = { "c-1": [...KEPT, placed("g-ma71", "s-ma", "t-1", 3, "08:00", "09:00")], "c-2": MOVED };
    render(<CandidatesPage />);

    const week = screen.getByRole("region", {
      name: "scheduleCandidates.week.title(scheduleCandidates.candidateName(1|scheduleCandidates.variant.KEEP))",
    });
    // The sheet itself, not the week region: the target select names Ma71 too.
    // The lazy sheet's first import can be slow when this test runs alone.
    const heading = await within(week).findByRole("heading", { level: 2, name: "7A" }, { timeout: 5000 });
    const sheet = heading.closest("header")!.parentElement!;
    expect(within(sheet).getAllByText("Sal 1 · Anna Ek · Ma71").length).toBeGreaterThan(0);

    const target = within(week).getByLabelText("scheduleCandidates.week.kindGROUP");
    expect(within(target).getByRole("group", { name: "scheduleCandidates.week.classes" })).toBeInTheDocument();
    const groups = within(target).getByRole("group", { name: "scheduleCandidates.week.teachingGroups" });
    expect(within(groups).getByRole("option", { name: "Ma71" })).toBeInTheDocument();
    await userEvent.setup().selectOptions(target, "g-ma71");
    expect(await within(week).findByRole("heading", { level: 2, name: "Ma71" })).toBeInTheDocument();
  });
});

describe("applying", () => {
  it("in DRAFT: a plain confirmation that names the mode it saw, then a toast naming the safety version", async () => {
    apply.mutateAsync.mockResolvedValue({ lessonsCreated: 3, versionId: "v-1" });
    render(<CandidatesPage />);
    const user = userEvent.setup();

    await user.click(applyButton(2, "TEACHER_GAPS"));
    const dialog = screen.getByRole("dialog", { name: "scheduleCandidates.apply.titleDraft(2|scheduleCandidates.variant.TEACHER_GAPS)" });
    expect(within(dialog).getByText("scheduleCandidates.apply.bodyDraft")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "scheduleCandidates.apply.confirm" }));

    expect(apply.mutateAsync).toHaveBeenCalledWith({ candidateId: "c-2", expectedMode: "DRAFT" });
    expect(toast.success).toHaveBeenCalledWith("scheduleCandidates.applied.toast(2|3)", expect.anything());
    const description = renderPlain(<>{toast.success.mock.calls[0]![1].description}</>);
    expect(description.container.textContent).toContain(
      "scheduleCandidates.applied.version(Före schemaförslag 2 – Färre håltimmar för lärarna)",
    );
    expect(within(description.container).getByRole("link", { name: "scheduleCandidates.applied.versionsLink" })).toHaveAttribute(
      "href",
      "/admin/timetable",
    );
    expect(within(description.container).queryByRole("link", { name: "scheduleCandidates.applied.publishingLink" })).toBeNull();
  });

  it("in DIRECT: says the calendar loses its upcoming lessons, counts them, and offers draft mode first", async () => {
    state.check = { ...CHECK, mode: "DIRECT", futureCalendarLessons: 12, coverAssignments: 3 };
    apply.mutateAsync.mockResolvedValue({ lessonsCreated: 3, versionId: "v-1" });
    render(<CandidatesPage />);
    const user = userEvent.setup();

    expect(within(table()).getByRole("columnheader", { name: "scheduleCandidates.table.currentSchedule" })).toBeInTheDocument();
    await user.click(applyButton(1, "KEEP"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("scheduleCandidates.apply.bodyDirect")).toBeInTheDocument();
    expect(within(dialog).getByText("scheduleCandidates.apply.futureLessons(12)")).toBeInTheDocument();
    expect(within(dialog).getByText("scheduleCandidates.apply.coverAssignments(3)")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "scheduleCandidates.apply.switchFirst" })).toHaveAttribute(
      "href",
      "/admin/publishing",
    );

    await user.click(within(dialog).getByRole("button", { name: "scheduleCandidates.apply.direct" }));
    expect(apply.mutateAsync).toHaveBeenCalledWith({ candidateId: "c-1", expectedMode: "DIRECT" });
    const description = renderPlain(<>{toast.success.mock.calls[0]![1].description}</>);
    expect(within(description.container).getByRole("link", { name: "scheduleCandidates.applied.publishingLink" })).toHaveAttribute(
      "href",
      "/admin/publishing",
    );
  });

  it("reads the check again as the dialog opens, holds the confirm until it is back, and refuses one it finds stale", async () => {
    state.checkFetching = true;
    const { rerender } = render(<CandidatesPage />);
    const user = userEvent.setup();

    await user.click(applyButton(2, "TEACHER_GAPS"));
    // Opening the dialog reads the check again: its counts and verdict are the moment's.
    expect(state.checkRefetch).toHaveBeenCalledTimes(1);
    let dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("scheduleCandidates.apply.checking")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "scheduleCandidates.apply.confirm" })).toBeDisabled();

    // The read comes back: the draft has moved under the batch since the page loaded.
    state.checkFetching = false;
    state.check = { ...CHECK, stale: true, changed: ["draft"] };
    rerender(<CandidatesPage />);
    dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("scheduleCandidates.apply.noLonger")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "scheduleCandidates.apply.confirm" })).toBeDisabled();
    expect(apply.mutateAsync).not.toHaveBeenCalled();
  });

  it("confirms nothing on the page-load counts when the dialog's re-read fails, and offers it again", async () => {
    state.check = { ...CHECK, mode: "DIRECT", futureCalendarLessons: 12, coverAssignments: 3 };
    const { rerender } = render(<CandidatesPage />);
    const user = userEvent.setup();

    await user.click(applyButton(1, "KEEP"));
    expect(state.checkRefetch).toHaveBeenCalledTimes(1);
    // The re-read fails (a 429 from the check's throttle, the network): the
    // data in hand is still the page load's, and it must not be confirmed on.
    state.checkFailed = true;
    rerender(<CandidatesPage />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("scheduleCandidates.check.failed")).toBeInTheDocument();
    expect(within(dialog).queryByText("scheduleCandidates.apply.futureLessons(12)")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "scheduleCandidates.apply.direct" })).toBeDisabled();

    await user.click(within(dialog).getByRole("button", { name: "scheduleCandidates.check.retry" }));
    expect(state.checkRefetch).toHaveBeenCalledTimes(2);
    expect(apply.mutateAsync).not.toHaveBeenCalled();
  });

  it("holds the confirm while the re-read is paused offline, not fetching and not failed", async () => {
    state.check = { ...CHECK, mode: "DIRECT", futureCalendarLessons: 12, coverAssignments: 3 };
    const { rerender } = render(<CandidatesPage />);
    const user = userEvent.setup();

    await user.click(applyButton(1, "KEEP"));
    state.checkPaused = true;
    rerender(<CandidatesPage />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("scheduleCandidates.apply.checking")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "scheduleCandidates.apply.direct" })).toBeDisabled();
  });

  it("hands focus to the reason, not to <body>, when the dialog closes over a Tillämpa the failed re-read disabled", async () => {
    const { rerender } = render(<CandidatesPage />);
    const user = userEvent.setup();

    await user.click(applyButton(2, "TEACHER_GAPS"));
    state.checkFailed = true;
    rerender(<CandidatesPage />);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "common.cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(applyButton(2, "TEACHER_GAPS")).toBeDisabled();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.textContent).toContain("scheduleCandidates.check.failed");
  });

  it("offers nothing to apply for a candidate without a timetable", () => {
    render(<CandidatesPage />);
    expect(screen.queryByRole("button", { name: /apply\.buttonLabel\(3/ })).toBeNull();
  });

  it.each([
    ["PUBLISH_MODE_CHANGED", undefined, "scheduleCandidates.errors.PUBLISH_MODE_CHANGED"],
    ["SCHEDULE_CANDIDATE_BUSY", undefined, "scheduleCandidates.errors.SCHEDULE_CANDIDATE_BUSY"],
    ["SCHEDULE_CANDIDATE_NOT_APPLICABLE", undefined, "scheduleCandidates.errors.SCHEDULE_CANDIDATE_NOT_APPLICABLE"],
    ["GENERATE_RUNNING", undefined, "scheduleCandidates.errors.GENERATE_RUNNING"],
    ["SCHEDULE_CANDIDATE_STALE", undefined, "scheduleCandidates.errors.SCHEDULE_CANDIDATE_STALE"],
    ["PUBLISH_IN_PROGRESS", undefined, "scheduleCandidates.errors.PUBLISH_IN_PROGRESS"],
    [
      "SCHEDULE_CANDIDATE_STALE",
      { changed: ["draft", "rooms"] },
      "scheduleCandidates.errors.SCHEDULE_CANDIDATE_STALE_PARTS(scheduleCandidates.parts.draft och scheduleCandidates.parts.rooms)",
    ],
  ])("says a %s refusal in Swedish", async (code, params, sentence) => {
    apply.mutateAsync.mockRejectedValue(new ApiError(409, "Refused.", code, params as never));
    render(<CandidatesPage />);
    const user = userEvent.setup();

    await user.click(applyButton(2, "TEACHER_GAPS"));
    await user.click(screen.getByRole("button", { name: "scheduleCandidates.apply.confirm" }));
    expect(toast.error).toHaveBeenCalledWith(sentence);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("a batch the draft has moved away from", () => {
  it("names what changed, offers Uppdatera förslagen, and holds every apply back", async () => {
    state.check = { ...CHECK, stale: true, changed: ["requirements", "rooms"] };
    start.mutateAsync.mockResolvedValue({ runId: "run-2" });
    render(<CandidatesPage />);

    const banner = screen.getByRole("status", { name: "" });
    expect(banner.textContent).toContain("scheduleCandidates.stale.title");
    expect(banner.textContent).toContain(
      "scheduleCandidates.stale.body(scheduleCandidates.parts.requirements och scheduleCandidates.parts.rooms)",
    );
    const button = applyButton(1, "KEEP");
    expect(button).toBeDisabled();
    expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toContain("scheduleCandidates.stale.title");

    await userEvent.setup().click(within(banner).getByRole("button", { name: "scheduleCandidates.stale.refresh" }));
    expect(start.mutateAsync).toHaveBeenCalledWith({ academicYearId: "y-1", refreshOf: "run-1" });
  });

  it("names a refusal today's draft would meet", () => {
    state.check = { ...CHECK, refusalCode: "STAFF_UNSTAFFED_REQUIREMENTS" };
    render(<CandidatesPage />);

    expect(screen.getByText("scheduleCandidates.refusal.STAFF_UNSTAFFED_REQUIREMENTS")).toBeInTheDocument();
    expect(applyButton(2, "TEACHER_GAPS")).toBeDisabled();
  });

  it("names the refusal, and offers no refresh, in the shape the gateway sends it: stale with no part named", () => {
    // A refresh would meet the same refusal; the grundschema did not change.
    state.check = { ...CHECK, stale: true, changed: [], refusalCode: "STAFF_UNSTAFFED_REQUIREMENTS" };
    render(<CandidatesPage />);

    expect(screen.getByText("scheduleCandidates.refusal.STAFF_UNSTAFFED_REQUIREMENTS")).toBeInTheDocument();
    expect(screen.queryByText("scheduleCandidates.stale.title")).toBeNull();
    expect(screen.queryByRole("button", { name: "scheduleCandidates.stale.refresh" })).toBeNull();
    expect(applyButton(2, "TEACHER_GAPS")).toBeDisabled();
  });

  it("holds the applies back, and says so, when the check could not be made", () => {
    state.check = undefined;
    state.checkFailed = true;
    render(<CandidatesPage />);

    expect(screen.getByRole("alert").textContent).toContain("scheduleCandidates.check.failed");
    expect(applyButton(2, "TEACHER_GAPS")).toBeDisabled();
  });

  it("says which proposal was applied, where its safety version is, and that the rest compare against it", () => {
    state.overview = {
      latest: { ...BATCH, run: { ...RUN, appliedCandidateId: "c-2", appliedAt: "2026-10-17T09:00:00.000Z" } },
      batch: { ...BATCH, run: { ...RUN, appliedCandidateId: "c-2", appliedAt: "2026-10-17T09:00:00.000Z" } },
      unplaced: null,
    };
    render(<CandidatesPage />);

    expect(
      screen.getByText("scheduleCandidates.applied.title(scheduleCandidates.candidateName(2|scheduleCandidates.variant.TEACHER_GAPS))"),
    ).toBeInTheDocument();
    expect(screen.getByText("scheduleCandidates.applied.version(Före schemaförslag 2 – Färre håltimmar för lärarna)")).toBeInTheDocument();
    expect(within(table()).getByText("scheduleCandidates.table.applied")).toBeInTheDocument();
  });
});

describe("a run that is not a batch", () => {
  const latest = (overrides: Record<string, unknown>, candidates: unknown[] = []) => ({ run: { ...RUN, id: "run-2", ...overrides }, candidates });

  it("shows a running run's progress as 'N av M klara' and lets the admin cancel it", async () => {
    state.overview = { latest: latest({ status: "RUNNING", progress: 2, finishedAt: null }), batch: null, unplaced: null };
    discard.mutateAsync.mockResolvedValue(undefined);
    render(<CandidatesPage />);

    expect(screen.getByText("scheduleCandidates.progress.count(2|3)")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "scheduleCandidates.progress.label" })).toHaveAttribute("value", "2");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "scheduleCandidates.progress.cancel" }));
    const dialog = screen.getByRole("dialog", { name: "scheduleCandidates.discard.titleActive" });
    await user.click(within(dialog).getByRole("button", { name: "scheduleCandidates.discard.confirmActive" }));
    expect(discard.mutateAsync).toHaveBeenCalledWith("y-1");
  });

  it("keeps an older batch comparable while a refresh runs, and holds its applies back", () => {
    state.overview = { latest: latest({ status: "RUNNING", progress: 1, finishedAt: null }), batch: BATCH, unplaced: null };
    render(<CandidatesPage />);

    expect(table()).toBeInTheDocument();
    const button = applyButton(1, "KEEP");
    expect(button).toBeDisabled();
    expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe(
      "scheduleCandidates.apply.blockedRunning",
    );
  });

  it("shows what stopped the first candidate, which stops them all", () => {
    state.overview = {
      latest: latest({ status: "FAILED", errorCode: "CANDIDATES_FIRST_FAILED" }, [
        candidate(1, "KEEP", {
          solverStatus: "INFEASIBLE",
          metrics: null,
          conflicts: [
            {
              category: "DINING_CAPACITY",
              code: "LUNCH_SEATS_CAP",
              params: { seats: 115 },
              message: "The dining hall's 115 seats are all it holds at one time.",
              resourceNames: ["4A", "4B"],
            },
          ],
        }),
      ]),
      batch: null,
      unplaced: null,
    };
    render(<CandidatesPage />);

    expect(screen.getByText("scheduleCandidates.runErrors.CANDIDATES_FIRST_FAILED")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "scheduleCandidates.failed.conflicts" })).toBeInTheDocument();
    expect(screen.getByText("conflictCategories.DINING_CAPACITY")).toBeInTheDocument();
    expect(screen.getByText("engineMessages.LUNCH_SEATS_CAP(115)")).toBeInTheDocument();
    expect(screen.getByText("4A, 4B")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "scheduleCandidates.failed.again" })).toHaveAttribute(
      "href",
      "/admin/generate#candidates",
    );
  });

  it("says where a post's days are shown when a hidden days sentence stopped the first candidate, and only then", () => {
    const stoppedBy = (code: string) => ({
      latest: latest({ status: "FAILED", errorCode: "CANDIDATES_FIRST_FAILED" }, [
        candidate(1, "KEEP", {
          solverStatus: "INFEASIBLE",
          metrics: null,
          conflicts: [{ category: "AVAILABILITY", code, params: {}, message: "m", resourceNames: [] }],
        }),
      ]),
      batch: null,
      unplaced: null,
    });
    state.overview = stoppedBy("TEACHER_WORK_DAYS_HIDDEN");
    const { unmount } = render(<CandidatesPage />);
    expect(screen.getByText(/^engineMessages\.TEACHER_WORK_DAYS_HIDDEN/)).toBeInTheDocument();
    expect(screen.getByText("scheduleCandidates.failed.daysWhere")).toBeInTheDocument();
    unmount();

    state.overview = stoppedBy("LUNCH_SEATS_CAP");
    render(<CandidatesPage />);
    expect(screen.queryByText("scheduleCandidates.failed.daysWhere")).toBeNull();
  });

  it("says where a post's days are shown when the run itself failed on them", () => {
    state.overview = {
      latest: latest({ status: "FAILED", errorCode: "TEACHER_WORK_DAYS_HIDDEN" }, []),
      batch: null,
      unplaced: null,
    };
    render(<CandidatesPage />);

    expect(screen.getByText("scheduleCandidates.failed.daysWhere")).toBeInTheDocument();
  });

  it("says the engine's summary of the first candidate's week above its causes", () => {
    state.overview = {
      latest: latest({ status: "FAILED", errorCode: "CANDIDATES_FIRST_FAILED" }, [
        candidate(1, "KEEP", {
          solverStatus: "INFEASIBLE",
          errorCode: "STAFF_UNSTAFFED_REQUIREMENTS",
          errorParams: { count: 2 },
          metrics: null,
          conflicts: [{ category: "INSUFFICIENT_RESOURCES", message: "2 requirements have no teacher.", resourceNames: ["7A"] }],
        }),
      ]),
      batch: null,
      unplaced: null,
    };
    render(<CandidatesPage />);

    expect(screen.getByText("scheduleCandidates.runErrors.CANDIDATES_FIRST_FAILED")).toBeInTheDocument();
    const causes = screen.getByRole("heading", { name: "scheduleCandidates.failed.conflicts" }).closest("section")!;
    expect(within(causes).getByText("engineMessages.STAFF_UNSTAFFED_REQUIREMENTS(2)")).toBeInTheDocument();
    expect(within(causes).getByText("conflictCategories.INSUFFICIENT_RESOURCES")).toBeInTheDocument();
  });

  it("terminer: says which weeks the first candidate's refusal was counted for, once, and nothing for one that names none", () => {
    const refused = (errorParams: Record<string, string | number>, lineParams?: Record<string, string | number>) => ({
      latest: latest({ status: "FAILED", errorCode: "CANDIDATES_FIRST_FAILED" }, [
        candidate(1, "KEEP", {
          solverStatus: "INFEASIBLE",
          errorCode: "DEMAND_TEACHER_HOURS_SHORT",
          errorParams,
          metrics: null,
          conflicts: [
            {
              category: "REQUIREMENT_DEMAND",
              message: "One teacher gives the lessons of 14 requirements.",
              resourceNames: ["Hemkunskap 7A"],
              ...(lineParams ? { params: lineParams } : {}),
            },
          ],
        }),
      ]),
      batch: null,
      unplaced: null,
    });
    const period = { period: 2, periodFrom: "2027-01-11", periodTo: "2027-01-17", periodStretches: 1 };
    state.overview = refused({ teachers: 1, ...period }, { requirements: 14, ...period });
    const first = render(<CandidatesPage />);

    let causes = screen.getByRole("heading", { name: "scheduleCandidates.failed.conflicts" }).closest("section")!;
    // Once, from the summary, though the line under it names the same weeks.
    expect(within(causes).getAllByText("generate.countedInPeriod(11 januari 2027|17 januari 2027|no|ALL)")).toHaveLength(1);
    first.unmount();

    // A summary that names no weeks beside a line that does: the line's weeks are said.
    state.overview = refused({ teachers: 1 }, { requirements: 14, ...period, periodStretches: 2 });
    const second = render(<CandidatesPage />);
    causes = screen.getByRole("heading", { name: "scheduleCandidates.failed.conflicts" }).closest("section")!;
    expect(within(causes).getAllByText("generate.countedInPeriod(11 januari 2027|17 januari 2027|yes|ALL)")).toHaveLength(1);
    second.unmount();

    state.overview = refused({ teachers: 1 });
    render(<CandidatesPage />);
    causes = screen.getByRole("heading", { name: "scheduleCandidates.failed.conflicts" }).closest("section")!;
    expect(within(causes).queryByText(/generate\.countedInPeriod/)).toBeNull();
  });

  it("klassens lunch: says which parts of the läsår the locks are in, under the refusal and under a line", () => {
    const lunch = { group: "7A", minutes: 30, windowStart: "11:00", windowEnd: "12:00", day: 1 };
    const dated = {
      ...lunch,
      lockPeriods: "0;2",
      lockFrom: "2026-08-17",
      lockTo: "2026-12-20",
      otherLockFrom: "2027-01-11",
      otherLockTo: "2027-06-11",
      lockWeeksElsewhere: 0,
    };
    const NOTE = "generate.lunchLocksInPeriods(17 augusti 2026|20 december 2026|11 januari 2027|11 juni 2027|no)";
    const refused = (errorParams: Record<string, string | number>, lineParams: Record<string, string | number>) => ({
      latest: latest({ status: "FAILED", errorCode: "CANDIDATES_FIRST_FAILED" }, [
        candidate(1, "KEEP", {
          solverStatus: null,
          errorCode: "LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK",
          errorParams,
          metrics: null,
          conflicts: [
            {
              category: "PLACEMENT",
              code: "LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK",
              message: "Locked lessons leave student group 7A no lunch break.",
              resourceNames: ["7A"],
              params: lineParams,
            },
          ],
        }),
      ]),
      batch: null,
      unplaced: null,
    });
    // Under the first candidate's own refusal.
    state.overview = refused(dated, lunch);
    const first = render(<CandidatesPage />);
    let causes = screen.getByRole("heading", { name: "scheduleCandidates.failed.conflicts" }).closest("section")!;
    expect(within(causes).getAllByText(NOTE)).toHaveLength(1);
    expect(within(causes).getAllByText(/^engineMessages\.LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK\(/)[0]!.nextElementSibling).toHaveTextContent(NOTE);
    first.unmount();

    // Under the line that carries it, before the line's names.
    state.overview = refused(lunch, dated);
    const second = render(<CandidatesPage />);
    causes = screen.getByRole("heading", { name: "scheduleCandidates.failed.conflicts" }).closest("section")!;
    const note = within(causes).getByText(NOTE);
    expect(note.previousElementSibling).toHaveTextContent(/^engineMessages\.LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK\(/);
    expect(note.nextElementSibling).toHaveTextContent(/^7A$/);
    second.unmount();

    // One period's locks alone: nothing is added anywhere.
    state.overview = refused(lunch, lunch);
    render(<CandidatesPage />);
    causes = screen.getByRole("heading", { name: "scheduleCandidates.failed.conflicts" }).closest("section")!;
    expect(within(causes).queryByText(/generate\.lunchLocksInPeriods/)).toBeNull();
  });

  it("says a first candidate that ran out of time in its own words, with what the probe found", () => {
    // Candidate 1 TIMEOUT, no relaxation helped: the engine's summary and
    // no conflicts. "What stopped it is below" over nothing was the bug.
    state.overview = {
      latest: latest({ status: "FAILED", errorCode: "CANDIDATES_FIRST_FAILED" }, [
        candidate(1, "KEEP", {
          solverStatus: "TIMEOUT",
          errorCode: "PROBE_NOTHING_HELPED",
          errorParams: { budget: 60, rules: 3, slice: 8 },
          metrics: null,
          conflicts: [],
        }),
      ]),
      batch: null,
      unplaced: null,
    };
    render(<CandidatesPage />);

    expect(screen.getByText("scheduleCandidates.runErrors.CANDIDATES_FIRST_TIMEOUT")).toBeInTheDocument();
    expect(screen.queryByText("scheduleCandidates.runErrors.CANDIDATES_FIRST_FAILED")).toBeNull();
    const causes = screen.getByRole("heading", { name: "scheduleCandidates.failed.conflicts" }).closest("section")!;
    expect(within(causes).getByText("engineMessages.PROBE_NOTHING_HELPED(60|3|8)")).toBeInTheDocument();
    expect(within(causes).queryByRole("list")).toBeNull();
  });

  it("promises nothing below when the first candidate came back with nothing to list", () => {
    state.overview = {
      latest: latest({ status: "FAILED", errorCode: "CANDIDATES_FIRST_FAILED" }, [
        candidate(1, "KEEP", { solverStatus: "INFEASIBLE", metrics: null, conflicts: [] }),
      ]),
      batch: null,
      unplaced: null,
    };
    render(<CandidatesPage />);

    expect(screen.getByText("scheduleCandidates.runErrors.CANDIDATES_FIRST_FAILED_UNNAMED")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "scheduleCandidates.failed.conflicts" })).toBeNull();
  });

  it("points back to Generera when the year has no proposals at all", () => {
    state.overview = { latest: null, batch: null, unplaced: null };
    render(<CandidatesPage />);

    expect(screen.getByText("scheduleCandidates.page.emptyTitle")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "scheduleCandidates.page.emptyAction" })).toHaveAttribute(
      "href",
      "/admin/generate#candidates",
    );
  });

  it("says the proposals are kept for 7 days", () => {
    render(<CandidatesPage />);
    expect(screen.getByText("scheduleCandidates.section.retention")).toBeInTheDocument();
  });
});

/*
 * Bästa möjliga schema: the candidate of the mode, its avsteg, and the tick
 * that the apply of one needs. The gateway has already masked what a reader may
 * not see; these tests hold what the page does with the lists it is handed.
 */
describe("Bästa möjliga schema", () => {
  const deviation = (code: string, params: Record<string, string | number>, resourceNames: string[] = []) => ({
    category: "DEVIATION",
    code,
    params,
    message: `English for ${code}`,
    resourceNames,
  });
  const CAP = deviation("DEVIATION_TEACHER_DAILY_CAP", { minutes: 360, day: 2 }, ["Anna Ek"]);
  const LOCK = deviation("DEVIATION_ROOM_LOCK", { lessons: 1, of: 2 });
  const bestEffort = (overrides: Record<string, unknown> = {}, ordinal = 1) =>
    candidate(ordinal, "BEST_EFFORT", { deviations: [CAP, LOCK], deviationsDigest: `digest-${ordinal}`, ...overrides });
  const batchOf = (...candidates: unknown[]) => ({
    run: { ...RUN, requested: candidates.length, progress: candidates.length },
    candidates,
  });
  const show = (...candidates: unknown[]) => {
    const batch = batchOf(...candidates);
    state.overview = { latest: batch, batch, unplaced: { lines: 0, minutes: 0, draftLines: 1, draftMinutes: 40 } };
  };
  const head = (ordinal: number) =>
    within(table()).getByRole("columnheader", { name: new RegExp(`scheduleCandidates\\.table\\.candidate\\(${ordinal}\\)`) });
  const confirmButton = () => screen.getByRole("button", { name: "scheduleCandidates.apply.confirm" });
  const accept = () => screen.getByRole("checkbox", { name: "scheduleCandidates.apply.acceptDeviations" });

  describe("marking", () => {
    it("marks a candidate with avsteg, with their number, in its column and in a row of their own", () => {
      show(bestEffort());
      render(<CandidatesPage />);

      expect(head(1)).toHaveTextContent("scheduleCandidates.table.withDeviations(2)");
      expect(head(1)).toHaveTextContent("scheduleCandidates.variant.BEST_EFFORT");
      const row = within(table()).getByRole("rowheader", { name: /^scheduleCandidates\.row\.deviations(?!Hint)/ }).closest("tr")!;
      expect([...row.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual([
        "—scheduleCandidates.cell.notApplicable",
        "scheduleCandidates.cell.deviations(2)",
      ]);
    });

    it("marks nothing for a candidate whose list is null, and nothing for one whose list is empty", () => {
      // null: the candidate is not from the mode. []: the mode ran and nothing
      // gave way, which is a result and not an avsteg.
      show(candidate(1, "KEEP", { deviations: null }), bestEffort({ deviations: [], deviationsDigest: null }, 2));
      render(<CandidatesPage />);

      expect(head(1)).not.toHaveTextContent("withDeviations");
      expect(head(2)).not.toHaveTextContent("withDeviations");
      // The row is there, since one candidate came from the mode: 0 for it, not applicable for the other.
      const row = within(table()).getByRole("rowheader", { name: /^scheduleCandidates\.row\.deviations(?!Hint)/ }).closest("tr")!;
      expect([...row.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual([
        "—scheduleCandidates.cell.notApplicable",
        "scheduleCandidates.cell.notApplicable",
        "scheduleCandidates.cell.deviations(0)",
      ]);
    });

    it.each([
      ["absent (a gateway from before the mode)", {}],
      ["null", { deviations: null }],
    ])("draws no row and no mark in a batch of the ordinary kind whose field is %s", (_, fields) => {
      show(candidate(1, "KEEP", fields), candidate(2, "SPREAD", fields));
      render(<CandidatesPage />);

      expect(within(table()).queryByRole("rowheader", { name: /^scheduleCandidates\.row\.deviations(?!Hint)/ })).toBeNull();
      expect(table().textContent).not.toContain("withDeviations");
    });
  });

  describe("reviewing", () => {
    it("lists the avsteg as sentences in a list, with the names the gateway put beside them", () => {
      show(bestEffort());
      render(<CandidatesPage />);

      expect(screen.getByRole("heading", { name: "scheduleCandidates.review.deviationsTitle" })).toBeInTheDocument();
      const list = screen.getByRole("list", { name: "scheduleCandidates.review.deviationsTitle" });
      const items = within(list).getAllByRole("listitem");
      expect(items.map((item) => item.textContent)).toEqual([
        "engineMessages.DEVIATION_TEACHER_DAILY_CAP(360|2)Anna Ek",
        "engineMessages.DEVIATION_ROOM_LOCK(1|2)",
      ]);
    });

    it("says that nothing gave way for a run of the mode with an empty list, and draws no list", () => {
      show(bestEffort({ deviations: [], deviationsDigest: null }));
      render(<CandidatesPage />);

      expect(screen.getByText("scheduleCandidates.review.deviationsNone")).toBeInTheDocument();
      expect(screen.queryByRole("list", { name: "scheduleCandidates.review.deviationsTitle" })).toBeNull();
    });

    it("draws no avsteg section for a candidate that did not come from the mode", () => {
      render(<CandidatesPage />);
      expect(screen.queryByRole("heading", { name: "scheduleCandidates.review.deviationsTitle" })).toBeNull();
    });

    it.each([
      ["the hidden code", deviation("TEACHER_WORK_DAYS_HIDDEN", {}, ["Anna Ek"])],
      ["the deviation's own code with its days taken out", deviation("DEVIATION_TEACHER_WORK_DAYS", { limit: "Tjänst", over: 1 }, ["Anna Ek"])],
    ])("says a post's days as hidden, in a deviation's words and with no name, for %s", (_, masked) => {
      show(bestEffort({ deviations: [masked] }));
      render(<CandidatesPage />);

      const list = screen.getByRole("list", { name: "scheduleCandidates.review.deviationsTitle" });
      expect(list.textContent).toBe("scheduleCandidates.deviations.daysHidden");
    });
  });

  describe("applying", () => {
    it("lists the avsteg in the dialog and holds both confirms until they are ticked", async () => {
      show(bestEffort());
      apply.mutateAsync.mockResolvedValue({ lessonsCreated: 3, versionId: "v-1" });
      render(<CandidatesPage />);
      const user = userEvent.setup();

      await user.click(applyButton(1, "BEST_EFFORT"));
      const dialog = screen.getByRole("dialog");
      const list = within(dialog).getByRole("list", { name: "scheduleCandidates.apply.deviationsTitle(2)" });
      expect(within(list).getAllByRole("listitem")).toHaveLength(2);
      expect(accept()).not.toBeChecked();
      expect(confirmButton()).toBeDisabled();

      // A press on a button that is held does nothing.
      await user.click(confirmButton());
      expect(apply.mutateAsync).not.toHaveBeenCalled();

      await user.click(accept());
      expect(accept()).toBeChecked();
      expect(confirmButton()).toBeEnabled();
      await user.click(confirmButton());
      expect(apply.mutateAsync).toHaveBeenCalledWith({
        candidateId: "c-1",
        expectedMode: "DRAFT",
        acceptedDeviations: "digest-1",
      });
    });

    it("puts focus on the tick when the dialog opens, and gives it back to the button that opened it", async () => {
      show(bestEffort());
      render(<CandidatesPage />);
      const user = userEvent.setup();

      const opener = applyButton(1, "BEST_EFFORT");
      await user.click(opener);
      // The list above it has nothing to press; the tick is the first thing to do.
      await waitFor(() => expect(accept()).toHaveFocus());

      await user.click(screen.getByRole("button", { name: "common.cancel" }));
      await waitFor(() => expect(opener).toHaveFocus());
    });

    it("gives the box a label of its own and describes it by the count, so a screen reader hears what is accepted", async () => {
      show(bestEffort());
      render(<CandidatesPage />);

      await userEvent.setup().click(applyButton(1, "BEST_EFFORT"));
      const dialog = screen.getByRole("dialog");
      const described = document.getElementById(accept().getAttribute("aria-describedby") ?? "");
      expect(described?.textContent).toBe("scheduleCandidates.apply.deviationsTitle(2)");
      expect(within(dialog).getByText("scheduleCandidates.apply.deviationsIntro")).toBeInTheDocument();
    });

    it("sends the digest of the candidate that is applied, not of another in the batch", async () => {
      show(bestEffort({ deviationsDigest: "digest-1" }), bestEffort({ deviations: [LOCK] }, 2));
      apply.mutateAsync.mockResolvedValue({ lessonsCreated: 3, versionId: "v-1" });
      render(<CandidatesPage />);
      const user = userEvent.setup();

      await user.click(applyButton(2, "BEST_EFFORT"));
      await user.click(accept());
      await user.click(confirmButton());

      expect(apply.mutateAsync).toHaveBeenCalledTimes(1);
      expect(apply.mutateAsync).toHaveBeenCalledWith({ candidateId: "c-2", expectedMode: "DRAFT", acceptedDeviations: "digest-2" });
    });

    it("takes the digest from the check when the candidate came without one", async () => {
      show(bestEffort({ deviationsDigest: null }));
      state.check = { ...CHECK, deviations: [CAP, LOCK], deviationsDigest: "digest-from-check" };
      apply.mutateAsync.mockResolvedValue({ lessonsCreated: 3, versionId: "v-1" });
      render(<CandidatesPage />);
      const user = userEvent.setup();

      await user.click(applyButton(1, "BEST_EFFORT"));
      await user.click(accept());
      await user.click(confirmButton());

      expect(apply.mutateAsync).toHaveBeenCalledWith({
        candidateId: "c-1",
        expectedMode: "DRAFT",
        acceptedDeviations: "digest-from-check",
      });
    });

    it.each([
      ["an empty list", { deviations: [], deviationsDigest: null }],
      ["an empty list that still carries a digest", { deviations: [], deviationsDigest: "left-over" }],
      ["no list at all", { deviations: null, deviationsDigest: "left-over" }],
      ["a gateway that sends neither field", {}],
    ])("asks for no tick and sends no digest for a candidate with %s", async (_, fields) => {
      show(candidate(1, "KEEP", fields));
      apply.mutateAsync.mockResolvedValue({ lessonsCreated: 3, versionId: "v-1" });
      render(<CandidatesPage />);
      const user = userEvent.setup();

      await user.click(applyButton(1, "KEEP"));
      expect(screen.queryByRole("checkbox")).toBeNull();
      expect(confirmButton()).toBeEnabled();
      await user.click(confirmButton());

      // Exactly the body of an ordinary apply: not even an undefined key.
      expect(apply.mutateAsync).toHaveBeenCalledTimes(1);
      expect(Object.keys(apply.mutateAsync.mock.calls[0]![0]).sort()).toEqual(["candidateId", "expectedMode"]);
    });

    it("holds the tick to one opening: closed and opened again, it is not ticked", async () => {
      show(bestEffort());
      render(<CandidatesPage />);
      const user = userEvent.setup();

      await user.click(applyButton(1, "BEST_EFFORT"));
      await user.click(accept());
      expect(confirmButton()).toBeEnabled();
      await user.click(screen.getByRole("button", { name: "common.cancel" }));
      expect(screen.queryByRole("dialog")).toBeNull();

      await user.click(applyButton(1, "BEST_EFFORT"));
      expect(accept()).not.toBeChecked();
      expect(confirmButton()).toBeDisabled();
    });

    it("keeps holding the confirm while the check is being read, ticked or not", async () => {
      show(bestEffort());
      state.checkFetching = true;
      render(<CandidatesPage />);
      const user = userEvent.setup();

      await user.click(applyButton(1, "BEST_EFFORT"));
      await user.click(accept());
      expect(confirmButton()).toBeDisabled();
    });

    it("also holds the direct confirm until the tick, and keeps the way round to draft mode", async () => {
      show(bestEffort());
      state.check = { ...CHECK, mode: "DIRECT", futureCalendarLessons: 4, coverAssignments: 0 };
      apply.mutateAsync.mockResolvedValue({ lessonsCreated: 3, versionId: "v-1" });
      render(<CandidatesPage />);
      const user = userEvent.setup();

      await user.click(applyButton(1, "BEST_EFFORT"));
      const direct = screen.getByRole("button", { name: "scheduleCandidates.apply.direct" });
      expect(direct).toBeDisabled();
      expect(screen.getByRole("link", { name: "scheduleCandidates.apply.switchFirst" })).toBeInTheDocument();
      await user.click(accept());
      await user.click(direct);
      expect(apply.mutateAsync).toHaveBeenCalledWith({
        candidateId: "c-1",
        expectedMode: "DIRECT",
        acceptedDeviations: "digest-1",
      });
    });

    it("says in words that the avsteg were not accepted as they stand when the gateway refuses", async () => {
      show(bestEffort());
      apply.mutateAsync.mockRejectedValue(
        new ApiError(409, "Refused.", "SCHEDULE_CANDIDATE_DEVIATIONS_NOT_ACCEPTED", { count: 2 }),
      );
      render(<CandidatesPage />);
      const user = userEvent.setup();

      await user.click(applyButton(1, "BEST_EFFORT"));
      await user.click(accept());
      await user.click(confirmButton());
      expect(toast.error).toHaveBeenCalledWith("scheduleCandidates.errors.SCHEDULE_CANDIDATE_DEVIATIONS_NOT_ACCEPTED");
    });
  });

  describe("a run of the mode that found nothing to place", () => {
    const failed = (overrides: Record<string, unknown> = {}) => ({
      latest: {
        run: { ...RUN, id: "run-2", status: "FAILED", errorCode: "CANDIDATES_FIRST_FAILED", requested: 1, progress: 1 },
        candidates: [candidate(1, "BEST_EFFORT", { solverStatus: "INFEASIBLE", metrics: null, conflicts: [], ...overrides })],
      },
      batch: null,
      unplaced: null,
    });

    it("does not speak of other candidates, since there are none", () => {
      state.overview = failed({
        conflicts: [{ category: "TEACHER_OVERLAP", code: "TEACHER_DOUBLE_BOOKED", params: { n: 2 }, message: "x", resourceNames: ["Bo Ek"] }],
      });
      render(<CandidatesPage />);

      expect(screen.getByText("scheduleCandidates.runErrors.BEST_EFFORT_FAILED")).toBeInTheDocument();
      expect(screen.queryByText("scheduleCandidates.runErrors.CANDIDATES_FIRST_FAILED")).toBeNull();
      expect(screen.getByRole("heading", { name: "scheduleCandidates.failed.conflictsBestEffort" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "scheduleCandidates.failed.conflicts" })).toBeNull();
    });

    it("says that it ran out of time in the mode's own words", () => {
      state.overview = failed({ solverStatus: "TIMEOUT" });
      render(<CandidatesPage />);

      expect(screen.getByText("scheduleCandidates.runErrors.BEST_EFFORT_TIMEOUT")).toBeInTheDocument();
    });
  });
});
