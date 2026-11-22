import { act, cleanup, render as renderPlain, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";

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
  /** The runs of a year that has its own (a year not named here gets `history`). */
  historyOf: {} as Record<string, unknown[]>,
  /** The run the page asked for, in order: null is the read of a page with no run of its own. */
  jobFor: [] as (string | null)[],
  /** The hook is disabled without a run, as the real one is: no id, no data. Off, `job` answers whatever was asked. */
  jobNeedsId: false,
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
  useOptimizationJob: (jobId: string | null) => {
    state.jobFor.push(jobId);
    return { data: state.jobNeedsId && jobId === null ? undefined : state.job };
  },
  useOptimizationHistory: (yearId: string | null) => {
    state.historyFor.push(yearId);
    // Disabled without a year, as the real hook is: never asked, never failed.
    return yearId === null
      ? { data: undefined, isLoading: false, isError: false, refetch: historyRefetch }
      : { data: state.historyOf[yearId] ?? state.history, isLoading: false, isError: state.historyFailed, refetch: historyRefetch };
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
  state.historyOf = {};
  state.jobFor = [];
  state.jobNeedsId = false;
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


/*
 * M2: THE CARD "SÅ GICK TIDEN" IS A LAZY CHUNK, and a chunk that does not come must leave the sentence a TIMEOUT has always said, not an
 * empty place (the boundary's `fallback`), and a chunk on its way must leave it too (the Suspense fallback). page.test.tsx cannot
 * say either: its import of the card succeeds, and a lazy() component keeps the outcome of its first load for the life of the module,
 * so each case here loads the page afresh, with the card's module replaced.
 */

const timedOut = {
  id: "job-t",
  status: "SUCCEEDED",
  solverStatus: "TIMEOUT",
  lessonsGenerated: 0,
  conflictSummary: null,
  conflictSummaryCode: null,
  conflicts: [
    { category: "TIMEOUT_PROBE", message: "A timetable was found in 4 s.", resourceNames: [] },
  ],
  report: {
    totalSeconds: 109,
    budgetSeconds: 100,
    configuredBudgetSeconds: 100,
    callerWaitSeconds: null,
    stages: [{ stage: "SEARCH_CLEAN", seconds: 60 }],
    search: { solutions: 0, phases: [{ phase: "CLEAN", seconds: 60, conflicts: 12, branches: 34 }] },
    weekLoadCut: false,
  },
  createdAt: "2026-11-21T08:00:00.000Z",
  finishedAt: "2026-11-21T08:03:10.000Z",
};

async function pageWithTheCard(card: "never arrives" | "is on its way"): Promise<React.ComponentType> {
  vi.resetModules();
  vi.doMock("./timeout-account", () => {
    if (card === "never arrives") throw new Error("Failed to fetch dynamically imported module");
    return new Promise(() => undefined);
  });
  return (await import("./page")).default;
}

describe("the card of a run that ran out of time, when its chunk does not arrive", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.doUnmock("./timeout-account");
    vi.restoreAllMocks();
  });

  it("leaves the sentence a TIMEOUT has always said where the card was, and the rows under it", async () => {
    state.job = timedOut;
    const Page = await pageWithTheCard("never arrives");
    render(<Page />);

    // Not findByText: the hint is there from the first frame (the Suspense fallback), and what is asked is whether it is still there
    // once the chunk has failed and the boundary has caught it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getByText("generate.timeoutHint")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "generate.timeoutAccount.title" })).toBeNull();
    // The page stands: the status line and the probe's rows are still there.
    expect(screen.getByText("generate.statusTIMEOUT")).toBeInTheDocument();
    expect(screen.getByText("A timetable was found in 4 s.")).toBeInTheDocument();
  });

  it("says the same sentence while the card is on its way", async () => {
    state.job = timedOut;
    const Page = await pageWithTheCard("is on its way");
    render(<Page />);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getByText("generate.timeoutHint")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "generate.timeoutAccount.title" })).toBeNull();
  });
});


/*
 * G6: THE CARD OF WHAT TO CHANGE IS A LAZY CHUNK TOO, and a chunk that does not come must leave the page as it was, with nothing
 * where the card would have been: the status line, the refusal's sentence and its rows are the page's own, and the card is an addition.
 * A run the gateway does not offer the analysis for, and has none of, does not draw it at all.
 */

