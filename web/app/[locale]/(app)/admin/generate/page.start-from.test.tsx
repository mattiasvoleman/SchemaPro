import { cleanup, render as renderPlain, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import GeneratePage from "./page";

/*
 * UTGÅ FRÅN ETT SCHEMA, as the page draws it (omgång 15, M9): the choice of where a run starts, what the request carries of it, and the
 * sentence about what a finished run did with it. The card and the sentence are one lazy chunk (start-from.tsx), so every test finds
 * them with `findBy`.
 */

function render(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderPlain(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const state = vi.hoisted(() => ({
  job: undefined as unknown,
  years: [] as unknown[],
  /** GET /schedule-versions?academicYearId= as useScheduleVersions answers. */
  versions: [] as unknown[] | undefined,
  versionsFor: [] as (string | null)[],
}));

const ACTIVE = { id: "y-1", name: "2026/27", isActive: true, predecessorId: null, startDate: "2026-08-17", endDate: "2027-06-11" };
const NEXT = { id: "y-2", name: "2027/28", isActive: false, predecessorId: "y-1", startDate: "2027-08-16", endDate: "2028-06-09" };

const apiGet = vi.hoisted(() => vi.fn());
const apiPost = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { get: apiGet, post: apiPost },
}));

const OK_CHECK = { verdict: "OK", years: [], conflicts: null, skipped: ["LUNCH_STAGE"], elapsedMs: 40, checkedBy: "ENGINE" };
const startMutation = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
const noMutation = { mutateAsync: vi.fn(), isPending: false };

vi.mock("@/lib/requirement-shares", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/requirement-shares")>()),
  useRequirementShares: () => ({ data: [] }),
}));

vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({ data: state.years, isLoading: false, isError: false }),
  useRequirements: () => ({
    data: [{ id: "req-1", subjectId: "s-1", studentGroupId: "g-41", teacherId: "t-1", lessonsPerWeek: 2, minutesPerLesson: 60 }],
    isError: false,
  }),
  useRooms: () => ({ data: [{ id: "r-1" }] }),
  usePeople: () => ({ data: [{ id: "t-1", role: "TEACHER", isActive: true, firstName: "A", lastName: "B", studentGroupId: null }] }),
  useGroups: () => ({ data: [{ id: "g-41", academicYearId: "y-1", name: "4.1", kind: "CLASS", gradeLevel: 4 }] }),
  useGroupMemberships: () => ({ data: [] }),
  useStartOptimization: () => startMutation,
  useOptimizationJob: () => ({ data: state.job }),
  useOptimizationHistory: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
  useLunchSettings: () => ({ data: null }),
  useScheduleVersions: (yearId: string | null) => {
    state.versionsFor.push(yearId);
    return { data: state.versions, isSuccess: state.versions !== undefined };
  },
}));

