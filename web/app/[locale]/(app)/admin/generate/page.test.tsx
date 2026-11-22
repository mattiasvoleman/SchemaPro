import { act, cleanup, render as renderPlain, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import GeneratePage from "./page";

/**
 * With a real react-query client: the year choice's rosters request goes
 * through useQuery (lib/planning-year.ts), and whether it is MADE is one of
 * the things asserted below. Only the gateway call itself is a spy.
 */
function render(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderPlain(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/**
 * The first test file this page has had. The warning it covers is the only
 * thing here that decides whether a school learns BEFORE a run that some of its
 * lessons will ignore the rasts — the grid afterwards shows the band and the
 * lesson on top of it, never why.
 */

const state = vi.hoisted(() => ({
  job: undefined as unknown,
  /** Message keys this build has no translation for; see the next-intl stub. */
  untranslated: [] as string[],
  requirements: [] as unknown[] | undefined,
  /** Delade lektioner: GET /teaching-requirements/shares. */
  shares: [] as unknown[],
  groups: [] as unknown[],
  memberships: [] as unknown[],
  people: [] as unknown[],
  /** StaffingPolicy as GET /staffing-policy answers; undefined = not answered yet. */
  policy: undefined as unknown,
  /** The year's uppdrag, as GET /teacher-duties answers; and the year it was asked for. */
  duties: [] as unknown[],
  dutiesFor: [] as unknown[],
  // undefined with neither flag below is a read never made; with one, the
  // years on their way or failed.
  years: [] as unknown[] | undefined,
  yearsLoading: false,
  yearsFailed: false,
  /** The last read of the timplan failed (a first read, or a refetch over one in hand). */
  requirementsFailed: false,
  /** The year's runs; undefined is a list never read. */
  history: [] as unknown[] | undefined,
  historyFailed: false,
  /** The year each year-keyed read was asked for, in order. */
  requirementsFor: [] as (string | null)[],
  historyFor: [] as (string | null)[],
  /** GET candidates?academicYearId= as useScheduleCandidates answers; undefined = none read. */
  candidates: undefined as unknown,
  /** GET /lunch-settings as useLunchSettings answers: Skolregler, null = none defined. */
  lunch: null as unknown,
  /** The week's board as the row before a run reads it (A3); undefined = not read, or failed. */
  placementBoard: undefined as unknown,
  placementBoardFor: [] as (string | null)[],
}));

const ACTIVE = {
  id: "y-1",
  name: "2026/27",
  isActive: true,
  predecessorId: null,
  startDate: "2026-08-17",
  endDate: "2027-06-11",
};
const NEXT = {
  id: "y-2",
  name: "2027/28",
  isActive: false,
  predecessorId: "y-1",
  startDate: "2027-08-16",
  endDate: "2028-06-09",
};

/** GET /academic-years/:id/rosters, and every other gateway read, as one spy. */
const apiGet = vi.hoisted(() => vi.fn());
/** POST /optimization/week-check: Kontrollera veckan, asked by its own button and before every run. */
const apiPost = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { get: apiGet, post: apiPost },
}));

/** A check that finds nothing: the answer every test that is about something else gets. */
const OK_CHECK = {
  verdict: "OK",
  years: [],
  conflicts: null,
  skipped: ["LUNCH_STAGE"],
  elapsedMs: 40,
  checkedBy: "ENGINE",
};

const noMutation = { mutateAsync: vi.fn(), isPending: false };
/** The two reads the page asks to be made again: the year's history, the candidates overview. */
const historyRefetch = vi.hoisted(() => vi.fn());
const candidatesRefetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/requirement-shares", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/requirement-shares")>()),
  useRequirementShares: () => ({ data: state.shares }),
}));

vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({
    data: state.years,
    isLoading: state.yearsLoading,
    isError: state.yearsFailed,
  }),
  useRequirements: (yearId: string | null) => {
    state.requirementsFor.push(yearId);
    return { data: state.requirements, isError: state.requirementsFailed };
  },
  useRooms: () => ({ data: [{ id: "r-1" }] }),
  usePeople: () => ({ data: state.people }),
  useGroups: () => ({ data: state.groups }),
  useGroupMemberships: () => ({ data: state.memberships }),
  useStartOptimization: () => noMutation,
  useOptimizationJob: () => ({ data: state.job }),
  useOptimizationHistory: (yearId: string | null) => {
    state.historyFor.push(yearId);
    // Disabled without a year, as the real hook is: never asked, never failed.
    return yearId === null
      ? { data: undefined, isLoading: false, isError: false, refetch: historyRefetch }
      : { data: state.history, isLoading: false, isError: state.historyFailed, refetch: historyRefetch };
  },
  useLunchSettings: () => ({ data: state.lunch }),
}));

vi.mock("@/lib/placement-board-queries", () => ({
  usePlacementBoard: (yearId: string | null) => {
    state.placementBoardFor.push(yearId);
    return { data: state.placementBoard };
  },
}));

vi.mock("@/lib/staffing-queries", () => ({
  useStaffingPolicy: () => ({ data: state.policy }),
  useTeacherDuties: (yearId: unknown) => {
    state.dutiesFor.push(yearId);
    return { data: state.duties };
  },
}));

/*
 * Schemaförslag's hooks, page-local (./use-schedule-candidates). Mocked so
 * the gateway spy above sees only the reads this file is about; the
 * section's own behaviour is candidates-section.test.tsx's. Here the newest
 * run matters only for whether Generera waits for it.
 */
vi.mock("./use-schedule-candidates", () => ({
  useScheduleCandidates: () => ({ data: state.candidates, isLoading: false, isError: false, refetch: candidatesRefetch }),
  useStartCandidates: () => noMutation,
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  // The page asks `.has(key)` before translating — for a conflict category and
  // for an engine sentence — so the echo carries a `has` too. Every key is
  // "known" unless a test says otherwise through `state.untranslated`, which
  // is how the fallback gets exercised: the engine ships a sentence this build
  // has no Swedish for, and the admin must still read something.
  useTranslations: (namespace: string) => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values
        ? `${namespace}.${key}(${Object.values(values).join("|")})`
        : `${namespace}.${key}`;
    return Object.assign(t, { has: (key: string) => !state.untranslated.includes(key) });
  },
}));

const requirement = (studentGroupId: string) => ({
  id: `req-${studentGroupId}`,
  subjectId: "s-1",
  studentGroupId,
  teacherId: "t-1",
  lessonsPerWeek: 2,
  minutesPerLesson: 60,
});
const pupil = (id: string, studentGroupId: string) => ({
  id,
  role: "STUDENT",
  isActive: true,
  firstName: "E",
  lastName: "Lev",
  email: `${id}@x`,
  phone: null,
  invitedAt: null,
  studentGroupId,
});

beforeEach(() => {
  cleanup();
  apiGet.mockReset();
  apiPost.mockReset();
  apiPost.mockResolvedValue(OK_CHECK);
  historyRefetch.mockReset();
  candidatesRefetch.mockReset();
  state.years = [ACTIVE];
  state.yearsLoading = false;
  state.yearsFailed = false;
  state.requirementsFailed = false;
  state.shares = [];
  state.history = [];
  state.historyFailed = false;
  state.requirementsFor = [];
  state.historyFor = [];
  state.job = undefined;
  state.policy = undefined;
  state.duties = [];
  state.dutiesFor = [];
  state.untranslated = [];
  state.candidates = undefined;
  state.lunch = null;
  state.placementBoard = undefined;
  state.placementBoardFor = [];
  state.groups = [
    { id: "g-41", academicYearId: "y-1", name: "4.1", kind: "CLASS", gradeLevel: 4 },
    { id: "g-sl1", academicYearId: "y-1", name: "4sl1", kind: "TEACHING_GROUP", gradeLevel: null },
    { id: "g-ma1", academicYearId: "y-1", name: "4ma1", kind: "TEACHING_GROUP", gradeLevel: null },
  ];
  state.people = [pupil("p-1", "g-41")];
  // 4ma1 has a member whose home class is year four; 4sl1 has nobody.
  state.memberships = [{ studentId: "p-1", studentGroupId: "g-ma1" }];
  state.requirements = [requirement("g-sl1"), requirement("g-ma1"), requirement("g-41")];
});

describe("the teachers the run has (an administrator who teaches counts: Users.teaches)", () => {
  const teachersLine = () => screen.getByText("generate.preTeachers").closest("li") as HTMLElement;
  const staff = (id: string, role: string, extra: Record<string, unknown> = {}) => ({
    ...pupil(id, "g-41"),
    role,
    studentGroupId: null,
    firstName: "Lärare",
    lastName: id,
    ...extra,
  });

  it("counts active teachers and active administrators who teach, and not an administrator who does not, nor anybody who has left", () => {
    state.people.push(
      staff("t-1", "TEACHER"),
      staff("t-2", "TEACHER", { isActive: false }),
      staff("a-1", "SCHOOL_ADMIN", { teaches: true }),
      staff("a-2", "SCHOOL_ADMIN", { teaches: true, isActive: false }),
      staff("a-3", "SCHOOL_ADMIN"),
    );
    render(<GeneratePage />);
    expect(within(teachersLine()).getByText("2")).toBeInTheDocument();
  });

  it("is not satisfied by an administrator who does not teach", () => {
    state.people.push(staff("a-3", "SCHOOL_ADMIN"));
    render(<GeneratePage />);
    expect(within(teachersLine()).getByText("0")).toBeInTheDocument();
  });
});

describe("uppdrag with dates and fixed times (20261017090000)", () => {
  const duty = (overrides: Record<string, unknown>) => ({
    id: "d-1", userId: "t-1", academicYearId: "y-1", kind: "RASTVAKT", label: "Rastvakt", minutesPerWeek: 40,
    countsAsTeaching: false, subjectId: null, studentGroupId: null, validFrom: null, validTo: null,
    slots: [{ dayOfWeek: 1, startTime: "10:00", endTime: "10:20" }], note: null, ...overrides,
  });

  it("says before the run that a dated uppdrag's times are held every week of the master, naming each", () => {
    state.people.push({ ...pupil("t-1", "g-41"), role: "TEACHER", studentGroupId: null, firstName: "Anna", lastName: "Ek" });
    state.duties = [
      duty({ validFrom: "2027-01-07", label: "APT" }),
      duty({ id: "d-2", validTo: "2026-12-18" }),
      // Undated, or dated without a time: the master holds nothing it would not anyway.
      duty({ id: "d-3" }),
      duty({ id: "d-4", validTo: "2026-12-18", slots: [] }),
      // Dated on the läsår's own bounds: it runs the whole year.
      duty({ id: "d-5", validFrom: "2026-08-17", validTo: "2027-06-11" }),
    ];
    render(<GeneratePage />);
    expect(state.dutiesFor).toContain("y-1");
    expect(screen.getByText("generate.datedDutyTimesTitle(2)")).toBeInTheDocument();
    expect(screen.getByText("generate.datedDutyTimesBody")).toBeInTheDocument();
    expect(screen.getByText("Anna Ek · APT · staffing.dutyRunsFrom(2027-01-07)")).toBeInTheDocument();
    expect(screen.getByText("Anna Ek · Rastvakt · staffing.dutyRunsTo(2026-12-18)")).toBeInTheDocument();
  });

  it("says nothing when no uppdrag is both dated and timed", () => {
    state.duties = [duty({}), duty({ id: "d-2", validTo: "2026-12-18", slots: [] })];
    render(<GeneratePage />);
    expect(screen.queryByText(/generate\.datedDutyTimes/)).toBeNull();
  });
});