const refused = {
  id: "job-r",
  status: "SUCCEEDED",
  solverStatus: "INFEASIBLE",
  lessonsGenerated: 0,
  conflictSummary: null,
  conflictSummaryCode: null,
  conflicts: [{ category: "TEACHER_OVERLAP", message: "Anna is in two rooms at once.", resourceNames: [] }],
  suggestionsOffered: true,
  suggestions: null,
  createdAt: "2026-11-21T08:00:00.000Z",
  finishedAt: "2026-11-21T08:03:10.000Z",
};

async function pageWithTheSuggestionsCard(card: "never arrives" | "is on its way" | "arrives"): Promise<React.ComponentType> {
  vi.resetModules();
  if (card !== "arrives") {
    vi.doMock("./suggestions-card", () => {
      if (card === "never arrives") throw new Error("Failed to fetch dynamically imported module");
      return new Promise(() => undefined);
    });
  }
  return (await import("./page")).default;
}

describe("the card of what to change", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.doUnmock("./suggestions-card");
    vi.restoreAllMocks();
  });

  it("is drawn for a refused run once its chunk has arrived, with the offer and the button, beside the refusal's rows", async () => {
    state.job = refused;
    const Page = await pageWithTheSuggestionsCard("arrives");
    render(<Page />);

    expect(await screen.findByRole("button", { name: "generate.suggestions.offerAction" })).toBeInTheDocument();
    expect(screen.getByText("generate.suggestions.offer")).toBeInTheDocument();
    expect(screen.getByText("Anna is in two rooms at once.")).toBeInTheDocument();
  });

  it("is drawn for a TIMEOUT too, beside the account of where the time went", async () => {
    state.job = { ...timedOut, suggestionsOffered: true, suggestions: null };
    const Page = await pageWithTheSuggestionsCard("arrives");
    render(<Page />);

    expect(await screen.findByText("generate.suggestions.offerTimeout")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "generate.timeoutAccount.title" })).toBeInTheDocument();
  });

  it("is not drawn for a run the gateway does not offer it for and that has no analysis", async () => {
    state.job = { ...refused, suggestionsOffered: false };
    const Page = await pageWithTheSuggestionsCard("arrives");
    render(<Page />);

    expect(await screen.findByText("Anna is in two rooms at once.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "generate.suggestions.title" })).toBeNull();
  });

  it("is not drawn for a run an older gateway sent: the fields are absent, which reads as no offer", async () => {
    const { suggestionsOffered: _offered, suggestions: _suggestions, ...older } = refused;
    state.job = older;
    const Page = await pageWithTheSuggestionsCard("arrives");
    render(<Page />);

    expect(await screen.findByText("Anna is in two rooms at once.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "generate.suggestions.title" })).toBeNull();
  });

  it("leaves the page as it was, with nothing where the card would be, when its chunk does not arrive", async () => {
    state.job = refused;
    const Page = await pageWithTheSuggestionsCard("never arrives");
    render(<Page />);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByRole("heading", { name: "generate.suggestions.title" })).toBeNull();
    expect(screen.queryByRole("button", { name: "generate.suggestions.offerAction" })).toBeNull();
    expect(screen.getByText("generate.statusINFEASIBLE")).toBeInTheDocument();
    expect(screen.getByText("Anna is in two rooms at once.")).toBeInTheDocument();
  });

  it("leaves the page as it was while the card is on its way", async () => {
    state.job = refused;
    const Page = await pageWithTheSuggestionsCard("is on its way");
    render(<Page />);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByRole("heading", { name: "generate.suggestions.title" })).toBeNull();
    expect(screen.getByText("generate.statusINFEASIBLE")).toBeInTheDocument();
  });
});

/*
 * D9 of Åtgärdsförslag vid vägran: A RELOAD LEAVES THE PAGE WITHOUT THE RUN IT STARTED, and the analysis saved on that run was out of
 * reach. The page takes up the year's NEWEST run when it is one the card speaks of (offered, or already holding an analysis) and the
 * page has no run of its own. The hook is disabled without a run (`jobNeedsId`), so what is drawn is what the page asked for, and what
 * it asked for is read from `jobFor`.
 */

const SAVED = {
  version: 1,
  state: "RUNNING",
  startedAt: "2026-11-21T08:04:00.000Z",
  finishedAt: null,
  verdict: null,
  verified: false,
  total: 0,
  searchSeconds: null,
  verifySeconds: null,
  changes: [],
  failure: null,
};
const laidTimetable = {
  ...refused,
  id: "job-ok",
  solverStatus: "OPTIMAL",
  lessonsGenerated: 118,
  conflicts: [],
  suggestionsOffered: false,
  suggestions: null,
};
const asked = () => state.jobFor.filter((id): id is string => id !== null);
const lastRun = () => document.getElementById("last-run");

