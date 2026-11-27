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

  it("stands before the button that runs it, so that the choice is read before the click that makes it", async () => {
    render(<GeneratePage />);

    await choice("generate.startNone");
    const card = document.getElementById("start-from")!;
    expect(runButton().compareDocumentPosition(card) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
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

  it("is shown and not changed while a run is going: the choice a run was started with is the one on the screen", async () => {
    state.job = {
      id: "job-r", status: "RUNNING", solverStatus: null, error: null, errorCode: null, errorParams: null, conflicts: [],
      createdAt: new Date().toISOString(), finishedAt: null,
    };
    render(<GeneratePage />);

    for (const label of ["generate.startNone", "generate.startCurrent", "generate.startPrevious", "generate.startVersion"]) {
      expect(await choice(label)).toBeDisabled();
    }
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

  it("takes the link only for the year it names: a year the page cannot show leaves the shown year (rolled itself) with nothing chosen", async () => {
    // The rollover that made y-3 started from y-2, which is not the active year: the page offers y-1 and y-2 only, and shows y-1.
    const ROLLED = { ...ACTIVE, predecessorId: "y-0" };
    const FAR = { id: "y-3", name: "2028/29", isActive: false, predecessorId: "y-2", startDate: "2028-08-14", endDate: "2029-06-08" };
    state.years = [ROLLED, NEXT, FAR];
    window.history.replaceState(null, "", "/?year=y-3&start=PREVIOUS_YEAR");
    render(<GeneratePage />);

    expect(await choice("generate.startNone")).toBeChecked();
    expect(await choice("generate.startPrevious")).not.toBeChecked();
    await userEvent.setup().click(runButton());
    await waitFor(() => expect(startMutation.mutateAsync).toHaveBeenCalled());
    expect(startMutation.mutateAsync.mock.calls[0]![0]).toMatchObject({ academicYearId: "y-1" });
    expect(startMutation.mutateAsync.mock.calls[0]![0]).not.toHaveProperty("startFrom");
  });

  it("takes the link when the year it names arrives after the card was first drawn for another (the years were read before the rollover)", async () => {
    // First drawn for y-1, which was not rolled from another; the list of years is read again and y-2 appears: the link is for y-2.
    state.years = [ACTIVE];
    window.history.replaceState(null, "", "/?year=y-2&start=PREVIOUS_YEAR");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = () => (
      <QueryClientProvider client={client}>
        <GeneratePage />
      </QueryClientProvider>
    );
    const view = renderPlain(page());
    expect(await choice("generate.startNone")).toBeChecked();

    state.years = [ACTIVE, NEXT];
    view.rerender(page());

    await waitFor(async () => expect(await choice("generate.startPrevious")).toBeChecked());
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

    it("sends the version the select shows when the choice was made before the list arrived, and when the chosen one is gone from it", async () => {
      // The radio is on offer while the versions are being read; the pick is then the newest of them, as the select shows, and not nothing.
      state.versions = undefined;
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const page = () => (
        <QueryClientProvider client={client}>
          <GeneratePage />
        </QueryClientProvider>
      );
      const view = renderPlain(page());
      const user = userEvent.setup();
      await user.click(await choice("generate.startVersion"));

      state.versions = VERSIONS;
      view.rerender(page());
      expect(await screen.findByRole("combobox", { name: "generate.startVersionPick" })).toHaveValue("v-new");
      await user.click(runButton());
      await waitFor(() =>
        expect(startMutation.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ startFrom: { source: "VERSION", versionId: "v-new" } })),
      );

      // And a version that was chosen and has gone from the list (deleted in another tab) is not sent: the select's first one is.
      startMutation.mutateAsync.mockClear();
      await user.selectOptions(screen.getByRole("combobox", { name: "generate.startVersionPick" }), "v-old");
      state.versions = [VERSIONS[0]!];
      view.rerender(page());
      await waitFor(() => expect(screen.getByRole("combobox", { name: "generate.startVersionPick" })).toHaveValue("v-new"));
      await user.click(runButton());
      await waitFor(() =>
        expect(startMutation.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ startFrom: { source: "VERSION", versionId: "v-new" } })),
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

  it("counts the lessons of the answer as the total, the laid ones with the held and the moved", async () => {
    state.job = finished({
      source: "PREVIOUS_YEAR", versionName: null, engine: "USED", offered: 150, used: 140, held: 100, moved: 20, laid: 15, dropped: {},
    });
    render(<GeneratePage />);

    expect(await screen.findByTestId("generate-started-from")).toHaveTextContent("generate.startNoteCounts(135|100|20|15)");
  });

  it("says every reason a lesson was left out, in the order that is worth reading, and counts all of them", async () => {
    state.job = finished({
      source: "PREVIOUS_YEAR", versionName: null, engine: "USED", offered: 90, used: 62, held: 50, moved: 6, laid: 6,
      dropped: { MORE_THAN_ASKED: 7, NOT_STARTABLE: 6, AMBIGUOUS: 5, OTHER_WEEKS: 4, NOT_IN_WEEK: 3, NO_POST: 2, NO_SUCCESSOR: 1 },
    });
    render(<GeneratePage />);

    const reasons = ["NO_SUCCESSOR(1)", "NO_POST(2)", "NOT_IN_WEEK(3)", "OTHER_WEEKS(4)", "AMBIGUOUS(5)", "NOT_STARTABLE(6)", "MORE_THAN_ASKED(7)"];
    expect(await screen.findByTestId("generate-started-from")).toHaveTextContent(
      `generate.startNoteDropped(28|${reasons.map((reason) => `generate.startDrop.${reason}`).join("; ")})`,
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
    // The first line must not say that the week started from the schedule when the engine could not: it says what was asked for.
    expect(note).not.toHaveTextContent("generate.startNoteTitle");
    expect(note).toHaveTextContent("generate.startNoteAsked(generate.startNoteSource.PREVIOUS_YEAR)");
  });

  it("says nothing of lessons that could not be used when the engine that was older was given none of them, though the gateway counted why", async () => {
    // An engine that refused the field after the schedule had been read: the lessons were counted and left out for reasons, and then none was given.
    state.job = finished({
      source: "CURRENT", versionName: null, engine: "OLDER", offered: 40, used: 0, held: null, moved: null, laid: null, dropped: { NO_POST: 5 },
    });
    render(<GeneratePage />);

    const note = await screen.findByTestId("generate-started-from");
    expect(note).toHaveTextContent("generate.startNoteOlder");
    expect(note).not.toHaveTextContent("startNoteDropped");
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