vi.mock("@/lib/placement-board-queries", () => ({ usePlacementBoard: () => ({ data: undefined }) }));
vi.mock("@/lib/staffing-queries", () => ({
  useStaffingPolicy: () => ({ data: undefined }),
  useTeacherDuties: () => ({ data: [] }),
}));
vi.mock("./use-schedule-candidates", () => ({
  useScheduleCandidates: () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
  useStartCandidates: () => noMutation,
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

const runButton = () => screen.getByRole("button", { name: /generate\.run/ });
const choice = (label: string) => screen.findByRole("radio", { name: new RegExp(label.replace(".", "\\.")) });

beforeEach(() => {
  cleanup();
  apiGet.mockReset();
  apiPost.mockReset();
  apiPost.mockResolvedValue(OK_CHECK);
  startMutation.mutateAsync.mockReset();
  startMutation.mutateAsync.mockResolvedValue({ jobId: "job-n" });
  vi.mocked(toast.error).mockReset();
  state.years = [ACTIVE];
  state.job = undefined;
  state.versions = [];
  state.versionsFor = [];
});
afterEach(() => window.history.replaceState(null, "", "/"));

describe("the choice of where a run starts", () => {
  it("is drawn with the four answers, and from nothing is the one chosen: a run that sends nothing of a start is the run it always was", async () => {
    render(<GeneratePage />);

    const none = await choice("generate.startNone");
    expect(none).toBeChecked();
    for (const label of ["generate.startCurrent", "generate.startPrevious", "generate.startVersion"]) {
      expect(await choice(label)).not.toBeChecked();
    }
    // What each answer means is said beside it, before it is made.
    expect(screen.getByText("generate.startHint")).toBeInTheDocument();
    expect(screen.getByText("generate.startNoneBody")).toBeInTheDocument();
    expect(screen.getByText("generate.startCurrentBody")).toBeInTheDocument();

    await userEvent.setup().click(runButton());
    await waitFor(() => expect(startMutation.mutateAsync).toHaveBeenCalled());
    expect(startMutation.mutateAsync.mock.calls[0]![0]).not.toHaveProperty("startFrom");
  });

  it("sends the grundschema as the start when it is chosen", async () => {
    render(<GeneratePage />);
    const user = userEvent.setup();

    await user.click(await choice("generate.startCurrent"));
    await user.click(runButton());

    await waitFor(() =>
      expect(startMutation.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ academicYearId: "y-1", startFrom: { source: "CURRENT" } })),
    );
  });

  it("offers last year's schedule only for a year that was rolled from another, and says why when it is not", async () => {
    render(<GeneratePage />);

    const previous = await choice("generate.startPrevious");
    expect(previous).toBeDisabled();
    expect(screen.getByText("generate.startPreviousNone")).toBeInTheDocument();
  });

  it("is a link away from the rollover: ?start=PREVIOUS_YEAR on a rolled year chooses last year's schedule, and the run carries it", async () => {
    state.years = [ACTIVE, NEXT];
    window.history.replaceState(null, "", "/?year=y-2&start=PREVIOUS_YEAR");
    render(<GeneratePage />);

    expect(await choice("generate.startPrevious")).toBeChecked();
    await userEvent.setup().click(runButton());

    await waitFor(() =>
      expect(startMutation.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ academicYearId: "y-2", startFrom: { source: "PREVIOUS_YEAR" } }),
      ),
    );
  });

  it("does not take the link for a year that was not rolled from another: nothing is chosen, and nothing is sent", async () => {
    window.history.replaceState(null, "", "/?start=PREVIOUS_YEAR");
    render(<GeneratePage />);

    expect(await choice("generate.startNone")).toBeChecked();
    await userEvent.setup().click(runButton());
    await waitFor(() => expect(startMutation.mutateAsync).toHaveBeenCalled());
    expect(startMutation.mutateAsync.mock.calls[0]![0]).not.toHaveProperty("startFrom");
  });

  describe("a saved version", () => {
    const VERSIONS = [
      { id: "v-new", academicYearId: "y-1", name: "Före ändringen", lessonCount: 180, createdAt: "2026-11-24T10:00:00.000Z" },
      { id: "v-old", academicYearId: "y-1", name: "Första utkastet", lessonCount: 150, createdAt: "2026-11-01T10:00:00.000Z" },
    ];

    it("is read for the year the run is for, and is offered with the newest version chosen", async () => {
      state.versions = VERSIONS;
      render(<GeneratePage />);
      const user = userEvent.setup();

      await user.click(await choice("generate.startVersion"));
      const select = await screen.findByRole("combobox", { name: "generate.startVersionPick" });
      expect(select).toHaveValue("v-new");
      expect(within(select).getAllByRole("option")).toHaveLength(2);
      expect(state.versionsFor).toContain("y-1");

      await user.click(runButton());
      await waitFor(() =>
        expect(startMutation.mutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({ startFrom: { source: "VERSION", versionId: "v-new" } }),
        ),
      );
    });

    it("sends the version the school picked", async () => {
      state.versions = VERSIONS;
      render(<GeneratePage />);
      const user = userEvent.setup();

      await user.click(await choice("generate.startVersion"));
      await user.selectOptions(await screen.findByRole("combobox", { name: "generate.startVersionPick" }), "v-old");
      await user.click(runButton());

      await waitFor(() =>
        expect(startMutation.mutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({ startFrom: { source: "VERSION", versionId: "v-old" } }),
        ),
      );
    });

    it("is not on offer for a year with none, and says so", async () => {
      state.versions = [];
      render(<GeneratePage />);

      expect(await choice("generate.startVersion")).toBeDisabled();
      expect(screen.getByText("generate.startVersionNone")).toBeInTheDocument();
    });
  });

  it("is chosen for one year: choosing another year starts that one from nothing", async () => {
    state.years = [ACTIVE, NEXT];
    render(<GeneratePage />);
    const user = userEvent.setup();

    await user.click(await choice("generate.startCurrent"));
    expect(await choice("generate.startCurrent")).toBeChecked();
    await user.click(await screen.findByRole("button", { name: "planningYear.optionNext(2027/28)" }));

    expect(await choice("generate.startNone")).toBeChecked();
  });
});