describe("the run a reload leaves behind", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.jobNeedsId = true;
  });
  afterEach(() => {
    vi.doUnmock("./suggestions-card");
    vi.restoreAllMocks();
  });

  it("is taken up when it is the year's newest and the gateway offers the analysis for it: the card of what to change is there again", async () => {
    state.history = [refused];
    state.job = refused;
    const Page = await pageWithTheSuggestionsCard("arrives");
    render(<Page />);

    expect(await screen.findByRole("button", { name: "generate.suggestions.offerAction" })).toBeInTheDocument();
    expect(screen.getByText("Anna is in two rooms at once.")).toBeInTheDocument();
    expect(asked()).toContain("job-r");
  });

  it("is taken up when it already holds an analysis, even if the gateway no longer offers the button", async () => {
    const holding = { ...refused, suggestionsOffered: false, suggestions: SAVED };
    state.history = [holding];
    state.job = holding;
    const Page = await pageWithTheSuggestionsCard("arrives");
    render(<Page />);

    expect(await screen.findByRole("heading", { name: "generate.suggestions.title" })).toBeInTheDocument();
    expect(asked()).toContain("job-r");
  });

  it("is not taken up when the newest run laid a timetable", async () => {
    state.history = [laidTimetable];
    state.job = laidTimetable;
    const Page = await pageWithTheSuggestionsCard("arrives");
    render(<Page />);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(asked()).toEqual([]);
    expect(lastRun()).toBeNull();
    expect(screen.queryByRole("heading", { name: "generate.suggestions.title" })).toBeNull();
  });

  it("does not bring back an older refusal under a run that has been made since", async () => {
    state.history = [laidTimetable, refused];
    state.job = refused;
    const Page = await pageWithTheSuggestionsCard("arrives");
    render(<Page />);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(asked()).toEqual([]);
    expect(lastRun()).toBeNull();
  });

  it("does not take up a refusal the gateway does not offer for and that holds nothing, nor a run an older gateway sent", async () => {
    const { suggestionsOffered: _offered, suggestions: _suggestions, ...older } = refused;
    state.history = [{ ...refused, suggestionsOffered: false }];
    state.job = refused;
    const Page = await pageWithTheSuggestionsCard("arrives");
    const { unmount } = render(<Page />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(asked()).toEqual([]);
    unmount();

    state.history = [older];
    render(<Page />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(asked()).toEqual([]);
    expect(lastRun()).toBeNull();
  });

  it("never replaces a run of the page's own: another administrator's refusal that turns up in the history is left to the history", async () => {
    state.people.push({ ...pupil("t-1", "g-41"), role: "TEACHER", studentGroupId: null });
    const own = { ...laidTimetable, id: "job-own" };
    state.job = own;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Page = await pageWithTheSuggestionsCard("arrives");
    // A new element each time: React skips the render of the very same one.
    const tree = () => (
      <QueryClientProvider client={client}>
        <Page />
      </QueryClientProvider>
    );
    const view = renderPlain(tree());
    noMutation.mutateAsync.mockResolvedValueOnce({ jobId: "job-own" });
    await userEvent.setup().click(await screen.findByRole("button", { name: "generate.run" }));
    await waitFor(() => expect(asked()).toContain("job-own"));

    state.history = [{ ...refused, id: "job-other" }];
    view.rerender(tree());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(asked()).not.toContain("job-other");
    expect(state.jobFor.at(-1)).toBe("job-own");
  });

  it("is the year's own: choosing another year clears it, and choosing the first again takes it up again", async () => {
    state.years = [ACTIVE, NEXT];
    state.historyOf = { "y-1": [refused], "y-2": [] };
    state.job = refused;
    apiGet.mockResolvedValue({
      academicYearId: "y-2",
      basis: "PROJECTED",
      homeClasses: [],
      counts: { moved: 0, graduates: 0, unplaced: 0 },
      membershipsOutOfDate: { missing: 0, stale: 0 },
    });
    const Page = await pageWithTheSuggestionsCard("arrives");
    render(<Page />);
    expect(await screen.findByRole("button", { name: "generate.suggestions.offerAction" })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "planningYear.optionNext(2027/28)" }));
    await waitFor(() => expect(lastRun()).toBeNull());
    expect(screen.queryByRole("button", { name: "generate.suggestions.offerAction" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "planningYear.optionActive(2026/27)" }));
    expect(await screen.findByRole("button", { name: "generate.suggestions.offerAction" })).toBeInTheDocument();
  });
});
