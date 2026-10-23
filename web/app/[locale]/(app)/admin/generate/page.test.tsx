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
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { get: apiGet },
}));

const noMutation = { mutateAsync: vi.fn(), isPending: false };
/** The two reads the page asks to be made again: the year's history, the candidates overview. */
const historyRefetch = vi.hoisted(() => vi.fn());
const candidatesRefetch = vi.hoisted(() => vi.fn());

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
  useLunchSettings: () => ({ data: null }),
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
  historyRefetch.mockReset();
  candidatesRefetch.mockReset();
  state.years = [ACTIVE];
  state.yearsLoading = false;
  state.yearsFailed = false;
  state.requirementsFailed = false;
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
    const superseded = (ordinal: number | null, variant: string | null) =>
      laid({ notes: [WISH], finishedAt: "2026-10-17T10:01:00.000Z", supersededBy: { appliedAt: "2026-10-17T10:05:00.000Z", ordinal, variant } });

    it("names the candidate and points to the comparison in place of the run's list, with no batch left to say so", () => {
      // "Ta bort förslagen", a newer batch or the week's sweep took the
      // applied run: the overview no longer knows, and the card still does.
      state.job = superseded(2, "TEACHER_GAPS");
      state.candidates = { latest: null, batch: null, unplaced: null };
      render(<GeneratePage />);

      const section = screen.getByRole("region", { name: "generate.notesTitle" });
      expect(within(section).getByText(/^generate\.notesSuperseded\(2\|scheduleCandidates\.variant\.TEACHER_GAPS\)/)).toBeInTheDocument();
      expect(within(section).getByRole("link", { name: "generate.notesSupersededLink" })).toHaveAttribute(
        "href",
        "/admin/generate/candidates#comparison",
      );
      // Neither the run's wishes nor the hint to move its lessons by hand.
      expect(within(section).queryByText(SENTENCE)).toBeNull();
      expect(within(section).queryByText("Eva Ek")).toBeNull();
      expect(within(section).queryByText("generate.notesHint")).toBeNull();
    });

    it("says a candidate was applied, without a name, when the log does not say which", () => {
      state.job = superseded(null, null);
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
    expect(noMutation.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ academicYearId: "y-2" }),
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

    expect(toast.error).toHaveBeenCalledWith("scheduleCandidates.jobErrors.CANDIDATES_RUNNING");
    expect(candidatesRefetch).toHaveBeenCalledTimes(1);
  });

  it("does not wait for a job the gateway no longer counts as running (older than 15 minutes)", () => {
    state.history = [
      { id: "job-lost", status: "RUNNING", solverStatus: null, lessonsGenerated: 0, createdAt: "2026-01-01T08:00:00.000Z" },
    ];
    render(<GeneratePage />);

    expect(screen.getByRole("button", { name: "scheduleCandidates.section.start" })).toBeEnabled();
  });

  it.each(["GENERATE_STALE", "SCHEDULE_BUSY"])("says in its own words why a job stopped before writing (%s)", (code) => {
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
});