describe("groups the timplan names but whose year cannot be derived", () => {
  it("names them before the run", () => {
    render(<GeneratePage />);
    const status = screen.getByRole("status");
    // 4sl1 alone: 4ma1 gets year four from its member, 4.1 from itself.
    expect(status.textContent).toContain("generate.noYearTitle(1)");
    expect(status.textContent).toContain("4sl1");
    expect(status.textContent).not.toContain("4ma1");
    expect(screen.getByRole("link", { name: "generate.noYearLink" })).toHaveAttribute(
      "href",
      "/admin/groups",
    );
  });

  it("says nothing when every named group has a year", () => {
    state.memberships.push({ studentId: "p-1", studentGroupId: "g-sl1" });
    render(<GeneratePage />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("ignores a yearless group the timplan does not name", () => {
    // Nothing will be scheduled for it, so nothing can land across a rast.
    state.requirements = [requirement("g-41")];
    render(<GeneratePage />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("every timplanspost has a teacher (Fas 2 pre-flight)", () => {
  const unstaffed = (studentGroupId: string) => ({ ...requirement(studentGroupId), teacherId: null });
  const runButton = () => screen.getByRole("button", { name: /generate\.run/ });
  const staffedLine = () => screen.getByText("generate.preStaffed").closest("li") as HTMLElement;

  // Every other prerequisite met, so the button's state is this line's alone.
  beforeEach(() => {
    state.people.push({ ...pupil("t-1", "g-41"), role: "TEACHER", studentGroupId: null });
  });


  it("passes quietly when every post has a teacher", () => {
    state.policy = { unstaffedGeneration: "REFUSE" };
    render(<GeneratePage />);

    // The check mark says it; a "0" beside the sentence read as "none has one".
    expect(staffedLine().textContent).toBe("generate.preStaffed");
    expect(within(staffedLine()).queryByRole("link")).toBeNull();
    expect(runButton()).toBeEnabled();
    expect(screen.queryByText("generate.runBlockedUnstaffed")).toBeNull();
  });

  it("warns under ALLOW, links to the unstaffed panel and still lets the school run", () => {
    state.policy = { unstaffedGeneration: "ALLOW" };
    state.requirements = [unstaffed("g-41"), unstaffed("g-ma1"), requirement("g-sl1")];
    render(<GeneratePage />);

    expect(within(staffedLine()).getByText("generate.preStaffedMissing(2)")).toBeInTheDocument();
    expect(within(staffedLine()).getByRole("link", { name: "generate.preStaffed" })).toHaveAttribute(
      "href",
      "/admin/staffing?year=y-1#unstaffed",
    );
    // Staffing Fas 4: the proposal that staffs them all in one go, beside it.
    expect(within(staffedLine()).getByRole("link", { name: "generate.preStaffedPropose" })).toHaveAttribute(
      "href",
      "/admin/staffing?year=y-1#propose",
    );
    expect(runButton()).toBeEnabled();
    expect(screen.queryByText(/generate\.runBlockedUnstaffed/)).toBeNull();
  });

  it("delade lektioner: counts a post whose lead is set but whose share has nobody, as the pre-flight does", () => {
    state.policy = { unstaffedGeneration: "REFUSE" };
    const shared = requirement("g-41") as { id: string };
    state.requirements = [shared, requirement("g-sl1")];
    state.shares = [{ requirementId: shared.id, teacherId: null, lessons: 1, minutes: 60 }];
    render(<GeneratePage />);

    expect(within(staffedLine()).getByText("generate.preStaffedMissing(1)")).toBeInTheDocument();
    expect(runButton()).toBeDisabled();
  });

  it("disables the run under REFUSE and says why beside the button", () => {
    state.policy = { unstaffedGeneration: "REFUSE" };
    state.requirements = [unstaffed("g-41"), requirement("g-sl1"), requirement("g-ma1")];
    render(<GeneratePage />);

    const button = runButton();
    expect(button).toBeDisabled();
    const reason = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(reason).not.toBeNull();
    expect(reason?.textContent).toContain("generate.preStaffed (generate.preStaffedMissing(1))");
    expect(reason?.textContent).toContain("generate.runBlockedUnstaffed");
    expect(within(reason!).getByRole("link", { name: "generate.preStaffedLink" })).toHaveAttribute(
      "href",
      "/admin/staffing?year=y-1#unstaffed",
    );
    expect(within(reason!).getByRole("link", { name: "generate.preStaffedPropose" })).toHaveAttribute(
      "href",
      "/admin/staffing?year=y-1#propose",
    );
  });

  it("marks the run and Föreslå bemanning with their routes' areas, and the links to read with none (Läsbehörighet)", () => {
    state.policy = { unstaffedGeneration: "REFUSE" };
    state.requirements = [unstaffed("g-41"), requirement("g-sl1"), requirement("g-ma1")];
    render(<GeneratePage />);

    // POST /optimization/jobs: schemaläggning's and drift's.
    expect(runButton()).toHaveAttribute("data-writes", "SCHEMALAGGNING DRIFT");
    // #propose opens the proposal, whose first write is optimization's too; its " · " goes with it.
    const reason = document.getElementById(runButton().getAttribute("aria-describedby") ?? "")!;
    expect(within(reason).getByRole("link", { name: "generate.preStaffedPropose" }).closest("[data-writes]")).toHaveAttribute(
      "data-writes",
      "SCHEMALAGGNING DRIFT",
    );
    expect(within(reason).getByRole("link", { name: "generate.preStaffedLink" }).closest("[data-writes]")).toBeNull();
    expect(within(staffedLine()).getByRole("link", { name: "generate.preStaffedPropose" })).toHaveAttribute(
      "data-writes",
      "SCHEMALAGGNING DRIFT",
    );
    expect(within(staffedLine()).getByRole("link", { name: "generate.preStaffed" })).not.toHaveAttribute("data-writes");
  });

  it("blocks nothing while the policy has not answered: the gateway's pre-flight decides", () => {
    state.requirements = [unstaffed("g-41")];
    render(<GeneratePage />);

    expect(runButton()).toBeEnabled();
    expect(within(staffedLine()).getByText("generate.preStaffedMissing(1)")).toBeInTheDocument();
  });

  it("reads the pre-flight refusal as unstaffed posts, not as an impossible timetable", () => {
    state.job = {
      id: "job-5",
      status: "SUCCEEDED",
      solverStatus: "INFEASIBLE",
      conflictSummary: "2 requirements have no teacher.",
      conflictSummaryCode: "STAFF_UNSTAFFED_REQUIREMENTS",
      conflictSummaryParams: { count: 2 },
      conflicts: [
        {
          category: "INSUFFICIENT_RESOURCES",
          code: "STAFF_UNSTAFFED_REQUIREMENTS",
          params: { count: 2 },
          message: "2 requirements have no teacher.",
          resourceNames: ["Matematik för 7A", "Svenska för 7B"],
        },
      ],
      createdAt: "2026-10-07T10:00:00.000Z",
    };
    render(<GeneratePage />);

    expect(screen.getByText("generate.statusUnstaffed")).toBeInTheDocument();
    expect(screen.queryByText("generate.infeasibleHint")).toBeNull();
    expect(screen.queryByText("generate.statusINFEASIBLE")).toBeNull();
    expect(screen.getAllByText("engineMessages.STAFF_UNSTAFFED_REQUIREMENTS(2)").length).toBe(2);
    expect(screen.getByText("Matematik för 7A, Svenska för 7B")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "generate.preStaffedLink" })).toHaveAttribute(
      "href",
      "/admin/staffing?year=y-1#unstaffed",
    );
  });

  it("reads a partly locked block as a refusal before the engine, not as an impossible timetable", () => {
    const run = {
      id: "job-7",
      status: "SUCCEEDED",
      solverStatus: "INFEASIBLE",
      conflictSummary: "1 block has lessons locked or placed by hand.",
      conflictSummaryCode: "BLOCK_PARTLY_LOCKED_SUMMARY",
      conflictSummaryParams: { count: 1 },
      conflicts: [],
      createdAt: "2026-10-07T10:00:00.000Z",
    };
    state.job = run;
    state.history = [run];
    render(<GeneratePage />);

    expect(screen.getByText("generate.statusPartlyLocked")).toBeInTheDocument();
    expect(screen.getByText("generate.partlyLockedHint")).toBeInTheDocument();
    expect(screen.queryByText("generate.infeasibleHint")).toBeNull();
    expect(screen.queryByText("generate.statusINFEASIBLE")).toBeNull();
    expect(screen.getByText("generate.historyStatus.PARTLY_LOCKED")).toBeInTheDocument();
  });

  it("keeps the engine's own INFEASIBLE hint for every other refusal", () => {
    state.job = {
      id: "job-6",
      status: "SUCCEEDED",
      solverStatus: "INFEASIBLE",
      conflictSummary: "x",
      conflictSummaryCode: "LUNCH_HALL_CANNOT_SEAT_CLASSES",
      conflictSummaryParams: { seats: 1, classes: 2 },
      conflicts: [],
      createdAt: "2026-10-07T10:00:00.000Z",
    };
    render(<GeneratePage />);

    expect(screen.getByText("generate.infeasibleHint")).toBeInTheDocument();
    expect(screen.queryByText("generate.statusUnstaffed")).toBeNull();
  });
});

describe("the wait quoted while a run is going", () => {
  const runButton = () => screen.getByRole("button", { name: /generate\.run/ });
  const going = (waitSeconds?: number) => ({
    id: "job-9",
    status: "RUNNING",
    solverStatus: null,
    lessonsGenerated: 0,
    conflictSummary: null,
    conflictSummaryCode: null,
    conflictSummaryParams: null,
    conflicts: [],
    createdAt: "2026-11-03T10:00:00.000Z",
    ...(waitSeconds === undefined ? {} : { waitSeconds }),
  });

  it("reads the gateway's wait and rounds it up to whole minutes", () => {
    // 240 s is a 180 s budget with its probe and the headroom: four minutes.
    state.job = going(240);
    render(<GeneratePage />);

    expect(within(runButton()).getByText("generate.runningUpTo(4)")).toBeInTheDocument();
    expect(screen.queryByText("generate.running")).toBeNull();
  });

  it("rounds a part of a minute up, never down to a number that would be passed", () => {
    state.job = going(61);
    render(<GeneratePage />);

    expect(within(runButton()).getByText("generate.runningUpTo(2)")).toBeInTheDocument();
  });

  it("claims no number it was not given: an older gateway, or a run not yet read", () => {
    state.job = going();
    render(<GeneratePage />);

    expect(within(runButton()).getByText("generate.running")).toBeInTheDocument();
    expect(screen.queryByText(/runningUpTo/)).toBeNull();
  });
});

describe("a run that hit the time limit", () => {

  it("shows what the probe measured, with its own label", () => {
    // A TIMEOUT used to be a bare status. The engine now switches one rule off
    // at a time and reports which relaxation let the week solve; that reaches
    // the page as an ordinary conflict, under a category that says it is a
    // measurement and not a proof.
    state.job = {
      id: "job-1",
      status: "SUCCEEDED",
      solverStatus: "TIMEOUT",
      conflictSummary: "No timetable within 60 s. With one rule relaxed, the same week solved.",
      conflicts: [
        {
          category: "TIMEOUT_PROBE",
          message: "With the corridor between lessons (changeoverMinutes) set to 0, a timetable was found in 4.1 s.",
        },
      ],
      createdAt: "2026-09-07T10:00:00.000Z",
    };
    render(<GeneratePage />);

    expect(screen.getByText("conflictCategories.TIMEOUT_PROBE")).toBeInTheDocument();
    expect(screen.getByText(/changeoverMinutes\) set to 0/)).toBeInTheDocument();
  });

  /*
   * Omgång 13, M2: a run that ran out of time says where the time went, how far the search got, the likely cause and the next step
   * (timeout-account.tsx, behind a lazy import), from the engine's report. A run without one says what it always said.
   */
  describe("and says where the time went", () => {
    const timedOut = (over: Record<string, unknown> = {}) => ({
      id: "job-t",
      status: "SUCCEEDED",
      solverStatus: "TIMEOUT",
      lessonsGenerated: 0,
      conflictSummary: null,
      conflictSummaryCode: null,
      conflicts: [],
      createdAt: "2026-11-21T08:00:00.000Z",
      finishedAt: "2026-11-21T08:03:10.000Z",
      report: {
        totalSeconds: 109,
        budgetSeconds: 100,
        configuredBudgetSeconds: 100,
        callerWaitSeconds: null,
        stages: [
          { stage: "BUILD", seconds: 4 },
          { stage: "SEARCH_CLEAN", seconds: 60 },
        ],
        search: { solutions: 0, phases: [{ phase: "CLEAN", seconds: 60, conflicts: 12, branches: 34 }] },
        weekLoadCut: false,
      },
      ...over,
    });

    it("draws the account in place of the one-sentence hint", async () => {
      state.job = timedOut();
      render(<GeneratePage />);

      expect(await screen.findByRole("heading", { name: "generate.timeoutAccount.title" })).toBeInTheDocument();
      expect(screen.getByText("generate.timeoutAccount.stage(BUILD|4)")).toBeInTheDocument();
      expect(screen.queryByText("generate.timeoutHint")).toBeNull();
    });

    it("hands the account the run's rows, so that the tight years it lists are the ones the arithmetic found", async () => {
      state.job = timedOut({
        conflicts: [
          { category: "REQUIREMENT_DEMAND", code: "TIGHT_WEEK_LOAD", message: "…", params: { grades: "8", percent: 93 }, resourceNames: [] },
        ],
      });
      render(<GeneratePage />);

      expect(await screen.findByText("generate.timeoutAccount.tightYear(8|93)")).toBeInTheDocument();
    });

    it("says the hint, as it always did, when the run carries no report: an older engine, a run from before the field", () => {
      state.job = timedOut({ report: null });
      render(<GeneratePage />);

      expect(screen.getByText("generate.timeoutHint")).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "generate.timeoutAccount.title" })).toBeNull();
    });

    it("says the hint of a gateway that has no such field at all", () => {
      const { report: _none, ...without } = timedOut();
      state.job = without;
      render(<GeneratePage />);

      expect(screen.getByText("generate.timeoutHint")).toBeInTheDocument();
    });

    it("draws no account for a run that did not run out of time, even one that carries a report", () => {
      state.job = timedOut({ solverStatus: "INFEASIBLE" });
      render(<GeneratePage />);

      expect(screen.queryByRole("heading", { name: "generate.timeoutAccount.title" })).toBeNull();
      expect(screen.queryByText("generate.timeoutHint")).toBeNull();
    });
  });
});

describe("a refusal that names classes", () => {
  it("shows the school's names under the sentence that is about them", () => {
    // The lunch stage's lines say "the classes named here" and carry the
    // classes in a field no screen used to show: a school read the sentence
    // with nobody named under it.
    state.job = {
      id: "job-2",
      status: "SUCCEEDED",
      solverStatus: "INFEASIBLE",
      conflictSummary: "The dining hall's 115 seats cannot seat the 2 class(es) named (44 children).",
      conflicts: [
        {
          category: "DINING_CAPACITY",
          message: "The classes named here bring their children to the hall every school day.",
          resourceNames: ["4A", "4B"],
        },
        {
          category: "DINING_CAPACITY",
          message: "The dining hall's 115 seats are all it holds at one time.",
          resourceNames: [],
        },
      ],
      createdAt: "2026-09-07T10:00:00.000Z",
    };
    render(<GeneratePage />);

    expect(screen.getByText("4A, 4B")).toBeInTheDocument();
    expect(screen.getAllByText("conflictCategories.DINING_CAPACITY")).toHaveLength(2);
  });
});

/*
 * Lärarens dag: a refusal over a post's days names the post by its id
 * (`limit`), which no screen resolves. For a reader with HR-läs the gateway
 * names the teachers beside the sentence — errorNames for a failed run,
 * conflictSummaryNames for a summary — as a conflict's resourceNames; for
 * anyone else the sentence is the hidden one and the lists are empty.
 */
describe("a days refusal, read with HR-läs", () => {
  const preflight = (extra: Record<string, unknown>) => ({
    id: "job-d",
    status: "FAILED",
    solverStatus: null,
    lessonsGenerated: 0,
    conflictSummary: null,
    conflicts: [],
    error: "Post post-eva allows teaching on at most 3 days a week.",
    errorCode: "TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK",
    errorParams: { limit: "post-eva", days: 3, weekMinutes: 1500 },
    createdAt: "2026-10-18T10:00:00.000Z",
    ...extra,
  });
  const SENTENCE = "engineMessages.TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK(post-eva|3|1500)";

  it("names whose post stopped the run, under the sentence", () => {
    state.job = preflight({ errorNames: ["Eva Ek"] });
    render(<GeneratePage />);

    expect(screen.getByText(SENTENCE).nextElementSibling).toHaveTextContent(/^Eva Ek$/);
  });

  it("names nobody for a reader the gateway named nobody to, or a gateway that sends no list", () => {
    state.job = preflight({ errorNames: [] });
    const { unmount } = render(<GeneratePage />);
    expect(screen.getByText(SENTENCE).nextElementSibling).toBeNull();
    unmount();

    state.job = preflight({});
    render(<GeneratePage />);
    expect(screen.getByText(SENTENCE).nextElementSibling).toBeNull();
  });

  it("names them under a summary as well", () => {
    state.job = {
      id: "job-s",
      status: "SUCCEEDED",
      solverStatus: "INFEASIBLE",
      conflictSummary: "Two posts' days cannot both hold.",
      conflictSummaryCode: "TEACHER_WORK_DAYS_CANNOT_BE_KEPT",
      conflictSummaryParams: { limit: "post-eva", days: 3 },
      conflictSummaryNames: ["Eva Ek", "Bo Alm"],
      conflicts: [{ category: "AVAILABILITY", message: "x", resourceNames: [] }],
      createdAt: "2026-10-18T10:00:00.000Z",
    };
    render(<GeneratePage />);

    expect(screen.getByText("engineMessages.TEACHER_WORK_DAYS_CANNOT_BE_KEPT(post-eva|3)").nextElementSibling).toHaveTextContent(
      /^Eva Ek, Bo Alm$/,
    );
  });

  it("terminer: says which weeks a refusal was counted for, under its sentence and before the names", () => {
    const refused = (params: Record<string, string | number>) => ({
      id: "job-p",
      status: "SUCCEEDED",
      solverStatus: "INFEASIBLE",
      conflictSummary: "Too many lessons for one teacher's hours.",
      conflictSummaryCode: "DEMAND_TEACHER_HOURS_SHORT",
      conflictSummaryParams: params,
      conflictSummaryNames: ["Eva Ek"],
      conflicts: [{ category: "REQUIREMENT_DEMAND", message: "x", resourceNames: [] }],
      createdAt: "2026-10-18T10:00:00.000Z",
    });
    state.job = refused({ teachers: 1, period: 2, periodFrom: "2027-01-11", periodTo: "2027-01-17", periodStretches: 1 });
    const { unmount } = render(<GeneratePage />);

    const sentence = screen.getByText("engineMessages.DEMAND_TEACHER_HOURS_SHORT(1|2|2027-01-11|2027-01-17|1)");
    const note = sentence.nextElementSibling!;
    expect(note).toHaveTextContent("generate.countedInPeriod(11 januari 2027|17 januari 2027|no|ALL)");
    expect(note.nextElementSibling).toHaveTextContent(/^Eva Ek$/);
    unmount();

    // A period of several stretches, counted in the odd weeks only, says both.
    state.job = refused({
      teachers: 1,
      period: 0,
      periodFrom: "2026-08-17",
      periodTo: "2026-12-20",
      periodStretches: 2,
      parity: "ODD_WEEKS",
    });
    const again = render(<GeneratePage />);
    expect(
      screen.getByText("generate.countedInPeriod(17 augusti 2026|20 december 2026|yes|ODD_WEEKS)"),
    ).toBeInTheDocument();
    again.unmount();

    // A refusal that names no period — every refusal of a school that dates nothing — has no such line.
    state.job = refused({ teachers: 1 });
    render(<GeneratePage />);
    expect(screen.queryByText(/generate\.countedInPeriod/)).not.toBeInTheDocument();
    expect(screen.getByText("engineMessages.DEMAND_TEACHER_HOURS_SHORT(1)").nextElementSibling).toHaveTextContent(/^Eva Ek$/);
  });

  it("klassens lunch: says which parts of the läsår the locks are in, under the sentence, on a refusal and on a line", () => {
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
    const refusedBefore = (errorParams: Record<string, string | number>) => ({
      id: "job-l",
      status: "FAILED",
      solverStatus: null,
      lessonsGenerated: 0,
      conflictSummary: null,
      conflicts: [],
      error: "Locked lessons leave student group 7A no 30-minute lunch break inside 11:00-12:00 on Monday.",
      errorCode: "LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK",
      errorParams,
      createdAt: "2026-10-18T10:00:00.000Z",
    });
    state.job = refusedBefore(dated);
    const first = render(<GeneratePage />);
    const sentence = screen.getByText(/^engineMessages\.LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK\(/);
    expect(sentence.nextElementSibling).toHaveTextContent(NOTE);
    first.unmount();

    // One period's locks alone: the sentence, and nothing under it.
    state.job = refusedBefore(lunch);
    const second = render(<GeneratePage />);
    expect(screen.getByText(/^engineMessages\.LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK\(/)).toBeInTheDocument();
    expect(screen.queryByText(/generate\.lunchLocksInPeriods/)).not.toBeInTheDocument();
    second.unmount();

    // Förlagda poster: the same sentence as a line of a refused week, more weeks than the two named.
    state.job = {
      id: "job-m",
      status: "SUCCEEDED",
      solverStatus: "INFEASIBLE",
      conflictSummary: "The placed lessons are why.",
      conflictSummaryCode: null,
      conflictSummaryParams: null,
      conflicts: [
        {
          category: "PLACEMENT",
          code: "LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK",
          message: "Locked lessons leave student group 7A no lunch break.",
          params: { ...dated, lockWeeksElsewhere: 2 },
          resourceNames: ["7A"],
        },
        { category: "PLACEMENT", code: "LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK", message: "x", params: lunch, resourceNames: [] },
      ],
      createdAt: "2026-10-18T10:00:00.000Z",
    };
    render(<GeneratePage />);
    const lines = screen.getAllByText(/^engineMessages\.LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK\(/);
    expect(lines).toHaveLength(2);
    const note = lines[0]!.nextElementSibling!;
    expect(note).toHaveTextContent(
      "generate.lunchLocksInPeriods(17 augusti 2026|20 december 2026|11 januari 2027|11 juni 2027|yes)",
    );
    expect(note.nextElementSibling).toHaveTextContent(/^7A$/);
    expect(screen.getAllByText(/generate\.lunchLocksInPeriods/)).toHaveLength(1);
  });

  it("names nobody under a summary that came with an empty list, or with none", () => {
    const summary = (extra: Record<string, unknown>) => ({
      id: "job-s",
      status: "SUCCEEDED",
      solverStatus: "INFEASIBLE",
      conflictSummary: "Two posts' days cannot both hold.",
      conflictSummaryCode: "TEACHER_WORK_DAYS_HIDDEN",
      conflictSummaryParams: {},
      conflicts: [{ category: "AVAILABILITY", message: "x", resourceNames: [] }],
      createdAt: "2026-10-18T10:00:00.000Z",
      ...extra,
    });
    const SUMMARY = "engineMessages.TEACHER_WORK_DAYS_HIDDEN()";

    // The summary is followed straight by the list of causes, with no line
    // of names between them.
    state.job = summary({ conflictSummaryNames: [] });
    const { unmount } = render(<GeneratePage />);
    expect(screen.getByText(SUMMARY).nextElementSibling?.tagName).toBe("UL");
    unmount();

    state.job = summary({});
    render(<GeneratePage />);
    expect(screen.getByText(SUMMARY).nextElementSibling?.tagName).toBe("UL");
  });
});

describe("a refusal the engine named", () => {
  it("shows the Swedish for the code, not the engine's English", () => {
    // The engine writes English and names each sentence; the page renders the
    // name from `engineMessages` with the values beside it. The stub echoes
    // the key and the values, so what this asserts is that the page reached
    // for the translation and handed it the engine's numbers — not that it
    // printed the English it was also sent.
    state.job = {
      id: "job-3",
      status: "SUCCEEDED",
      solverStatus: "INFEASIBLE",
      conflictSummary: "The dining hall's 115 seats cannot seat the 2 classes named.",
      conflictSummaryCode: "LUNCH_HALL_CANNOT_SEAT_CLASSES",
      conflictSummaryParams: { seats: 115, classes: 2 },
      conflicts: [
        {
          category: "DINING_CAPACITY",
          code: "LUNCH_SEATS_CAP",
          params: { seats: 115 },
          message: "The dining hall's 115 seats are all it holds at one time.",
          resourceNames: [],
        },
      ],
      createdAt: "2026-09-07T10:00:00.000Z",
    };
    render(<GeneratePage />);

    expect(
      screen.getByText("engineMessages.LUNCH_HALL_CANNOT_SEAT_CLASSES(115|2)"),
    ).toBeInTheDocument();
    expect(screen.getByText("engineMessages.LUNCH_SEATS_CAP(115)")).toBeInTheDocument();
  });

  it("falls back to the engine's English for a sentence it cannot translate", () => {
    // The engine and the web deploy separately. An untranslated sentence must
    // reach the admin as the engine wrote it, never as an empty card.
    state.untranslated = ["SOMETHING_NEW"];
    state.job = {
      id: "job-4",
      status: "FAILED",
      solverStatus: null,
      error: "A rule this build has never heard of.",
      errorCode: "SOMETHING_NEW",
      errorParams: {},
      conflicts: [],
      createdAt: "2026-09-07T10:00:00.000Z",
    };
    render(<GeneratePage />);

    expect(screen.getByText("A rule this build has never heard of.")).toBeInTheDocument();
  });
});

/*
 * Skolregler, as the page says them before a run: the switches that make the
 * generator try something the hard rules do not demand. A switch that is off
 * is not a line — the list names what the generator WILL do.
 */
describe("the school's rules the generator keeps", () => {
  const school = (extra: Record<string, unknown>) => ({
    id: "ls-1",
    lunchEnabled: false,
    lunchStartTime: "11:00",
    lunchEndTime: "13:00",
    lunchMinutes: 30,
    diningSeats: null,
    maxLessonsPerDayPerGroup: null,
    ...extra,
  });

  it("says the generator tries to keep teachers' teaching in a row where the school turned it on", () => {
    state.lunch = school({ generatorKeepsConsecutiveTeaching: true });
    render(<GeneratePage />);

    expect(screen.getByText("generate.ruleConsecutive")).toBeInTheDocument();
  });

  it("says nothing of it while the switch is off, or for an API that predates it", () => {
    state.lunch = school({ generatorKeepsConsecutiveTeaching: false });
    const { unmount } = render(<GeneratePage />);
    expect(screen.queryByText("generate.ruleConsecutive")).toBeNull();
    unmount();

    state.lunch = school({});
    render(<GeneratePage />);
    expect(screen.queryByText("generate.ruleConsecutive")).toBeNull();
  });

  describe("Placeringsregler", () => {
    // The echo translator prints a key with its values in the order the page
    // passes them: the weight, then the limits Salar och byggnader per dag holds to.
    const line = (rule: "edge" | "places" | "shared", mode: "SOFT" | "HARD", values: string) =>
      `placementRules.summary.${rule}.${mode}(${values})`;
    const limit = (name: string, count: number) => `placementRules.summary.limit.${name}(${count})`;
    const none = /placementRules\.summary\.(edge|places|shared)\./;

    it("says nothing while every rule is off, or for an API that predates them", () => {
      state.lunch = school({ placementEdgeMode: "OFF", placementPlacesMode: "OFF", placementSharedMode: "OFF" });
      const { unmount } = render(<GeneratePage />);
      expect(screen.queryByText(none)).toBeNull();
      unmount();

      state.lunch = school({});
      render(<GeneratePage />);
      expect(screen.queryByText(none)).toBeNull();
    });

    it("names each rule that is on, a Mjuk one with its weight, read-only", () => {
      state.lunch = school({
        placementEdgeMode: "SOFT",
        placementEdgeWeight: 300,
        placementSharedMode: "HARD",
        placementSharedWeight: 400,
      });
      render(<GeneratePage />);

      expect(screen.getByText(line("edge", "SOFT", "300|–"))).toBeInTheDocument();
      expect(screen.getByText(line("shared", "HARD", "400|–"))).toBeInTheDocument();
      expect(screen.queryByText(new RegExp(`summary\\.places`))).toBeNull();
      // Lines of text, not controls: the rules are edited under Skolregler.
      expect(screen.queryByRole("radio", { name: /mode\./ })).toBeNull();
    });

    it("lists the limits Salar och byggnader per dag holds to, a 1 among them and an empty one left out", () => {
      state.lunch = school({
        placementPlacesMode: "SOFT",
        maxClassRoomsPerDay: 2,
        maxTeacherRoomsPerDay: null,
        maxClassBuildingsPerDay: null,
        maxTeacherBuildingsPerDay: 1,
      });
      render(<GeneratePage />);

      expect(
        screen.getByText(line("places", "SOFT", `250|${limit("classRoom", 2)}, ${limit("teacherBuilding", 1)}`)),
      ).toBeInTheDocument();
    });
  });
});

/*
 * Bästa möjliga schema: the switch is the school's (Skolregler). On, this page
 * says so among the rules, offers the mode in the Schemaförslag section, and
 * under a run that was refused points at it — except where the refusal is one
 * the mode keeps too.
 */
describe("Bästa möjliga schema", () => {
  const school = (extra: Record<string, unknown>) => ({
    id: "ls-1",
    lunchEnabled: false,
    lunchStartTime: "11:00",
    lunchEndTime: "13:00",
    lunchMinutes: 30,
    diningSeats: null,
    maxLessonsPerDayPerGroup: null,
    ...extra,
  });
  const refused = (overrides: Record<string, unknown> = {}) => ({
    id: "job-8",
    status: "SUCCEEDED",
    solverStatus: "INFEASIBLE",
    conflictSummary: "x",
    conflictSummaryCode: "LUNCH_HALL_CANNOT_SEAT_CLASSES",
    conflictSummaryParams: { seats: 1, classes: 2 },
    conflicts: [],
    createdAt: "2026-10-07T10:00:00.000Z",
    ...overrides,
  });
  const offer = () => screen.queryByRole("link", { name: "generate.bestEffortOfferLink" });
  const sectionButton = () => screen.queryByRole("button", { name: "scheduleCandidates.section.startBestEffort" });

  it("says the school has the mode on among the rules, and nothing while it is off or the API predates it", () => {
    state.lunch = school({ generatorBestEffort: true });
    const on = render(<GeneratePage />);
    expect(screen.getByText("generate.ruleBestEffort")).toBeInTheDocument();
    on.unmount();

    state.lunch = school({ generatorBestEffort: false });
    const off = render(<GeneratePage />);
    expect(screen.queryByText("generate.ruleBestEffort")).toBeNull();
    off.unmount();

    state.lunch = school({});
    render(<GeneratePage />);
    expect(screen.queryByText("generate.ruleBestEffort")).toBeNull();
  });

  it("offers Ta fram bästa möjliga in the Schemaförslag section only while the school has it on", () => {
    state.lunch = school({ generatorBestEffort: true });
    const on = render(<GeneratePage />);
    expect(sectionButton()).toBeInTheDocument();
    on.unmount();

    for (const lunch of [school({ generatorBestEffort: false }), school({}), null]) {
      state.lunch = lunch;
      const rendered = render(<GeneratePage />);
      expect(sectionButton()).toBeNull();
      rendered.unmount();
    }
  });

  it.each([
    ["INFEASIBLE", {}, false],
    ["TIMEOUT", { solverStatus: "TIMEOUT", conflictSummaryCode: null }, true],
  ])("points a refused run (%s) at the section that holds the mode, on this page", (_, overrides, timedOut) => {
    state.lunch = school({ generatorBestEffort: true });
    state.job = refused(overrides);
    render(<GeneratePage />);

    expect(screen.getByText(/generate\.bestEffortOffer(?!Link|Timeout)/)).toBeInTheDocument();
    // Only after a TIMEOUT, where nothing was proved: the offer says the mode
    // can give way where a longer Generera would not have had to (review of #285, LÅG-1).
    expect(screen.queryByText(/generate\.bestEffortOfferTimeout/) !== null).toBe(timedOut);
    // A plain anchor to the section: a locale link would leave the page.
    expect(offer()).toHaveAttribute("href", "#candidates");
    expect(document.getElementById("candidates")).not.toBeNull();
  });

  it("says nothing of it for a refused run while the switch is off, or the API predates it", () => {
    state.job = refused();
    state.lunch = school({ generatorBestEffort: false });
    const off = render(<GeneratePage />);
    expect(offer()).toBeNull();
    off.unmount();

    state.lunch = school({});
    const old = render(<GeneratePage />);
    expect(offer()).toBeNull();
    old.unmount();

    // The settings not read at all: nothing is offered on a guess.
    state.lunch = null;
    render(<GeneratePage />);
    expect(offer()).toBeNull();
  });

  it("says nothing of it for a run that laid a timetable, or one that failed before the engine answered", () => {
    state.lunch = school({ generatorBestEffort: true });
    state.job = {
      id: "job-9",
      status: "SUCCEEDED",
      solverStatus: "OPTIMAL",
      lessonsGenerated: 3,
      conflicts: [],
      createdAt: "2026-10-07T10:00:00.000Z",
    };
    const laid = render(<GeneratePage />);
    expect(offer()).toBeNull();
    laid.unmount();

    state.job = { id: "job-10", status: "FAILED", error: "boom", errorCode: null, conflicts: [], createdAt: "2026-10-07T10:00:00.000Z" };
    render(<GeneratePage />);
    expect(offer()).toBeNull();
  });

  it.each([
    ["an unstaffed post", "STAFF_UNSTAFFED_REQUIREMENTS"],
    ["a half-locked parallel block", "BLOCK_PARTLY_LOCKED_SUMMARY"],
  ])("does not offer it for the gateway's own refusal over %s, which the mode keeps too", (_, code) => {
    state.lunch = school({ generatorBestEffort: true });
    state.job = refused({ conflictSummaryCode: code, conflictSummaryParams: { count: 1 } });
    render(<GeneratePage />);

    expect(offer()).toBeNull();
    expect(screen.queryByText(/generate\.bestEffortOffer/)).toBeNull();
  });
});

/*
 * Lärarens dag: the wishes a laid week could not keep. The run succeeded, so
 * they are neither conflicts nor refusals — a heading of their own under the
 * result, the engine catalogue's sentence, and no category badge.
 */
describe("wishes a finished run could not keep", () => {
  // The sentence names the weekday alone; WHOSE wish it was arrives in
  // resourceNames, named by the gateway at read time for every reader.
  const WISH = {
    category: "AVAILABILITY",
    code: "TEACHER_FREE_DAY_WISH_NOT_KEPT",
    params: { day: 3 },
    message: "The wish could not be kept.",
    resourceNames: ["Eva Ek"],
  };
  const SENTENCE = "engineMessages.TEACHER_FREE_DAY_WISH_NOT_KEPT(3)";
  const laid = (extra: Record<string, unknown>) => ({
    id: "job-n",
    status: "SUCCEEDED",
    solverStatus: "OPTIMAL",
    lessonsGenerated: 40,
    conflictSummary: null,
    conflicts: [],
    createdAt: "2026-10-17T10:00:00.000Z",
    ...extra,
  });

  it("lists them under their own heading in the catalogue's words, with no badge", () => {
    state.job = laid({ notes: [WISH] });
    render(<GeneratePage />);

    const section = screen.getByRole("region", { name: "generate.notesTitle" });
    expect(within(section).getByText(SENTENCE)).toBeInTheDocument();
    expect(within(section).getByText("generate.notesHint")).toBeInTheDocument();
    expect(screen.queryByText("conflictCategories.AVAILABILITY")).toBeNull();
    // Not a conflict: the conflicts' heading stays away from a run that has none.
    expect(screen.queryByText("generate.conflicts")).toBeNull();
  });

  /*
   * Sammanhängande undervisning: a teacher whose longest stretch of the laid
   * week is over their limit. The same plumbing as the free-day wish — the
   * catalogue's sentence, the teacher under it, no badge — and the page has
   * no code of its own for it: it is a note like the other.
   */
  it("lists a limit on teaching in a row that the week broke next to the free-day wishes, each with its teacher", () => {
    const STRETCH = {
      category: "AVAILABILITY",
      code: "TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT",
      params: { day: 2, minutes: 240, max: 180, breakMinutes: 20 },
      message: "A teacher should teach at most 180 minutes in a row …",
      resourceNames: ["Olle Ås"],
    };
    state.job = laid({ notes: [WISH, STRETCH] });
    render(<GeneratePage />);

    const section = screen.getByRole("region", { name: "generate.notesTitle" });
    expect(within(section).getByText(SENTENCE).nextElementSibling).toHaveTextContent(/^Eva Ek$/);
    // The catalogue stub echoes the code with the values in the order the
    // gateway sent them: the weekday, the longest stretch, the limit, the break.
    const stretch = within(section).getByText("engineMessages.TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT(2|240|180|20)");
    expect(stretch.nextElementSibling).toHaveTextContent(/^Olle Ås$/);
    expect(screen.queryByText("conflictCategories.AVAILABILITY")).toBeNull();
  });

  it("lists the limit as one sentence with no teacher and no figure for a reader without HR-läs", () => {
    // The limit is set on the teacher's post (HR): everyone but a reader with
    // HR-läs is handed TEACHER_CONSECUTIVE_TEACHING_HIDDEN, one note for the
    // category, params {} and no resourceNames. The page draws it as it draws
    // any note and has no name line to draw under it.
    const HIDDEN = {
      category: "AVAILABILITY",
      code: "TEACHER_CONSECUTIVE_TEACHING_HIDDEN",
      params: {},
      message: "The new timetable does not keep a teacher's limit on teaching in a row.",
      resourceNames: [],
    };
    state.job = laid({ notes: [WISH, HIDDEN] });
    render(<GeneratePage />);

    const section = screen.getByRole("region", { name: "generate.notesTitle" });
    const hidden = within(section).getByText("engineMessages.TEACHER_CONSECUTIVE_TEACHING_HIDDEN()");
    expect(hidden.nextElementSibling).toBeNull();
    expect(within(section).queryByText(/TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT/)).toBeNull();
  });

  it("falls back to the gateway's English for a limit this build cannot translate", () => {
    state.untranslated = ["TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT"];
    state.job = laid({
      notes: [
        {
          category: "AVAILABILITY",
          code: "TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT",
          params: { day: 2, minutes: 240, max: 180, breakMinutes: 20 },
          message: "The limit could not be kept.",
          resourceNames: [],
        },
      ],
    });
    render(<GeneratePage />);

    expect(screen.getByText("The limit could not be kept.")).toBeInTheDocument();
  });

  it("names whose wish it was under the sentence, every name the gateway sent", () => {
    state.job = laid({ notes: [WISH, { ...WISH, params: { day: 5 }, resourceNames: ["Eva Ek", "Olle Ås"] }] });
    render(<GeneratePage />);

    expect(screen.getByText(SENTENCE).nextElementSibling).toHaveTextContent(/^Eva Ek$/);
    expect(screen.getByText("engineMessages.TEACHER_FREE_DAY_WISH_NOT_KEPT(5)").nextElementSibling).toHaveTextContent(
      /^Eva Ek, Olle Ås$/,
    );
  });

  it("draws no name line for a note that names nobody, or a run stored before the names", () => {
    state.job = laid({ notes: [{ ...WISH, resourceNames: [] }] });
    const { unmount } = render(<GeneratePage />);
    expect(screen.getByText(SENTENCE).nextElementSibling).toBeNull();
    unmount();

    const { resourceNames: _absent, ...stored } = WISH;
    state.job = laid({ notes: [stored] });
    render(<GeneratePage />);
    expect(screen.getByText(SENTENCE).nextElementSibling).toBeNull();
  });

  it("falls back to the gateway's English for a wish this build cannot translate", () => {
    state.untranslated = ["TEACHER_FREE_DAY_WISH_NOT_KEPT"];
    state.job = laid({ notes: [WISH] });
    render(<GeneratePage />);

    expect(screen.getByText("The wish could not be kept.")).toBeInTheDocument();
  });

  it("says nothing for a run that kept every wish, or a gateway that sends no notes", () => {
    state.job = laid({ notes: [] });
    const { unmount } = render(<GeneratePage />);
    expect(screen.queryByText("generate.notesTitle")).toBeNull();
    unmount();

    state.job = laid({});
    render(<GeneratePage />);
    expect(screen.queryByText("generate.notesTitle")).toBeNull();
  });

  /*
   * A schemaförslag applied over the year since the run replaced the
   * timetable the notes describe. The gateway reads it from the change log
   * (supersededBy), which keeps it whatever becomes of the candidate's run:
   * the list gives way to a line naming the candidate, and a link to the
   * comparison, which says which wishes it breaks.
   */
  describe("after a schemaförslag was applied", () => {
    const superseded = (ordinal: number | null, variant: string | null, runId: string | null = "run-1") =>
      laid({
        notes: [WISH],
        finishedAt: "2026-10-17T10:01:00.000Z",
        supersededBy: { appliedAt: "2026-10-17T10:05:00.000Z", ordinal, variant, runId },
      });
    /** The year's batch as the overview answers it: the applied candidate's run, or a newer one. */
    const batchOf = (runId: string) => {
      const batch = {
        run: {
          id: runId, status: "SUCCEEDED", requested: 2, progress: 2, createdAt: "2026-10-17T09:00:00.000Z",
          startedAt: "2026-10-17T09:00:01.000Z", finishedAt: "2026-10-17T09:02:00.000Z", error: null, errorCode: null,
          errorParams: null, createdById: "u-1", createdByName: null, appliedCandidateId: null, appliedAt: null, refreshOfId: null,
        },
        candidates: [],
      };
      return { latest: batch, batch, unplaced: null };
    };
    const notesSection = () => screen.getByRole("region", { name: "generate.notesTitle" });

    it("names the candidate in place of the run's list, and points to the comparison while it still has the candidate", () => {
      state.job = superseded(2, "TEACHER_GAPS");
      state.candidates = batchOf("run-1");
      render(<GeneratePage />);

      const section = notesSection();
      expect(within(section).getByText(/^generate\.notesSuperseded\(2\|scheduleCandidates\.variant\.TEACHER_GAPS\)/)).toBeInTheDocument();
      expect(within(section).getByText(/generate\.notesSupersededCompare/)).toBeInTheDocument();
      expect(within(section).getByRole("link", { name: "generate.notesSupersededLink" })).toHaveAttribute(
        "href",
        "/admin/generate/candidates#comparison",
      );
      // Neither the run's wishes nor the hint to move its lessons by hand.
      expect(within(section).queryByText(SENTENCE)).toBeNull();
      expect(within(section).queryByText("Eva Ek")).toBeNull();
      expect(within(section).queryByText("generate.notesHint")).toBeNull();
    });

    it("still names it, with no link, when the candidate's run is gone or replaced by a newer batch", () => {
      // "Ta bort förslagen", a newer batch or the week's sweep took the
      // applied run: the comparison would show other candidates, or none.
      for (const overview of [{ latest: null, batch: null, unplaced: null }, batchOf("run-2")]) {
        state.job = superseded(2, "TEACHER_GAPS");
        state.candidates = overview;
        const { unmount } = render(<GeneratePage />);
        const section = notesSection();
        expect(within(section).getByText(/^generate\.notesSuperseded\(2\|/)).toBeInTheDocument();
        expect(within(section).queryByRole("link")).toBeNull();
        expect(within(section).queryByText(/notesSupersededCompare/)).toBeNull();
        expect(within(section).queryByText(SENTENCE)).toBeNull();
        unmount();
      }
    });

    it("names a candidate of an emphasis this build does not know by its number alone", () => {
      state.job = superseded(2, "NEW_EMPHASIS");
      render(<GeneratePage />);

      expect(screen.getByText(/^generate\.notesSupersededPlain\(2\)/)).toBeInTheDocument();
      expect(screen.queryByText(/variant\.unknown/)).toBeNull();
    });

    it("says a candidate was applied, without a name, when the log does not say which", () => {
      state.job = superseded(null, null, null);
      render(<GeneratePage />);

      expect(screen.getByText(/^generate\.notesSupersededUnnamed/)).toBeInTheDocument();
      expect(screen.queryByText(SENTENCE)).toBeNull();
    });

    it("reads the run again when the tab comes back while its card lists wishes, and not once a candidate has replaced them", async () => {
      // A run started here: the card belongs to this visit's job.
      state.people.push({ ...pupil("t-1", "g-41"), role: "TEACHER", studentGroupId: null });
      const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries");
      const startHere = async () => {
        noMutation.mutateAsync.mockResolvedValueOnce({ jobId: "job-n" });
        await userEvent.setup().click(screen.getByRole("button", { name: "generate.run" }));
        await screen.findByRole("region", { name: "generate.notesTitle" });
      };
      try {
        state.job = laid({ notes: [WISH], supersededBy: null });
        const { unmount } = render(<GeneratePage />);
        await startHere();
        invalidate.mockClear();
        document.dispatchEvent(new Event("visibilitychange"));
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ["optimizationJob", "job-n"] });
        unmount();

        state.job = superseded(2, "TEACHER_GAPS");
        render(<GeneratePage />);
        await startHere();
        invalidate.mockClear();
        document.dispatchEvent(new Event("visibilitychange"));
        expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["optimizationJob", "job-n"] });
      } finally {
        invalidate.mockRestore();
      }
    });

    it("keeps the run's list when the gateway says none was applied since, or is older than the field", () => {
      state.job = laid({ notes: [WISH], supersededBy: null });
      const { unmount } = render(<GeneratePage />);
      expect(screen.getByText(SENTENCE)).toBeInTheDocument();
      expect(screen.queryByText(/generate\.notesSuperseded/)).toBeNull();
      unmount();

      state.job = laid({ notes: [WISH] });
      render(<GeneratePage />);
      expect(screen.getByText(SENTENCE)).toBeInTheDocument();
    });
  });

  it("says nothing of wishes on a run that failed", () => {
    state.job = laid({
      status: "FAILED",
      solverStatus: null,
      error: "The engine could not be reached.",
      errorCode: null,
      errorParams: null,
      notes: [WISH],
    });
    render(<GeneratePage />);

    expect(screen.queryByText("generate.notesTitle")).toBeNull();
  });
});


/*
 * Next year before its activation. A rolled year's classes have no home
 * pupils until it is activated — the people list still has every pupil in this
 * year's classes — so the page reads the people with the class the activation
 * will give each pupil it moves, from the gateway's own projection, and
 * generates for the year picked.
 */
describe("next year, before its activation", () => {
  const PROJECTED = {
    academicYearId: "y-2",
    basis: "PROJECTED",
    // p-1 sits in this year's 4.1 and moves up into next year's 5.1.
    homeClasses: [{ studentId: "p-1", studentGroupId: "g-next-51" }],
    counts: { moved: 1, graduates: 3, unplaced: 2 },
    membershipsOutOfDate: { missing: 0, stale: 0 },
  };

  beforeEach(() => {
    state.years = [ACTIVE, NEXT];
    state.groups = [
      ...state.groups,
      { id: "g-next-51", academicYearId: "y-2", name: "5.1", kind: "CLASS", gradeLevel: 5 },
      // Next year's maths group, carried with p-1 in it: its årskurs comes
      // from p-1's home class, which is this year's 4.1 until the activation.
      { id: "g-next-ma", academicYearId: "y-2", name: "5ma1", kind: "TEACHING_GROUP", gradeLevel: null },
    ];
    state.memberships = [{ studentId: "p-1", studentGroupId: "g-next-ma" }];
    state.requirements = [requirement("g-next-ma"), requirement("g-next-51")];
    state.people.push({ ...pupil("t-1", "g-41"), role: "TEACHER", studentGroupId: null });
    apiGet.mockResolvedValue(PROJECTED);
    window.history.replaceState(null, "", "/?year=y-2");
  });
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("generates for next year when the Läsår page links to it", async () => {
    render(<GeneratePage />);
    await screen.findByText("planningYear.bannerTitle(2027/28)");

    expect(apiGet).toHaveBeenCalledWith("/api/v1/academic-years/y-2/rosters");
    expect(state.requirementsFor.at(-1)).toBe("y-2");
    expect(state.historyFor.at(-1)).toBe("y-2");
    // Not this year's first: the link is read before any year is asked for,
    // so the active year's timplan and history are never fetched to be
    // thrown away (and never painted for a frame).
    expect(state.requirementsFor).not.toContain("y-1");
    expect(state.historyFor).not.toContain("y-1");
    expect(
      screen.getByRole("button", { name: "planningYear.optionNext(2027/28)", pressed: true }),
    ).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: /generate\.run/ }));
    // The run follows the week check (Kontrollera veckan), which is a request of its own.
    await waitFor(() =>
      expect(noMutation.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ academicYearId: "y-2" })),
    );
  });

  it("calls the year row the year being planned, not the active year it is not", async () => {
    render(<GeneratePage />);
    await screen.findByText("planningYear.bannerTitle(2027/28)");

    const yearLine = screen.getByText("generate.preYearPlanned").closest("li") as HTMLElement;
    expect(within(yearLine).getByText("2027/28")).toBeInTheDocument();
    expect(screen.queryByText("generate.preYear")).toBeNull();
  });

  it("says the class lists are projected, with the counts the gateway sent", async () => {
    render(<GeneratePage />);

    const banner = (await screen.findByText("planningYear.bannerTitle(2027/28)")).closest(
      "[role=status]",
    ) as HTMLElement;
    expect(banner.textContent).toContain("planningYear.bannerBody(2027/28|2026/27|1|3|2)");
    expect(banner.textContent).toContain("planningYear.bannerChanges(2026/27)");
    // No membership sentence when none is out of date.
    expect(banner.textContent).not.toContain("planningYear.bannerMemberships");
    expect(within(banner).getByRole("link")).toHaveAttribute("href", "/admin/years");
  });

  it("names the teaching-group memberships that no longer fit, as the activation preview does", async () => {
    apiGet.mockResolvedValue({ ...PROJECTED, membershipsOutOfDate: { missing: 2, stale: 1 } });
    render(<GeneratePage />);

    expect(await screen.findByText("planningYear.bannerMemberships(2|1)")).toBeInTheDocument();
  });

  /*
   * The warning is the one place this page derives a year from home classes,
   * so it is where the overlay shows: 5ma1 was carried with p-1 in it, and p-1
   * is in this year's 4.1 — a class with a year. If the activation takes p-1
   * out of every class (graduating, or a class not rolled over), next year's
   * 5ma1 has no member with a class and the engine gets no year for it.
   */
  it("warns about a carried group whose only member leaves at the activation", async () => {
    apiGet.mockResolvedValue({
      ...PROJECTED,
      homeClasses: [{ studentId: "p-1", studentGroupId: null }],
    });
    render(<GeneratePage />);

    const warning = (await screen.findByText("generate.noYearTitle(1)")).closest("[role=status]");
    expect(warning?.textContent).toContain("5ma1");
  });

  it("would not warn about it on this year's rows — the case the overlay exists for", async () => {
    apiGet.mockResolvedValue({ ...PROJECTED, basis: "CURRENT", homeClasses: [] });
    render(<GeneratePage />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    await Promise.resolve();

    expect(screen.queryByText(/generate\.noYearTitle/)).toBeNull();
  });

  it("says so when the class lists could not be fetched, instead of planning on empty classes", async () => {
    apiGet.mockRejectedValue(new Error("503"));
    render(<GeneratePage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "planningYear.rostersFailed(2027/28)",
    );
  });

  it("points the result's link at next year's grid", async () => {
    state.job = {
      id: "job-9",
      status: "SUCCEEDED",
      solverStatus: "OPTIMAL",
      lessonsGenerated: 12,
      conflicts: [],
      createdAt: "2026-10-07T10:00:00.000Z",
    };
    render(<GeneratePage />);
    await screen.findByText("planningYear.bannerTitle(2027/28)");

    expect(screen.getByRole("link", { name: /generate\.viewTimetable/ })).toHaveAttribute(
      "href",
      "/admin/timetable?year=y-2",
    );
  });

  it("asks for no rosters, and shows no banner, for this year", async () => {
    window.history.replaceState(null, "", "/");
    render(<GeneratePage />);
    // The choice is there, on this year; nothing was fetched for it.
    expect(
      screen.getByRole("button", { name: "planningYear.optionActive(2026/27)", pressed: true }),
    ).toBeInTheDocument();
    await Promise.resolve();

    expect(apiGet).not.toHaveBeenCalled();
    expect(state.requirementsFor.at(-1)).toBe("y-1");
    expect(screen.queryByText(/planningYear\.bannerTitle/)).toBeNull();
    // This year IS the active one, and its row says so.
    expect(screen.getByText("generate.preYear")).toBeInTheDocument();
  });

  it("switches to next year from the choice, and the run follows it", async () => {
    window.history.replaceState(null, "", "/");
    render(<GeneratePage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "planningYear.optionNext(2027/28)" }));

    expect(await screen.findByText("planningYear.bannerTitle(2027/28)")).toBeInTheDocument();
    expect(state.requirementsFor.at(-1)).toBe("y-2");
  });

  it("offers no choice while there is no next year to plan", () => {
    state.years = [ACTIVE];
    render(<GeneratePage />);

    expect(screen.queryByRole("group", { name: "planningYear.label" })).toBeNull();
  });
});