describe("a start that cannot be one", () => {
  it.each(["START_NO_PREVIOUS_YEAR", "START_VERSION_NOT_FOUND"])("is said by its own sentence, not by the gateway's English (%s)", async (code) => {
    startMutation.mutateAsync.mockRejectedValueOnce(new ApiError(409, "English for a log.", code));
    render(<GeneratePage />);
    const user = userEvent.setup();

    await user.click(await choice("generate.startCurrent"));
    await user.click(runButton());

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(`scheduleCandidates.jobErrors.${code}`));
  });

  it("says a failed run's refusal by what the gateway counted: nothing yet, or lessons that match no post", async () => {
    state.job = {
      id: "job-9", status: "FAILED", solverStatus: null, error: "English.", errorCode: "START_NOTHING_TO_START_FROM",
      errorParams: { source: "CURRENT", offered: 0 }, conflicts: [], createdAt: "2026-11-25T08:00:00.000Z", finishedAt: "2026-11-25T08:00:02.000Z",
    };
    render(<GeneratePage />);

    expect(screen.getByText("scheduleCandidates.jobErrors.START_NOTHING_EMPTY")).toBeInTheDocument();
  });
});

describe("what a finished run says of its start", () => {
  const finished = (startedFrom: unknown, over: Record<string, unknown> = {}) => ({
    id: "job-7", status: "SUCCEEDED", solverStatus: "OPTIMAL", lessonsGenerated: 180, error: null, errorCode: null, errorParams: null,
    conflictSummary: null, conflictSummaryCode: null, conflictSummaryParams: null, conflicts: [], notes: [],
    createdAt: "2026-11-25T08:00:00.000Z", finishedAt: "2026-11-25T08:00:09.000Z", report: null, suggestions: null, suggestionsOffered: false,
    startedFrom, ...over,
  });

  it("says how many lessons stayed, moved and were laid, and what it started from", async () => {
    state.job = finished({
      source: "CURRENT", versionName: null, engine: "USED", offered: 180, used: 180, held: 171, moved: 9, laid: 0, dropped: {},
    });
    render(<GeneratePage />);

    const note = await screen.findByTestId("generate-started-from");
    expect(note).toHaveTextContent("generate.startNoteTitle(generate.startNoteSource.CURRENT)");
    expect(note).toHaveTextContent("generate.startNoteCounts(180|171|9|0)");
    expect(note).not.toHaveTextContent("startNoteDropped");
  });

  it("names the saved version, and says what could not be used of the schedule and why", async () => {
    state.job = finished({
      source: "VERSION", versionName: "Före ändringen", engine: "USED", offered: 70, used: 60, held: 50, moved: 5, laid: 5,
      dropped: { NO_SUCCESSOR: 8, MORE_THAN_ASKED: 2 },
    });
    render(<GeneratePage />);

    const note = await screen.findByTestId("generate-started-from");
    expect(note).toHaveTextContent("generate.startNoteTitle(generate.startNoteSourceNamed(Före ändringen))");
    expect(note).toHaveTextContent(
      "generate.startNoteDropped(10|generate.startDrop.NO_SUCCESSOR(8); generate.startDrop.MORE_THAN_ASKED(2))",
    );
  });

  it("says that the engine was older and the week was laid from nothing, with no count of what was held", async () => {
    state.job = finished({
      source: "PREVIOUS_YEAR", versionName: null, engine: "OLDER", offered: 0, used: 0, held: null, moved: null, laid: null, dropped: {},
    });
    render(<GeneratePage />);

    const note = await screen.findByTestId("generate-started-from");
    expect(note).toHaveTextContent("generate.startNoteOlder");
    expect(note).not.toHaveTextContent("startNoteCounts");
  });

  it("does not claim a count for a week the engine laid no timetable for", async () => {
    state.job = finished(
      { source: "CURRENT", versionName: null, engine: "USED", offered: 180, used: 180, held: null, moved: null, laid: null, dropped: {} },
      { solverStatus: "INFEASIBLE", lessonsGenerated: 0 },
    );
    render(<GeneratePage />);

    const note = await screen.findByTestId("generate-started-from");
    expect(note).toHaveTextContent("generate.startNoteNoTimetable(180)");
  });

  it("says nothing for a run that started from nothing, and for a gateway that has no such field", async () => {
    state.job = finished(null);
    render(<GeneratePage />);
    await screen.findByRole("radio", { name: /generate\.startNone/ });
    expect(screen.queryByTestId("generate-started-from")).toBeNull();

    cleanup();
    state.job = finished(undefined);
    render(<GeneratePage />);
    await screen.findByRole("radio", { name: /generate\.startNone/ });
    expect(screen.queryByTestId("generate-started-from")).toBeNull();
  });
});
