import { act, cleanup, render as renderPlain, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * D9 of Åtgärdsförslag vid vägran, WITH THE REAL HOOKS (granskning av #393). page.timeout-chunk.test.tsx mocks the history, the run and the
 * start, so what it can say is what the page asks the mock for at the first read. Here the page reads through react-query, over a fake
 * gateway whose answers change as a real one's do: the history is read AGAIN, with another run on top of it, and the page is asked who
 * the last run is then. The run a reload leaves behind is the year's newest run, and stops being shown when it stops being that.
 */

// The card is a lazy module and the page reads through react-query: under load (a suite beside others) one second is too short a wait.
vi.setConfig({ testTimeout: 20_000 });
const SLOW = { timeout: 10_000 };

const gw = vi.hoisted(() => ({
  history: {} as Record<string, Record<string, unknown>[]>,
  jobs: {} as Record<string, Record<string, unknown>>,
  calls: [] as string[],
  started: [] as string[],
}));

const state = vi.hoisted(() => ({
  years: [] as unknown[],
  requirements: [] as unknown[],
  people: [] as unknown[],
  groups: [] as unknown[],
  memberships: [] as unknown[],
}));

const Y1 = "00000000-0000-4000-8000-0000000000a1";
const Y2 = "00000000-0000-4000-8000-0000000000a2";
const ACTIVE = { id: Y1, name: "2026/27", isActive: true, predecessorId: null, startDate: "2026-08-17", endDate: "2027-06-11" };
const NEXT = { id: Y2, name: "2027/28", isActive: false, predecessorId: Y1, startDate: "2027-08-16", endDate: "2028-06-09" };

const apiGet = vi.hoisted(() => vi.fn());
const apiPost = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { get: apiGet, post: apiPost },
}));

vi.mock("@/lib/requirement-shares", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/requirement-shares")>()),
  useRequirementShares: () => ({ data: [] }),
}));

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    useAcademicYears: () => ({ data: state.years, isLoading: false, isError: false }),
    useRequirements: () => ({ data: state.requirements, isError: false }),
    useRooms: () => ({ data: [{ id: "r-1" }] }),
    usePeople: () => ({ data: state.people }),
    useGroups: () => ({ data: state.groups }),
    useGroupMemberships: () => ({ data: state.memberships }),
    useStartOptimization: actual.useStartOptimization,
    useOptimizationJob: actual.useOptimizationJob,
    useOptimizationHistory: actual.useOptimizationHistory,
    useLunchSettings: () => ({ data: null }),
  };
});

