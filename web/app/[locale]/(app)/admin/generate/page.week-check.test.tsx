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
 * Kontrollera veckan on the Generera page: its own button, and the question before a run. The scaffolding is
 * page.test.tsx's (every read the page makes is stubbed), kept apart so that the tests of the other features of this
 * page and these do not edit one file.
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
  // The page writes the year it is on to the address (?year=, usePlanningYear.choose, G6b) and jsdom keeps the address from one test to the
  // next: a test that chose next year would otherwise open the following one on it, and its "year the page no longer shows" would never arise.
  window.history.replaceState(window.history.state, "", "/");
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


const runButton = () => screen.getByRole("button", { name: /generate\.run/ });
const checkButton = () => screen.getByRole("button", { name: /weekCheck\.button|weekCheck\.checking/ });

/** The answer of POST week-check for a tight week: åk 7 at 94 %, and the rows a refused run carries. */
const TIGHT_CHECK = {
  verdict: "TIGHT",
  years: [
    { year: 7, demandMinutes: 2068, capacityMinutes: 2200, percent: 94, over: false },
    { year: 8, demandMinutes: 1980, capacityMinutes: 2200, percent: 90, over: false },
  ],
  conflicts: {
    summary: "",
    summaryCode: "",
    summaryParams: {},
    conflicts: [
      {
        category: "REQUIREMENT_DEMAND",
        code: "TIGHT_WEEK_LOAD",
        message: "Year 7 needs at least 2068 of the 2200 minutes the frames leave (94 %).",
        params: { grades: "7", demandMinutes: 2068, capacityMinutes: 2200, percent: 94 },
        resourceNames: [],
      },
    ],
  },
  skipped: ["LUNCH_STAGE"],
  elapsedMs: 310,
  checkedBy: "ENGINE",
};

const IMPOSSIBLE_CHECK = {
  verdict: "IMPOSSIBLE",
  years: [{ year: 9, demandMinutes: 2365, capacityMinutes: 2275, percent: 103, over: true }],
  conflicts: {
    summary: "Year 9 does not fit the week.",
    summaryCode: "DEMAND_YEAR_WEEK_SHORT",
    summaryParams: { grades: "9", demandMinutes: 2365, capacityMinutes: 2275, shared: "none" },
    conflicts: [
      {
        category: "REQUIREMENT_DEMAND",
        code: "DEMAND_REQUIREMENTS_EXCEED_WEEK",
        message: "Year 9 needs more than the week has.",
        params: { requirements: 89, demandMinutes: 2365, capacityMinutes: 2275 },
        resourceNames: [],
      },
    ],
  },
  skipped: ["LUNCH_STAGE"],
  elapsedMs: 200,
  checkedBy: "ENGINE",
};