describe("the checklist's state ladder", () => {
  it("shows the year unmet for a school whose years are all inactive, rather than waiting for good", () => {
    // usePlanningYear holds the year back one render, for ?year=, but only a
    // school with an active year ever gets one. Waiting on "there are years"
    // instead kept the checklist a skeleton forever here.
    state.years = [{ ...ACTIVE, isActive: false }];
    const { container } = render(<GeneratePage />);

    expect(screen.getByText("generate.preYear")).toBeTruthy();
    expect(screen.getAllByRole("img", { name: "generate.preState.unmet" }).length).toBeGreaterThan(0);
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });
});

describe("the checklist when a read fails", () => {
  it("says the prerequisites could not be read when the first read fails, and does not run", () => {
    state.requirements = undefined;
    state.requirementsFailed = true;
    render(<GeneratePage />);

    const checklist = screen.getByRole("region", { name: "generate.prerequisites" });
    expect(within(checklist).getByText("generate.loadFailed")).toBeTruthy();
    expect(within(checklist).getByText("generate.loadFailedHint")).toBeTruthy();
    expect(within(checklist).queryByText("generate.preRequirements")).toBeNull();
    expect(screen.getByRole("button", { name: "generate.run" }).hasAttribute("disabled")).toBe(true);
  });

  it("keeps the checklist it has read when a refetch fails, and says so above it", () => {
    state.requirementsFailed = true;
    render(<GeneratePage />);

    const checklist = screen.getByRole("region", { name: "generate.prerequisites" });
    const notice = within(checklist).getByRole("alert");
    expect(within(notice).getByText("generate.loadFailed")).toBeTruthy();
    expect(within(notice).getByText("common.refetchFailedHint")).toBeTruthy();
    expect(within(checklist).getByText("generate.preRequirements")).toBeTruthy();
  });
});