vi.mock("@/lib/placement-board-queries", () => ({ usePlacementBoard: () => ({ data: undefined }) }));
vi.mock("@/lib/staffing-queries", () => ({
  useStaffingPolicy: () => ({ data: undefined }),
  useTeacherDuties: () => ({ data: [] }),
}));
// Optimeringsprofilen reads the school's profile through react-query and the profile context, which these tests do not provide: it is held on
// its own (use-optimization-profile.test.tsx), and here the sliders start at the defaults.
vi.mock("./use-optimization-profile", () => ({
  useOptimizationProfile: () => ({ weights: { preferredFree: 10, preferredBusy: 5, disruption: 8, spread: 3, teacherGap: 2 }, setWeight: () => undefined, canSave: true, status: "idle" }),
}));
vi.mock("./use-schedule-candidates", () => ({
  useScheduleCandidates: () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
  useStartCandidates: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${namespace}.${key}(${Object.values(values).join("|")})` : `${namespace}.${key}`;
    return Object.assign(t, { has: () => true });
  },
}));

const OK_CHECK = { verdict: "OK", years: [], conflicts: null, skipped: ["LUNCH_STAGE"], elapsedMs: 40, checkedBy: "ENGINE" };

const run = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  status: "SUCCEEDED",
  solverStatus: "INFEASIBLE",
  lessonsGenerated: 0,
  conflictSummary: null,
  conflictSummaryCode: null,
  conflicts: [{ category: "TEACHER_OVERLAP", message: `Overlap in ${id}.`, resourceNames: [] }],
  suggestionsOffered: true,
  suggestions: null,
  createdAt: "2026-11-21T08:00:00.000Z",
  finishedAt: "2026-11-21T08:03:10.000Z",
  ...over,
});
const laid = (id: string) => run(id, { solverStatus: "OPTIMAL", lessonsGenerated: 118, conflicts: [], suggestionsOffered: false });

let client: QueryClient;
function render(ui: React.ReactElement) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } } });
  return renderPlain(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  cleanup();
  window.history.pushState({}, "", "/");
  gw.history = {};
  gw.jobs = {};
  gw.calls = [];
  gw.started = [];
  state.years = [ACTIVE];
  state.groups = [
    { id: "g-41", academicYearId: Y1, name: "4.1", kind: "CLASS", gradeLevel: 4 },
    { id: "g-ma1", academicYearId: Y1, name: "4ma1", kind: "TEACHING_GROUP", gradeLevel: null },
  ];
  state.people = [
    { id: "p-1", role: "STUDENT", isActive: true, firstName: "E", lastName: "Lev", email: "p1@x", phone: null, invitedAt: null, studentGroupId: "g-41" },
    { id: "t-1", role: "TEACHER", isActive: true, firstName: "T", lastName: "Lärare", email: "t1@x", phone: null, invitedAt: null, studentGroupId: null },
  ];
  state.memberships = [{ studentId: "p-1", studentGroupId: "g-ma1" }];
  state.requirements = [{ id: "req-g-ma1", subjectId: "s-1", studentGroupId: "g-ma1", teacherId: "t-1", lessonsPerWeek: 2, minutesPerLesson: 60 }];
  apiGet.mockReset();
  apiPost.mockReset();
  apiGet.mockImplementation(async (url: string) => {
    gw.calls.push(`GET ${url}`);
    const history = url.match(/^\/api\/v1\/optimization\/jobs\?academicYearId=(.+)$/);
    if (history) return structuredClone(gw.history[history[1]!] ?? []);
    const one = url.match(/^\/api\/v1\/optimization\/jobs\/([^/?]+)$/);
    if (one) {
      const found = gw.jobs[one[1]!];
      if (!found) throw new Error(`no job ${one[1]}`);
      return structuredClone(found);
    }
    return {
      academicYearId: Y2,
      basis: "PROJECTED",
      homeClasses: [],
      counts: { moved: 0, graduates: 0, unplaced: 0 },
      membershipsOutOfDate: { missing: 0, stale: 0 },
    };
  });
  apiPost.mockImplementation(async (url: string, body: { academicYearId?: string }) => {
    gw.calls.push(`POST ${url}`);
    if (url.endsWith("/week-check")) return OK_CHECK;
    if (url === "/api/v1/optimization/jobs") {
      const id = `job-new-${gw.started.length + 1}`;
      gw.started.push(id);
      // The run ends at once, refused: the page reads it by id as soon as it has the id, and the history lists it on top.
      const fresh = run(id);
      gw.jobs[id] = fresh;
      gw.history[body.academicYearId!] = [fresh, ...(gw.history[body.academicYearId!] ?? [])];
      return { jobId: id };
    }
    throw new Error(`unexpected POST ${url}`);
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
const lastRun = () => document.getElementById("last-run");

async function loadPage() {
  vi.resetModules();
  const Page = (await import("./page")).default;
  return Page;
}

describe("the run a reload leaves behind, read through the real hooks", () => {
  it("shows the year's newest refusal: it is read by its id and the card of what to change is there", async () => {
    gw.history[Y1] = [run("job-1")];
    gw.jobs["job-1"] = run("job-1");
    const Page = await loadPage();
    render(<Page />);
    expect(await screen.findByRole("button", { name: "generate.suggestions.offerAction" }, SLOW)).toBeInTheDocument();
    expect(gw.calls).toContain("GET /api/v1/optimization/jobs/job-1");
  });

  it("stops showing it when the history is read again and a run that laid a timetable is on top of it", async () => {
    gw.history[Y1] = [run("job-1")];
    gw.jobs["job-1"] = run("job-1");
    const Page = await loadPage();
    render(<Page />);
    expect(await screen.findByRole("button", { name: "generate.suggestions.offerAction" }, SLOW)).toBeInTheDocument();

    // Another administrator's Generera laid a timetable; the history is read again, as its poll and the end of a run of the page's own do.
    gw.history[Y1] = [laid("job-2"), run("job-1")];
    gw.jobs["job-2"] = laid("job-2");
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["optimizationHistory"] });
    });
    await settle();
    expect(screen.queryByRole("button", { name: "generate.suggestions.offerAction" })).toBeNull();
    expect(screen.queryByText("Overlap in job-1.")).toBeNull();
    expect(lastRun()).toBeNull();
  });

  it("shows the newer refusal instead when that is what is on top after the history has been read again", async () => {
    gw.history[Y1] = [run("job-1")];
    gw.jobs["job-1"] = run("job-1");
    const Page = await loadPage();
    render(<Page />);
    expect(await screen.findByText("Overlap in job-1.", undefined, SLOW)).toBeInTheDocument();

    gw.history[Y1] = [run("job-2"), run("job-1")];
    gw.jobs["job-2"] = run("job-2");
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["optimizationHistory"] });
    });
    expect(await screen.findByText("Overlap in job-2.", undefined, SLOW)).toBeInTheDocument();
    expect(screen.queryByText("Overlap in job-1.")).toBeNull();
  });

  it("keeps the run the page started, over a refusal that turns up on top of it in the history", async () => {
    gw.history[Y1] = [run("job-1")];
    gw.jobs["job-1"] = run("job-1");
    const Page = await loadPage();
    render(<Page />);
    expect(await screen.findByText("Overlap in job-1.", undefined, SLOW)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "generate.run" }, SLOW));
    await waitFor(() => expect(gw.started).toEqual(["job-new-1"]), SLOW);
    expect(await screen.findByText("Overlap in job-new-1.", undefined, SLOW)).toBeInTheDocument();
    expect(screen.queryByText("Overlap in job-1.")).toBeNull();

    gw.history[Y1] = [run("job-x"), ...gw.history[Y1]!];
    gw.jobs["job-x"] = run("job-x");
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["optimizationHistory"] });
    });
    await settle();
    expect(screen.getByText("Overlap in job-new-1.")).toBeInTheDocument();
    expect(screen.queryByText("Overlap in job-x.")).toBeNull();
  });

  it("shows a run that was on its way when the page opened once the history says it ended refused, and not before", async () => {
    // A reload in the middle of a run of the page's own: the newest is PENDING, which the gateway offers nothing for. Its end is read from
    // the history (the page reads it every few seconds while a run it did not start is going).
    const going = run("job-2", { status: "RUNNING", solverStatus: null, suggestionsOffered: false, conflicts: [] });
    gw.history[Y1] = [going];
    gw.jobs["job-2"] = going;
    const Page = await loadPage();
    render(<Page />);
    await settle();
    expect(screen.queryByRole("button", { name: "generate.suggestions.offerAction" })).toBeNull();
    expect(lastRun()).toBeNull();

    gw.history[Y1] = [run("job-2")];
    gw.jobs["job-2"] = run("job-2");
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["optimizationHistory"] });
    });
    expect(await screen.findByRole("button", { name: "generate.suggestions.offerAction" }, SLOW)).toBeInTheDocument();
    expect(screen.getByText("Overlap in job-2.")).toBeInTheDocument();
  });

  it("is the läsår's own: choosing the other läsår shows its newest, and the first again shows the first's", async () => {
    state.years = [ACTIVE, NEXT];
    gw.history[Y1] = [run("job-1")];
    gw.jobs["job-1"] = run("job-1");
    gw.history[Y2] = [run("job-2")];
    gw.jobs["job-2"] = run("job-2");
    const Page = await loadPage();
    render(<Page />);
    expect(await screen.findByText("Overlap in job-1.", undefined, SLOW)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "planningYear.optionNext(2027/28)" }));
    expect(await screen.findByText("Overlap in job-2.", undefined, SLOW)).toBeInTheDocument();
    expect(screen.queryByText("Overlap in job-1.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "planningYear.optionActive(2026/27)" }));
    expect(await screen.findByText("Overlap in job-1.", undefined, SLOW)).toBeInTheDocument();
    expect(screen.queryByText("Overlap in job-2.")).toBeNull();
  });

  it("does not keep the läsår that was chosen: a reload shows the active läsår's run, and the run of the other one waits for the choice", async () => {
    // The choice is the page's own state (lib/planning-year.ts: `chosenId`), and `?year=` is read only when the page opens. A reader who made a
    // run for next year, left, and came back is on the active year: the run is saved, and the card is there once next year is chosen again.
    state.years = [ACTIVE, NEXT];
    gw.history[Y1] = [];
    gw.history[Y2] = [run("job-2")];
    gw.jobs["job-2"] = run("job-2");
    const Page = await loadPage();
    render(<Page />);
    await settle();
    expect(screen.getByRole("button", { name: "planningYear.optionActive(2026/27)" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("Overlap in job-2.")).toBeNull();
    expect(lastRun()).toBeNull();

    await userEvent.setup().click(screen.getByRole("button", { name: "planningYear.optionNext(2027/28)" }));
    expect(await screen.findByText("Overlap in job-2.", undefined, SLOW)).toBeInTheDocument();
  });
});