describe("Kontrollera veckan: the button", () => {
  beforeEach(() => {
    // Every other prerequisite met.
    state.people.push({ ...pupil("t-1", "g-41"), role: "TEACHER", studentGroupId: null });
    state.policy = { unstaffedGeneration: "REFUSE" };
    noMutation.mutateAsync.mockReset();
  });

  it("asks the gateway about the year shown, starts nothing, and puts the answer under the prerequisites", async () => {
    apiPost.mockResolvedValueOnce(TIGHT_CHECK);
    render(<GeneratePage />);

    await userEvent.setup().click(checkButton());

    expect(apiPost).toHaveBeenCalledWith("/api/v1/optimization/week-check", { academicYearId: "y-1" }, expect.any(AbortSignal));
    expect(noMutation.mutateAsync).not.toHaveBeenCalled();
    const region = await screen.findByRole("region", { name: "weekCheck.title" });
    expect(within(region).getByText("weekCheck.verdict.TIGHT")).toBeInTheDocument();
    // "Åk 7 ligger på 94 % av ramtiden", and the row a refused run would show under it.
    expect(within(region).getByText("weekCheck.yearTight(7|94)")).toBeInTheDocument();
    expect(within(region).getByText("engineMessages.TIGHT_WEEK_LOAD(7|2068|2200|94)")).toBeInTheDocument();
    // Not a question: nothing was asked to run.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("weekCheck.ask.confirm")).toBeNull();
  });

  it("says what it did not run, so an OK is not read as a timetable that exists", async () => {
    render(<GeneratePage />);

    await userEvent.setup().click(checkButton());

    const region = await screen.findByRole("region", { name: "weekCheck.title" });
    expect(within(region).getByText("weekCheck.verdict.OK")).toBeInTheDocument();
    expect(within(region).getByText("weekCheck.okBody")).toBeInTheDocument();
    expect(within(region).getByText("weekCheck.skipped.LUNCH_STAGE")).toBeInTheDocument();
  });

  it("carries the area of the run, since its route has the same area", () => {
    render(<GeneratePage />);
    expect(checkButton()).toHaveAttribute("data-writes", "SCHEMALAGGNING DRIFT");
  });

  it("is open when a prerequisite is unmet: a post without a teacher is one of the things it says", () => {
    state.people = [];
    render(<GeneratePage />);

    expect(runButton()).toBeDisabled();
    expect(checkButton()).toBeEnabled();
  });

  it("is held while it asks, and the run beside it with it", async () => {
    let answer: (value: unknown) => void = () => undefined;
    apiPost.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    render(<GeneratePage />);

    await userEvent.setup().click(checkButton());

    await waitFor(() => expect(checkButton()).toBeDisabled());
    expect(checkButton()).toHaveTextContent("weekCheck.checking");
    expect(runButton()).toBeDisabled();
    expect(screen.getByRole("region", { name: "weekCheck.title" })).toHaveAttribute("aria-busy", "true");

    await act(async () => answer(OK_CHECK));
    await waitFor(() => expect(checkButton()).toBeEnabled());
    expect(runButton()).toBeEnabled();
  });

  it("says in words that an engine older than the API cannot check yet, and leaves the run open", async () => {
    apiPost.mockRejectedValueOnce(new ApiError(503, "Schemamotorn är äldre än API:t.", "ENGINE_LACKS_WEEK_CHECK"));
    render(<GeneratePage />);

    await userEvent.setup().click(checkButton());

    const region = await screen.findByRole("region", { name: "weekCheck.title" });
    expect(within(region).getByText("weekCheck.unavailableOlder")).toBeInTheDocument();
    expect(runButton()).toBeEnabled();
  });

  it("says a refusal of the payload in the sentence a run is refused with", async () => {
    apiPost.mockRejectedValueOnce(
      new ApiError(400, "Student group g-41 brings 30 students to lunch.", "LUNCH_HEADCOUNT_EXCEEDS_SEATS", { seats: 20 }),
    );
    render(<GeneratePage />);

    await userEvent.setup().click(checkButton());

    const region = await screen.findByRole("region", { name: "weekCheck.title" });
    expect(within(region).getByText("weekCheck.refusedTitle")).toBeInTheDocument();
    expect(within(region).getByText("engineMessages.LUNCH_HEADCOUNT_EXCEEDS_SEATS(20)")).toBeInTheDocument();
  });

  it("drops the answer of one year when the other is chosen", async () => {
    state.years = [ACTIVE, NEXT];
    apiPost.mockResolvedValueOnce(TIGHT_CHECK);
    render(<GeneratePage />);
    await userEvent.setup().click(checkButton());
    await screen.findByRole("region", { name: "weekCheck.title" });

    await userEvent.setup().click(screen.getByRole("button", { name: /planningYear\.optionNext/ }));

    await waitFor(() => expect(screen.queryByRole("region", { name: "weekCheck.title" })).toBeNull());
  });
});