describe("the run history's state ladder", () => {
  const historySection = () => screen.getByRole("region", { name: "generate.historyTitle" });
  const run = {
    id: "job-1",
    status: "SUCCEEDED",
    solverStatus: "OPTIMAL",
    conflictSummaryCode: null,
    lessonsGenerated: 120,
    createdAt: "2026-10-01T08:00:00.000Z",
  };

  it("waits for the years rather than saying there are no runs", () => {
    state.years = undefined;
    state.yearsLoading = true;
    render(<GeneratePage />);

    expect(historySection().querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(within(historySection()).queryByText("generate.historyEmpty")).toBeNull();
  });

  it("says the years could not be read rather than that there are no runs", () => {
    state.years = undefined;
    state.yearsFailed = true;
    render(<GeneratePage />);

    const notice = within(historySection()).getByRole("alert");
    expect(within(notice).getByText("generate.historyLoadFailed")).toBeTruthy();
    expect(within(notice).getByText("generate.historyYearsLoadFailedHint")).toBeTruthy();
    expect(within(historySection()).queryByText("generate.historyEmpty")).toBeNull();
  });

  it("says there is no year rather than that there are no runs", () => {
    state.years = [];
    render(<GeneratePage />);

    expect(within(historySection()).getByText("generate.historyNoYear")).toBeTruthy();
    expect(within(historySection()).queryByText("generate.historyEmpty")).toBeNull();
  });

  it("says a year with no runs has none", () => {
    render(<GeneratePage />);

    expect(within(historySection()).getByText("generate.historyEmpty")).toBeTruthy();
  });

  it("keeps the runs it has read when a refetch fails, and says so above them", () => {
    state.history = [run];
    state.historyFailed = true;
    render(<GeneratePage />);

    const notice = within(historySection()).getByRole("alert");
    expect(within(notice).getByText("common.refetchFailedHint")).toBeTruthy();
    expect(within(historySection()).getByText("generate.lessonsGenerated(120)")).toBeTruthy();
  });
});

describe("Schemaförslag beside Generera (design §6)", () => {
  const runButton = () => screen.getByRole("button", { name: "generate.run" });
  const candidateRun = (status: string) => ({
    latest: {
      run: {
        id: "run-1", status, requested: 3, progress: 1, createdAt: "2026-10-17T08:00:00.000Z", startedAt: null,
        finishedAt: null, error: null, errorCode: null, errorParams: null, createdById: null, createdByName: null,
        appliedCandidateId: null, appliedAt: null, refreshOfId: null,
      },
      candidates: [],
    },
    batch: null,
    unplaced: null,
  });

  beforeEach(() => {
    state.people.push({ ...pupil("t-1", "g-41"), role: "TEACHER", studentGroupId: null });
  });

  it("waits with Generera while a candidate run of the year is active, and says why beside it", () => {
    state.candidates = candidateRun("RUNNING");
    render(<GeneratePage />);

    const button = runButton();
    expect(button).toBeDisabled();
    const reason = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toContain("scheduleCandidates.generateBlocked");
    expect(within(reason!).getByRole("link", { name: "scheduleCandidates.generateBlockedLink" })).toHaveAttribute(
      "href",
      "#candidates",
    );
  });

  it("lets Generera run once the candidate run has finished", () => {
    state.candidates = candidateRun("FAILED");
    render(<GeneratePage />);

    expect(runButton()).toBeEnabled();
    expect(runButton().getAttribute("aria-describedby")).toBeNull();
  });

  it("keeps the proposals waiting while a Generera job of the year runs, saying so", () => {
    state.history = [
      { id: "job-other", status: "RUNNING", solverStatus: null, lessonsGenerated: 0, createdAt: new Date().toISOString() },
    ];
    render(<GeneratePage />);

    const start = screen.getByRole("button", { name: "scheduleCandidates.section.start" });
    expect(start).toBeDisabled();
    expect(document.getElementById(start.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "scheduleCandidates.section.blockedGenerating",
    );
  });

  /*
   * Nothing else reads the history again while the page stays open (no
   * focus refetch in this app), so the page polls it itself while such a
   * job runs, and judges the 15 minutes against a clock the poll moves.
   */
  describe("once that job ends, without a reload", () => {
    const start = () => screen.getByRole("button", { name: "scheduleCandidates.section.start" });
    beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] }));
    afterEach(() => vi.useRealTimers());

    it("reads the history again and lets the proposals start when the job has finished", () => {
      const running = { id: "job-other", status: "RUNNING", solverStatus: null, lessonsGenerated: 0, createdAt: new Date().toISOString() };
      state.history = [running];
      historyRefetch.mockImplementation(async () => {
        state.history = [{ ...running, status: "SUCCEEDED", solverStatus: "OPTIMAL", lessonsGenerated: 12 }];
      });
      render(<GeneratePage />);
      expect(start()).toBeDisabled();
      expect(historyRefetch).not.toHaveBeenCalled();

      act(() => vi.advanceTimersByTime(5000));
      expect(historyRefetch).toHaveBeenCalledTimes(1);
      expect(start()).toBeEnabled();
      expect(screen.getByText("generate.historyStatus.OPTIMAL")).toBeInTheDocument();

      // Nothing runs any more, so nothing is polled.
      act(() => vi.advanceTimersByTime(30_000));
      expect(historyRefetch).toHaveBeenCalledTimes(1);
    });

    it("lets them start when a job the history still calls running passes the gateway's 15 minutes", () => {
      state.history = [
        {
          id: "job-lost", status: "RUNNING", solverStatus: null, lessonsGenerated: 0,
          createdAt: new Date(Date.now() - 15 * 60 * 1000 + 3000).toISOString(),
        },
      ];
      render(<GeneratePage />);
      expect(start()).toBeDisabled();

      act(() => vi.advanceTimersByTime(5000));
      expect(start()).toBeEnabled();
    });
  });

  it("reads the history again once its own job has ended, so the list does not keep it waiting", () => {
    state.job = {
      id: "job-own", status: "SUCCEEDED", solverStatus: "OPTIMAL", lessonsGenerated: 12, conflicts: [],
      createdAt: "2026-10-17T08:00:00.000Z",
    };
    render(<GeneratePage />);

    expect(historyRefetch).toHaveBeenCalled();
  });

  it("reads the overview again when Generera is refused for a run started elsewhere", async () => {
    // Started in another tab since this page read the overview: until it is
    // read again, the section says there is no run and Generera stays enabled.
    noMutation.mutateAsync.mockRejectedValueOnce(new ApiError(409, "Candidates are running.", "CANDIDATES_RUNNING"));
    render(<GeneratePage />);
    await userEvent.setup().click(runButton());

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("scheduleCandidates.jobErrors.CANDIDATES_RUNNING"),
    );
    expect(candidatesRefetch).toHaveBeenCalledTimes(1);
  });

  it("does not wait for a job the gateway no longer counts as running (older than 15 minutes)", () => {
    state.history = [
      { id: "job-lost", status: "RUNNING", solverStatus: null, lessonsGenerated: 0, createdAt: "2026-01-01T08:00:00.000Z" },
    ];
    render(<GeneratePage />);

    expect(screen.getByRole("button", { name: "scheduleCandidates.section.start" })).toBeEnabled();
  });

  it.each(["GENERATE_STALE", "SCHEDULE_BUSY", "ENGINE_LACKS_PERIODS", "ENGINE_LACKS_PINNED_LESSONS", "ENGINE_MEALS_INCONSISTENT", "ENGINE_TIMED_OUT"])("says in its own words why a job stopped before writing (%s)", (code) => {
    // The gateway's codes, not the engine's: engineMessages has no sentence
    // for them, so without these the admin would read the English.
    state.job = {
      id: "job-8", status: "FAILED", solverStatus: null, error: "The draft changed during the run.", errorCode: code,
      errorParams: null, conflicts: [], createdAt: "2026-10-17T08:00:00.000Z",
    };
    render(<GeneratePage />);

    expect(screen.getByText(`scheduleCandidates.jobErrors.${code}`)).toBeInTheDocument();
    expect(screen.queryByText("The draft changed during the run.")).toBeNull();
  });

  /*
   * The runs that gave no answer say as much of their figures as the gateway has (run-ending.ts, omgång 13 M2): the
   * stub echoes a sentence's figures after its key, in the order the sentence says them.
   */
  describe("a run that ended without an answer from the engine", () => {
    const ended = (errorCode: string, errorParams: Record<string, string | number> | null) => ({
      id: "job-9", status: "FAILED", solverStatus: null, lessonsGenerated: 0, conflicts: [],
      error: "The AI engine did not respond in time.", errorCode, errorParams,
      createdAt: "2026-11-21T08:00:00.000Z", finishedAt: "2026-11-21T08:04:30.000Z",
    });

    it.each([
      ["the engine's ceiling, and the step its solve was in", "ENGINE_TIMED_OUT", { ceilingSeconds: 230, stage: "SEARCH_CLONE", stageSeconds: 160, elapsedSeconds: 230 }, "ENGINE_TIMED_OUT_AT(230|SEARCH_CLONE|160|230)"],
      ["the engine's ceiling alone", "ENGINE_TIMED_OUT", { ceilingSeconds: 230 }, "ENGINE_TIMED_OUT_CEILING(230)"],
      ["a wait shorter than the engine says it needs", "ENGINE_WAIT_EXPIRED", { waitSeconds: 120, engineCeilingSeconds: 230 }, "ENGINE_WAIT_EXPIRED_SHORT(120|230)"],
      ["a wait that was long enough", "ENGINE_WAIT_EXPIRED", { waitSeconds: 240, engineCeilingSeconds: 230 }, "ENGINE_WAIT_EXPIRED_AFTER(240)"],
      ["a wait with no figure", "ENGINE_WAIT_EXPIRED", null, "ENGINE_WAIT_EXPIRED"],
      ["an engine that was not reached", "ENGINE_NOT_REACHED", null, "ENGINE_NOT_REACHED"],
      ["a run abandoned after it had gone on a while", "ENGINE_RUN_ABANDONED", { lastSeenSeconds: 150 }, "ENGINE_RUN_ABANDONED_AFTER(150)"],
    ])("says %s in its own words, never the English", (_name, code, params, shown) => {
      state.job = ended(code, params);
      render(<GeneratePage />);

      expect(screen.getByText(`scheduleCandidates.jobErrors.${shown}`)).toBeInTheDocument();
      expect(screen.queryByText("The AI engine did not respond in time.")).toBeNull();
    });

    it("says an abandoned run's figure after a reload too, when the newest run of the year is the one that went away", () => {
      state.history = [ended("ENGINE_RUN_ABANDONED", { lastSeenSeconds: 95 })];
      render(<GeneratePage />);

      expect(screen.getByText("scheduleCandidates.jobErrors.ENGINE_RUN_ABANDONED_AFTER(95)")).toBeInTheDocument();
    });
  });

  /*
   * A run whose process went away (the service was restarted, or lost): its lease ran out, and the gateway reads a run
   * past its lease as FAILED ENGINE_RUN_ABANDONED before the sweep has come round. The page says what happened, in the
   * gateway's own words, and offers to run again; it never polls a dead run for ever.
   */
  describe("a run whose process went away", () => {
    const abandoned = (over: Record<string, unknown> = {}) => ({
      id: "job-gone", status: "FAILED", solverStatus: null, lessonsGenerated: 0, conflicts: [],
      error: "The run stopped before it finished: the service that ran it was restarted or lost.",
      errorCode: "ENGINE_RUN_ABANDONED", errorParams: null,
      createdAt: "2026-11-18T08:00:00.000Z", finishedAt: "2026-11-18T08:04:30.000Z",
      ...over,
    });

    it("says the sentence, not the English, and offers to run again", async () => {
      state.job = abandoned();
      render(<GeneratePage />);

      expect(screen.getByText("scheduleCandidates.jobErrors.ENGINE_RUN_ABANDONED")).toBeInTheDocument();
      expect(screen.queryByText(/the service that ran it was restarted/)).toBeNull();
      const again = screen.getByRole("button", { name: "generate.runAgain" });
      expect(again).toBeEnabled();
      await userEvent.setup().click(again);
      expect(noMutation.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ academicYearId: "y-1" }));
    });

    it("offers it after a reload too, when the newest run of the year is the one that went away", () => {
      state.history = [abandoned()];
      render(<GeneratePage />);

      expect(screen.getByText("scheduleCandidates.jobErrors.ENGINE_RUN_ABANDONED")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "generate.runAgain" })).toBeEnabled();
      // And the history names it for what it is, not as a failure of its own.
      expect(screen.getByText("generate.historyStatus.ABANDONED")).toBeInTheDocument();
      expect(screen.queryByText("generate.historyStatus.FAILED")).toBeNull();
    });

    it("does not say a run was interrupted when the newest run of the year failed on its own account", () => {
      // After a reload, a failure that is the engine's or the school's is not "the service was restarted": only the abandonment is.
      state.history = [abandoned({ id: "job-failed", error: "The AI engine returned an error.", errorCode: "ENGINE_ERROR" })];
      render(<GeneratePage />);

      expect(screen.queryByText("scheduleCandidates.jobErrors.ENGINE_RUN_ABANDONED")).toBeNull();
      expect(screen.queryByRole("button", { name: "generate.runAgain" })).toBeNull();
      expect(screen.getByText("generate.historyStatus.FAILED")).toBeInTheDocument();
    });

    it("says nothing about an older run that went away once a later one has run", () => {
      state.history = [
        { id: "job-new", status: "SUCCEEDED", solverStatus: "OPTIMAL", lessonsGenerated: 12, createdAt: "2026-11-18T09:00:00.000Z" },
        abandoned(),
      ];
      render(<GeneratePage />);

      expect(screen.queryByText("scheduleCandidates.jobErrors.ENGINE_RUN_ABANDONED")).toBeNull();
      expect(screen.queryByRole("button", { name: "generate.runAgain" })).toBeNull();
      expect(screen.getByText("generate.historyStatus.ABANDONED")).toBeInTheDocument();
    });

    it("says it once when this page has a run of its own to show", () => {
      state.job = { ...abandoned({ id: "job-own" }), error: "The draft changed.", errorCode: "GENERATE_STALE" };
      state.history = [abandoned()];
      render(<GeneratePage />);

      expect(screen.queryByText("scheduleCandidates.jobErrors.ENGINE_RUN_ABANDONED")).toBeNull();
      expect(screen.queryByRole("button", { name: "generate.runAgain" })).toBeNull();
    });

    it("keeps the button waiting while a run of the year is going, and while the next run it starts is", () => {
      state.history = [
        { id: "job-other", status: "RUNNING", solverStatus: null, lessonsGenerated: 0, createdAt: new Date().toISOString() },
        abandoned(),
      ];
      state.job = abandoned({ id: "job-own" });
      render(<GeneratePage />);

      expect(screen.getByRole("button", { name: "generate.runAgain" })).toBeDisabled();
    });

    it("waits for the week's check like Generera does, so a second click starts neither a second check nor a second run", async () => {
      // A run starts with Kontrollera veckan: the button that starts one again is held for as long as that check is on its way.
      state.job = abandoned();
      apiPost.mockReturnValue(new Promise(() => undefined));
      // The mutation spy is the file's, shared by every test that clicks Generera: this one counts its own calls.
      noMutation.mutateAsync.mockClear();
      render(<GeneratePage />);

      const again = screen.getByRole("button", { name: "generate.runAgain" });
      await userEvent.setup().click(again);

      expect(screen.getByRole("button", { name: "generate.runAgain" })).toBeDisabled();
      expect(apiPost).toHaveBeenCalledTimes(1);
      expect(noMutation.mutateAsync).not.toHaveBeenCalled();
    });
  });

  /*
   * One run of a year at a time, in the database (OptimizationJobs_one_active_per_year): the second start is refused
   * 409 GENERATE_ALREADY_RUNNING. The page says so before the click when it has read the other run, and after it when
   * it has not.
   */
  describe("a second start of a year that has a run going", () => {
    it("keeps Generera waiting for a run someone else started, saying so", () => {
      state.history = [
        { id: "job-other", status: "RUNNING", solverStatus: null, lessonsGenerated: 0, createdAt: new Date().toISOString() },
      ];
      render(<GeneratePage />);

      expect(runButton()).toBeDisabled();
      expect(document.getElementById(runButton().getAttribute("aria-describedby") ?? "")?.textContent).toBe("generate.blockedRunning");
    });

    it("does not keep it waiting for a run of its own that the history still calls running", () => {
      state.job = { id: "job-own", status: "SUCCEEDED", solverStatus: "OPTIMAL", lessonsGenerated: 12, conflicts: [], createdAt: "2026-11-18T08:00:00.000Z" };
      state.history = [
        { id: "job-own", status: "RUNNING", solverStatus: null, lessonsGenerated: 0, createdAt: new Date().toISOString() },
      ];
      render(<GeneratePage />);

      expect(runButton()).toBeEnabled();
      expect(screen.queryByText("generate.blockedRunning")).toBeNull();
    });

    it("reads the history again when the start is refused, so the run shows and is polled", async () => {
      // Started in another tab since this page read the history: until it is read again, the page has no run to wait for.
      noMutation.mutateAsync.mockRejectedValueOnce(new ApiError(409, "Generera kör redan.", "GENERATE_ALREADY_RUNNING"));
      render(<GeneratePage />);
      await userEvent.setup().click(runButton());

      expect(toast.error).toHaveBeenCalledWith("scheduleCandidates.jobErrors.GENERATE_ALREADY_RUNNING");
      expect(historyRefetch).toHaveBeenCalledTimes(1);
      expect(candidatesRefetch).not.toHaveBeenCalled();
    });
  });

  describe("a run the write refused after reading the school again (GENERATE_STALE with the parts it found changed)", () => {
    const stale = (errorParams: Record<string, string | number> | null) => {
      state.job = {
        id: "job-9", status: "FAILED", solverStatus: null, error: "Grundschemat ändrades medan schemat genererades.",
        errorCode: "GENERATE_STALE", errorParams, conflicts: [], createdAt: "2026-10-17T08:00:00.000Z",
      };
      render(<GeneratePage />);
    };

    it("names the parts, in the words the candidates page names them in", () => {
      stale({ changed: "preserved,rules" });

      // The stub echoes the key and the values; the list is Swedish's "a och b".
      expect(
        screen.getByText(
          "scheduleCandidates.jobErrors.GENERATE_STALE_PARTS(scheduleCandidates.parts.preserved och scheduleCandidates.parts.rules)",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText("scheduleCandidates.jobErrors.GENERATE_STALE")).toBeNull();
    });

    it("says the general sentence for a refusal that named nothing, or named something else", () => {
      stale({ refusalCode: "STAFF_UNSTAFFED_REQUIREMENTS" });

      expect(screen.getByText("scheduleCandidates.jobErrors.GENERATE_STALE")).toBeInTheDocument();
    });

    it("lists a part this build has no word for by its name rather than dropping it", () => {
      stale({ changed: "rules,somethingNew" });

      expect(
        screen.getByText(
          "scheduleCandidates.jobErrors.GENERATE_STALE_PARTS(scheduleCandidates.parts.rules och somethingNew)",
        ),
      ).toBeInTheDocument();
    });
  });
});


