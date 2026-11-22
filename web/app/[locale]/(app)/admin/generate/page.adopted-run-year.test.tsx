import { cleanup, render as renderPlain, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * D9 AND THE LÄSÅR OF THE LINKS (granskning av #393, on top of #388's d3577041: "en postlänk bär läsåret"). A run the page shows after a reload
 * is the newest run of the läsår the page shows, which is not the active one when next year is being planned: its links to the requirements
 * page carry that läsår (`&year=`), or they open the active läsår, where a post of next year is not. Through the real hooks, so that the
 * run is the one the history names and the page reads by its id.
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

const DONE = (changes: unknown[]) => ({
  version: 1,
  state: "DONE",
  startedAt: "2026-11-21T08:04:00.000Z",
  finishedAt: "2026-11-21T08:05:30.000Z",
  verdict: "CHANGES",
  verified: true,
  total: changes.length,
  searchSeconds: 60,
  verifySeconds: 2,
  changes,
  failure: null,
});
const change = (over: Record<string, unknown>) => ({
  rule: "SUBJECT_PER_DAY",
  proof: "SOLVED",
  cost: 20,
  current: 1,
  needed: 2,
  weekdays: [2],
  requirementIds: ["11111111-1111-4111-8111-111111111111"],
  requirementNames: ["Idrott 8A"],
  roomIds: [],
  roomNames: [],
  resourceIds: [],
  teacherNames: [],
  hidden: false,
  ...over,
});


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

async function loadPage() {
  vi.resetModules();
  const Page = (await import("./page")).default;
  return Page;
}

describe("the card of a run the page showed again after a reload, for a läsår that is not the active one", () => {
  it("links to the post with the läsår of the run: ?year= is the page's own läsår", async () => {
    window.history.pushState({}, "", `/?year=${Y2}`);
    state.years = [ACTIVE, NEXT];
    const answered = run("job-9", { suggestions: DONE([change({})]) });
    gw.history[Y1] = [];
    gw.history[Y2] = [answered];
    gw.jobs["job-9"] = answered;
    const Page = await loadPage();
    render(<Page />);
    const link = await screen.findByRole("link", { name: /generate\.suggestions\.link/ }, SLOW);
    expect(link.getAttribute("href")).toBe(`/admin/requirements?post=11111111-1111-4111-8111-111111111111&year=${Y2}`);
  });

  it("carries no läsår for the active one: the requirements page shows it without", async () => {
    const answered = run("job-9", { suggestions: DONE([change({})]) });
    gw.history[Y1] = [answered];
    gw.jobs["job-9"] = answered;
    const Page = await loadPage();
    render(<Page />);
    const link = await screen.findByRole("link", { name: /generate\.suggestions\.link/ }, SLOW);
    expect(link.getAttribute("href")).toBe("/admin/requirements?post=11111111-1111-4111-8111-111111111111");
  });
});