describe("Kontrollera veckan: before a run", () => {
  beforeEach(() => {
    state.people.push({ ...pupil("t-1", "g-41"), role: "TEACHER", studentGroupId: null });
    state.policy = { unstaffedGeneration: "REFUSE" };
    noMutation.mutateAsync.mockReset();
    noMutation.mutateAsync.mockResolvedValue({ jobId: "job-1" });
  });

  it("starts the run at once when the check finds nothing, after the check and with the same year", async () => {
    render(<GeneratePage />);

    await userEvent.setup().click(runButton());

    await waitFor(() =>
      expect(noMutation.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ academicYearId: "y-1" })),
    );
    expect(apiPost).toHaveBeenCalledWith("/api/v1/optimization/week-check", { academicYearId: "y-1" }, expect.any(AbortSignal));
    expect(apiPost.mock.invocationCallOrder[0]).toBeLessThan(noMutation.mutateAsync.mock.invocationCallOrder[0]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks \"Åk 7 är 94 % full. Kör ändå?\" for a tight week, and starts nothing until the answer is yes", async () => {
    apiPost.mockResolvedValueOnce(TIGHT_CHECK);
    render(<GeneratePage />);

    await userEvent.setup().click(runButton());

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("weekCheck.ask.titleTight(7|94)")).toBeInTheDocument();
    expect(within(dialog).getByText("weekCheck.ask.bodyTight")).toBeInTheDocument();
    // Every year it found, and the answer behind the dialog carries the rows.
    expect(within(dialog).getByText("weekCheck.yearTight(8|90)")).toBeInTheDocument();
    expect(noMutation.mutateAsync).not.toHaveBeenCalled();

    await userEvent.setup().click(within(dialog).getByRole("button", { name: "weekCheck.ask.confirm" }));

    await waitFor(() =>
      expect(noMutation.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ academicYearId: "y-1" })),
    );
    expect(noMutation.mutateAsync).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("starts nothing when the answer is no, and leaves the answer to read", async () => {
    apiPost.mockResolvedValueOnce(TIGHT_CHECK);
    render(<GeneratePage />);
    await userEvent.setup().click(runButton());
    const dialog = await screen.findByRole("dialog");

    await userEvent.setup().click(within(dialog).getByRole("button", { name: "common.cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(noMutation.mutateAsync).not.toHaveBeenCalled();
    const region = screen.getByRole("region", { name: "weekCheck.title" });
    expect(within(region).getByText("weekCheck.verdict.TIGHT")).toBeInTheDocument();
    // And it can be asked again: nothing is left held.
    expect(runButton()).toBeEnabled();
  });

  it("asks about an impossible week too, and says Generera would refuse it in seconds", async () => {
    apiPost.mockResolvedValueOnce(IMPOSSIBLE_CHECK);
    render(<GeneratePage />);

    await userEvent.setup().click(runButton());

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("weekCheck.ask.titleImpossible")).toBeInTheDocument();
    expect(within(dialog).getByText("weekCheck.ask.bodyImpossible")).toBeInTheDocument();
    expect(within(dialog).getByText("weekCheck.yearOver(9|2365|2275)")).toBeInTheDocument();
    expect(noMutation.mutateAsync).not.toHaveBeenCalled();
  });

  it("asks about a week the payload's own refusal stops", async () => {
    apiPost.mockRejectedValueOnce(
      new ApiError(400, "Student group g-41 brings 30 students to lunch.", "LUNCH_HEADCOUNT_EXCEEDS_SEATS", { seats: 20 }),
    );
    render(<GeneratePage />);

    await userEvent.setup().click(runButton());

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("weekCheck.ask.titleRefused")).toBeInTheDocument();
    expect(noMutation.mutateAsync).not.toHaveBeenCalled();
  });

  it.each([
    ["an engine older than the API", new ApiError(503, "Schemamotorn är äldre än API:t.", "ENGINE_LACKS_WEEK_CHECK")],
    ["an API older than this page", new ApiError(404, "Cannot POST /api/v1/optimization/week-check")],
    ["a throttled check", new ApiError(429, "Too many requests.")],
    ["an engine that is down", new ApiError(503, "The AI engine could not be reached.")],
    ["a network that failed", new TypeError("Failed to fetch")],
  ])("never stops a run for a check that cannot answer: %s", async (_name, failure) => {
    apiPost.mockRejectedValueOnce(failure);
    render(<GeneratePage />);

    await userEvent.setup().click(runButton());

    await waitFor(() =>
      expect(noMutation.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ academicYearId: "y-1" })),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not run twice when the answer is yes and the button is pressed again", async () => {
    apiPost.mockResolvedValue(TIGHT_CHECK);
    render(<GeneratePage />);
    await userEvent.setup().click(runButton());
    const dialog = await screen.findByRole("dialog");
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "weekCheck.ask.confirm" }));
    await waitFor(() => expect(noMutation.mutateAsync).toHaveBeenCalledTimes(1));

    // Asking again checks again, and asks again: the earlier yes was for that run.
    await userEvent.setup().click(runButton());
    await screen.findByRole("dialog");
    expect(noMutation.mutateAsync).toHaveBeenCalledTimes(1);
  });
});

describe("Kontrollera veckan: a run is neither held nor misdirected by it", () => {
  beforeEach(() => {
    state.years = [ACTIVE, NEXT];
    state.people.push({ ...pupil("t-1", "g-41"), role: "TEACHER", studentGroupId: null });
    state.policy = { unstaffedGeneration: "REFUSE" };
    noMutation.mutateAsync.mockReset();
    noMutation.mutateAsync.mockResolvedValue({ jobId: "job-1" });
  });

  it.each([
    ["finds nothing", OK_CHECK],
    ["finds the week tight", TIGHT_CHECK],
  ])("starts no run, and asks no question, for a year the page no longer shows when the check %s", async (_name, answer) => {
    let reply: (value: unknown) => void = () => undefined;
    apiPost.mockReturnValueOnce(new Promise((resolve) => (reply = resolve)));
    render(<GeneratePage />);

    await userEvent.setup().click(runButton());
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    // The year picker is not held while the check is on its way: next year is chosen.
    await userEvent.setup().click(screen.getByRole("button", { name: /planningYear\.optionNext/ }));
    await act(async () => reply(answer));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // A run for y-1 would be written over a year the page has stopped showing.
    expect(noMutation.mutateAsync).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("goes on to run when the check has not answered within its wait", async () => {
    const wait = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(wait.signal);
    apiPost.mockImplementationOnce(
      (_path: string, _body: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(new DOMException("The operation timed out.", "TimeoutError"))),
        ),
    );
    render(<GeneratePage />);

    await userEvent.setup().click(runButton());
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    // Still waiting: the run is not started, and not asked about either.
    expect(noMutation.mutateAsync).not.toHaveBeenCalled();

    await act(async () => wait.abort());

    await waitFor(() =>
      expect(noMutation.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ academicYearId: "y-1" })),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    vi.restoreAllMocks();
  });
});