/*
 * Förläggningar, back to the week (A3): the row before a run says how many lessons lie fixed and how many of them no longer hold,
 * and a refusal that names a förläggning links to its card. The links are built from the ids the gateway puts in a line's params
 * (lib/placement-link.contract.test.ts holds them to the gateway's own lines); here the page is held to what it draws.
 */
describe("förläggningar: the way back to the week", () => {
  const board = (placed: number[], failing = 0, blocks?: unknown) => ({
    academicYearId: "y-1",
    posts: placed.map((n, index) => ({ id: `p-${index}`, parts: [{ placed: n }] })),
    placements: Array.from({ length: Math.max(failing, 1) }, (_, index) => ({ verdict: { ok: index >= failing } })),
    ...(blocks ? { blocks } : {}),
  });
  const line = () => screen.queryByTestId("generate-placed");
  const runButton = () => screen.getByRole("button", { name: /generate\.run/ });
  const refusal = (conflicts: unknown[]) => {
    state.job = {
      id: "job-p",
      status: "SUCCEEDED",
      solverStatus: "INFEASIBLE",
      conflictSummary: "1 placed lesson(s) can no longer stand.",
      conflictSummaryCode: "PLACEMENTS_REFUSED_SUMMARY",
      conflictSummaryParams: { count: 1 },
      conflicts,
      createdAt: "2026-11-16T10:00:00.000Z",
    };
  };
  const placementLine = (params: Record<string, string | number>, over: Record<string, unknown> = {}) => ({
    category: "PLACEMENT",
    code: "PLACEMENT_CANNOT_STAND",
    params: { requirement: "Matematik för 7A", room: "A12", day: 3, start: "10:00", end: "11:00", reason: "TEACHER", block: "NO_BLOCK", ...params },
    message: "A placed lesson cannot stand.",
    resourceNames: [],
    ...over,
  });
  const hrefOf = (element: HTMLElement) => {
    const href = element.getAttribute("href")!;
    return { path: href.split("?")[0], query: Object.fromEntries(new URLSearchParams(href.split("?")[1] ?? "")) };
  };

  describe("the row before a run", () => {
    it("says how many lessons lie fixed, with a way to the week for the läsår generated", async () => {
      state.placementBoard = board([2, 3]);
      render(<GeneratePage />);
      const row = await screen.findByTestId("generate-placed");
      expect(row).toHaveTextContent("generate.placed.fixed(5)");
      const link = within(row).getByRole("link", { name: "generate.placed.toWeek" });
      expect(hrefOf(link)).toEqual({ path: "/admin/placements", query: {} });
      expect(within(row).queryByTestId("generate-placed-failing")).not.toBeInTheDocument();
      expect(state.placementBoardFor.at(-1)).toBe("y-1");
    });

    it("names the läsår in the link when it is not the active one, as the grundschema's link does", async () => {
      state.years = [ACTIVE, NEXT];
      window.history.replaceState(null, "", "/sv/admin/generate?year=y-2");
      state.placementBoard = board([1]);
      render(<GeneratePage />);
      const row = await screen.findByTestId("generate-placed");
      expect(hrefOf(within(row).getByRole("link"))).toEqual({ path: "/admin/placements", query: { year: "y-2" } });
      window.history.replaceState(null, "", "/sv/admin/generate");
    });

    it("says how many no longer hold, in the week's own sentence, and the run is not held back by it", async () => {
      // Every other prerequisite met, so that the button's state is a thing the row could change.
      state.people.push({ ...pupil("t-1", "g-41"), role: "TEACHER", studentGroupId: null });
      const without = render(<GeneratePage />);
      expect(runButton()).toBeEnabled();
      without.unmount();
      state.placementBoard = board([3], 2);
      render(<GeneratePage />);
      const row = await screen.findByTestId("generate-placed");
      expect(within(row).getByTestId("generate-placed-failing")).toHaveTextContent("generate.placed.failing(2)");
      // A help and never a gate: the button is as enabled as it was with no row at all.
      expect(runButton()).toBeEnabled();
    });

    it("counts a block's lesson once for each of its rows with a verdict that fails", async () => {
      state.placementBoard = board([2], 1, [{ rows: [{ verdicts: [{ ok: true }, { ok: false }] }, { verdicts: [{ ok: true }] }] }]);
      render(<GeneratePage />);
      expect(await screen.findByTestId("generate-placed-failing")).toHaveTextContent("generate.placed.failing(2)");
    });

    it("draws nothing with no förläggning: no row, no link", async () => {
      state.placementBoard = board([0, 0]);
      render(<GeneratePage />);
      await waitFor(() => expect(state.placementBoardFor.length).toBeGreaterThan(0));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(line()).not.toBeInTheDocument();
    });

    it("draws nothing for a read that failed or has not come, and keeps every other part of the page", async () => {
      state.people.push({ ...pupil("t-1", "g-41"), role: "TEACHER", studentGroupId: null });
      state.placementBoard = undefined;
      render(<GeneratePage />);
      await waitFor(() => expect(state.placementBoardFor.length).toBeGreaterThan(0));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(line()).not.toBeInTheDocument();
      expect(runButton()).toBeEnabled();
    });

    it("reads nothing for a page with no year yet", async () => {
      state.years = [];
      render(<GeneratePage />);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(state.placementBoardFor.filter((id) => id !== null)).toEqual([]);
      expect(line()).not.toBeInTheDocument();
    });
  });

  describe("a refusal that names a förläggning", () => {
    it("leads with a link to its card under the sentence: the post, the day and the start the gateway says", () => {
      refusal([placementLine({ postId: "post-1", day: 3, start: "10:00" })]);
      render(<GeneratePage />);
      const link = screen.getByRole("link", { name: /generate.placed.refusalLinkLabel/ });
      expect(link).toHaveTextContent("generate.placed.refusalLink");
      expect(hrefOf(link)).toEqual({ path: "/admin/placements", query: { post: "post-1", day: "3", start: "10:00" } });
    });

    it("is named by the sentence it is about: a probe can list a hundred of them", () => {
      refusal([
        placementLine({ postId: "post-1", day: 3, start: "10:00" }),
        placementLine({ postId: "post-2", day: 4, start: "13:00", requirement: "Svenska för 7B" }),
      ]);
      render(<GeneratePage />);
      const links = screen.getAllByRole("link", { name: /generate.placed.refusalLinkLabel/ });
      expect(links).toHaveLength(2);
      expect(links[0]!.getAttribute("aria-label")).not.toBe(links[1]!.getAttribute("aria-label"));
      expect(links[1]!.getAttribute("aria-label")).toContain("engineMessages.PLACEMENT_CANNOT_STAND");
    });

    it("carries the block for a block's lesson, and the läsår when it is not the active one", () => {
      state.years = [ACTIVE, NEXT];
      window.history.replaceState(null, "", "/sv/admin/generate?year=y-2");
      refusal([placementLine({ postId: "member-1", blockId: "block-1", day: 4, start: "13:15" })]);
      render(<GeneratePage />);
      expect(hrefOf(screen.getByRole("link", { name: /generate.placed.refusalLinkLabel/ }))).toEqual({
        path: "/admin/placements",
        query: { year: "y-2", post: "member-1", day: "4", start: "13:15", block: "block-1" },
      });
      window.history.replaceState(null, "", "/sv/admin/generate");
    });

    it("draws no link for a line stored before the ids, and nothing else about it changes", () => {
      refusal([placementLine({})]);
      render(<GeneratePage />);
      expect(screen.queryByRole("link", { name: /generate.placed.refusalLinkLabel/ })).not.toBeInTheDocument();
      expect(screen.getByText(/^engineMessages\.PLACEMENT_CANNOT_STAND\(/)).toBeInTheDocument();
    });

    it("draws no link for a line of another category, even one that has the ids", () => {
      refusal([placementLine({ postId: "post-1", day: 3, start: "10:00" }, { category: "AVAILABILITY" })]);
      render(<GeneratePage />);
      expect(screen.queryByRole("link", { name: /generate.placed.refusalLinkLabel/ })).not.toBeInTheDocument();
    });

    it("names the post only when the day is none of the school week (a lesson placed on a Saturday): the list opens on it", () => {
      refusal([placementLine({ postId: "post-1", day: 6, start: "10:00" })]);
      render(<GeneratePage />);
      expect(hrefOf(screen.getByRole("link", { name: /generate.placed.refusalLinkLabel/ }))).toEqual({
        path: "/admin/placements",
        query: { post: "post-1" },
      });
    });

    it("links a run that failed with the engine's own refusal of a pinned lesson, from the error's params", () => {
      state.job = {
        id: "job-e",
        status: "FAILED",
        solverStatus: null,
        lessonsGenerated: 0,
        conflictSummary: null,
        conflicts: [],
        error: "A pinned lesson is outside the frame.",
        errorCode: "PLACED_LESSON_OUTSIDE_FRAME",
        errorParams: { requirement: "Idrott för 7A", day: 2, start: "07:00", end: "08:00", postId: "post-9" },
        createdAt: "2026-11-16T10:00:00.000Z",
      };
      render(<GeneratePage />);
      expect(hrefOf(screen.getByRole("link", { name: /generate.placed.refusalLinkLabel/ }))).toEqual({
        path: "/admin/placements",
        query: { post: "post-9", day: "2", start: "07:00" },
      });
    });

    it("draws no link under a failed run that names no post", () => {
      state.job = {
        id: "job-f",
        status: "FAILED",
        solverStatus: null,
        lessonsGenerated: 0,
        conflictSummary: null,
        conflicts: [],
        error: "No lunch break fits.",
        errorCode: "LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK",
        errorParams: { group: "4A", minutes: 30 },
        createdAt: "2026-11-16T10:00:00.000Z",
      };
      render(<GeneratePage />);
      expect(screen.queryByRole("link", { name: /generate.placed.refusalLinkLabel/ })).not.toBeInTheDocument();
    });
  });
});
