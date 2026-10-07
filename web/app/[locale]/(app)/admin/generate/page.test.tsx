import { cleanup, render as renderPlain, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  requirements: [] as unknown[],
  groups: [] as unknown[],
  memberships: [] as unknown[],
  people: [] as unknown[],
  /** StaffingPolicy as GET /staffing-policy answers; undefined = not answered yet. */
  policy: undefined as unknown,
  years: [] as unknown[],
  /** The year each year-keyed read was asked for, in order. */
  requirementsFor: [] as (string | null)[],
  historyFor: [] as (string | null)[],
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

vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({ data: state.years }),
  useRequirements: (yearId: string | null) => {
    state.requirementsFor.push(yearId);
    return { data: state.requirements };
  },
  useRooms: () => ({ data: [{ id: "r-1" }] }),
  usePeople: () => ({ data: state.people }),
  useGroups: () => ({ data: state.groups }),
  useGroupMemberships: () => ({ data: state.memberships }),
  useStartOptimization: () => noMutation,
  useOptimizationJob: () => ({ data: state.job }),
  useOptimizationHistory: (yearId: string | null) => {
    state.historyFor.push(yearId);
    return { data: [] };
  },
  useLunchSettings: () => ({ data: null }),
}));

vi.mock("@/lib/staffing-queries", () => ({
  useStaffingPolicy: () => ({ data: state.policy }),
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
  state.years = [ACTIVE];
  state.requirementsFor = [];
  state.historyFor = [];
  state.job = undefined;
  state.policy = undefined;
  state.untranslated = [];
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
      "/admin/staffing#unstaffed",
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
    expect(within(reason!).getByRole("link")).toHaveAttribute("href", "/admin/staffing#unstaffed");
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
      "/admin/staffing#unstaffed",
    );
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
